import { AsyncEventQueue, readableToAsyncIterable } from "../util/stream.js";
import { makeProxyDispatcher } from "../util/proxy.js";
import { fromApiToolName, toApiToolName, sanitizeToolChains, chargeStreamContent, StreamContentLimitError, type StreamEvent, type StreamHandle, type StreamRequest, type StreamContentBudget, type Transport } from "./transport.js";
import { withRetry, policyFor } from "./retry.js";
import { attributionHeaders, opencodeSessionHeader } from "./attribution.js";
import { readBodyLimited } from "../security/network.js";
import { redactSecrets } from "../security/redact.js";
import { hostLog } from "../log/logger.js";
const ANTHROPIC_EFFORT: Record<string, string | undefined> = {
  none: undefined,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};
type ContentBlock = Record<string, unknown>;
const ENV_SPLIT_MARKER = "\n\n---\n\n## Environment\n";
function splitSystemForCache(system: string): ContentBlock[] {
  const idx = system.lastIndexOf(ENV_SPLIT_MARKER);
  if (idx <= 0) {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  const staticPart = system.slice(0, idx);
  const volatilePart = system.slice(idx);
  return [
    { type: "text", text: staticPart, cache_control: { type: "ephemeral" } },
    { type: "text", text: volatilePart },
  ];
}
function markCacheControl(content: unknown): unknown {
  if (typeof content === "string") {
    return [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
  }
  if (Array.isArray(content) && content.length > 0) {
    const copy = content.slice();
    copy[copy.length - 1] = { ...(copy[copy.length - 1] as ContentBlock), cache_control: { type: "ephemeral" } };
    return copy;
  }
  return content;
}
export function applyPromptCaching(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  if (Array.isArray(out.tools) && out.tools.length > 0) {
    const tools = (out.tools as ContentBlock[]).slice();
    tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
    out.tools = tools;
  }
  if (typeof out.system === "string" && out.system) {
    out.system = splitSystemForCache(out.system);
  }
  if (Array.isArray(out.messages) && out.messages.length > 1) {
    const messages = (out.messages as { role: string; content: unknown }[]).slice();
    let cutIdx = -1;
    for (let i = messages.length - 2; i >= 0; i--) {
      if (messages[i].role !== "tool") {
        cutIdx = i;
        break;
      }
    }
    if (cutIdx >= 0) {
      messages[cutIdx] = { ...messages[cutIdx], content: markCacheControl(messages[cutIdx].content) };
      out.messages = messages;
    }
  }
  return out;
}
export const anthropicTransport: Transport = {
  kind: "anthropic",
  async stream(req: StreamRequest): Promise<StreamHandle> {
    const base = (req.provider.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
    const remoteModel = req.model.providers.find((p) => p.id === req.provider.id)?.remoteModel ?? req.model.id;
    const systemMsgs = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const conv = sanitizeToolChains(req.messages).filter((m) => m.role !== "system").map((m) => {
      if (m.role === "tool") {
        const content: unknown[] = [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }];
        const images = (m as any).images as { image_url: { url: string } }[] | undefined;
        if (images?.length) {
          for (const img of images) {
            const match = img.image_url.url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
            if (match) content.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2].replace(/\s+/g, "") } });
          }
        }
        return { role: "user" as const, content };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant" as const,
          content: [
            ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
            ...m.toolCalls.map((t) => ({ type: "tool_use" as const, id: t.id, name: toApiToolName(t.name), input: t.args })),
          ],
        };
      }
      if (m.role === "user") {
        const images = (m as { images?: { image_url: { url: string } }[] }).images;
        if (images?.length) {
          const parts: unknown[] = [{ type: "text", text: m.content }];
          for (const img of images) {
            const match = img.image_url.url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
            if (match) {
              parts.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2].replace(/\s+/g, "") } });
            }
          }
          return { role: "user" as const, content: parts };
        }
      }
      return { role: m.role as "user" | "assistant", content: m.content };
    });
    const body: Record<string, unknown> = {
      model: remoteModel,
      max_tokens: req.maxTokens ?? 4096,
      messages: conv,
      stream: true,
    };
    if (systemMsgs) body.system = systemMsgs;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: toApiToolName(t.name),
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    if (req.reasoningEffort) {
      const anthropicEff = ANTHROPIC_EFFORT[req.reasoningEffort];
      if (anthropicEff) {
        body.output_config = { effort: anthropicEff };
      } else {
        body.thinking = { type: "disabled" };
      }
    }
    const cachedBody = applyPromptCaching(body);
    const res = await withRetry(
      () => fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": req.provider.apiKey ?? "",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          "anthropic-dangerous-direct-browser-access": "true",
          ...attributionHeaders(req.provider.kind),
          ...opencodeSessionHeader(base, req.provider.kind, req.conversationId, undefined, req.workspaceRoot),
        },
        body: JSON.stringify(cachedBody),
        signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
        ...(req.proxyUrl ? { dispatcher: makeProxyDispatcher(req.proxyUrl) } : {}),
      }),
      policyFor(req.provider.kind),
    );
    if (!res.ok || !res.body) {
      const text = await readBodyLimited(res).catch((error) => (error as Error).message);
      throw new Error(`Anthropic returned ${res.status}: ${redactSecrets(text, [req.provider.apiKey])}`);
    }
    const q = new AsyncEventQueue<StreamEvent>();
    let aborted = false;
    void (async () => {
      let buffer = "";
      const contentBudget: StreamContentBudget = { bytes: 0 };
      let usage: { input: number; cacheWrite: number; cacheRead: number; output: number } | undefined;
      const emitUsage = () => {
        if (!usage) return;
        q.push({
          type: "usage",
          usage: {
            prompt: usage.input + usage.cacheWrite + usage.cacheRead,
            completion: usage.output,
            thinking: 0,
            cost: 0,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
        });
        usage = undefined;
      };
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
      try {
        for await (const chunk of readableToAsyncIterable(res.body as ReadableStream<Uint8Array>)) {
          if (aborted) break;
          buffer += chunk;
          if (buffer.length > 1024 * 1024) throw new Error("Provider stream event exceeded 1 MiB.");
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload) as {
                type: string;
                index?: number;
                delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
                usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
                content_block?: { type: string; name?: string; id?: string };
                message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } };
              };
              const takeUsage = (u: NonNullable<NonNullable<typeof j.message>["usage"]> | NonNullable<typeof j.usage>) => {
                usage = usage ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
                if (typeof u.input_tokens === "number") usage.input = u.input_tokens;
                if (typeof u.output_tokens === "number") usage.output = u.output_tokens;
                if (typeof u.cache_creation_input_tokens === "number") usage.cacheWrite = u.cache_creation_input_tokens;
                if (typeof u.cache_read_input_tokens === "number") usage.cacheRead = u.cache_read_input_tokens;
              };
              if (j.type === "content_block_start" && j.content_block) {
                if (j.content_block.type === "tool_use" && typeof j.index === "number") {
                  toolBlocks.set(j.index, {
                    id: j.content_block.id ?? `tc-${j.index}-${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`,
                    name: j.content_block.name ?? "tool",
                    json: "",
                  });
                  q.push({ type: "tool_call_delta", id: toolBlocks.get(j.index)!.id, name: fromApiToolName(j.content_block.name ?? "tool"), argsDelta: "" });
                }
              } else if (j.type === "content_block_delta" && j.delta) {
                if (j.delta.type === "text_delta" && j.delta.text) {
                  chargeStreamContent(contentBudget, j.delta.text);
                  q.push({ type: "text", delta: j.delta.text });
                } else if (j.delta.type === "thinking_delta" && j.delta.thinking) {
                  q.push({ type: "thinking", delta: j.delta.thinking });
                } else if (j.delta.type === "input_json_delta" && typeof j.index === "number" && typeof j.delta.partial_json === "string") {
                  const blk = toolBlocks.get(j.index);
                  if (blk) {
                    blk.json += j.delta.partial_json;
                    q.push({ type: "tool_call_delta", id: blk.id, name: fromApiToolName(blk.name), argsDelta: j.delta.partial_json });
                  }
                }
              } else if (j.type === "content_block_stop" && typeof j.index === "number") {
                const blk = toolBlocks.get(j.index);
                if (blk) {
                  let args: Record<string, unknown> = {};
try { args = blk.json ? JSON.parse(blk.json) : {}; } catch { hostLog(`Anthropic stream: failed to parse tool args JSON: ${blk.json?.slice(0, 200)}`); }
                  q.push({ type: "tool_call", id: blk.id, name: fromApiToolName(blk.name), args });
                  toolBlocks.delete(j.index);
                }
              } else if (j.type === "message_start" && j.message?.usage) {
                takeUsage(j.message.usage);
              } else if (j.type === "message_delta") {
                if (j.usage) takeUsage(j.usage);
                emitUsage();
              } else if (j.type === "message_stop") {
                q.push({ type: "done" });
                q.close();
                return;
              }
} catch (e) {
  if (e instanceof StreamContentLimitError) throw e;
  hostLog(`Anthropic stream: failed to parse event: ${payload.slice(0, 200)}`);
}
          }
        }
      } catch (e) {
        if (!aborted) q.push({ type: "error", message: (e as Error).message });
      } finally {
        q.close();
      }
    })();
  return {
    events: q,
    abort: () => { aborted = true; q.close(); },
  };
  },
};