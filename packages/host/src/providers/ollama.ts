import { AsyncEventQueue, readableToAsyncIterable } from "../util/stream.js";
import { makeProxyDispatcher } from "../util/proxy.js";
import { fromApiToolName, toApiToolName, sanitizeToolChains, chargeStreamContent, StreamContentLimitError, type StreamEvent, type StreamHandle, type StreamRequest, type StreamContentBudget, type Transport } from "./transport.js";
import { readBodyLimited } from "../security/network.js";
import { redactSecrets } from "../security/redact.js";
import { safeParseJson } from "../util/json.js";
export const ollamaTransport: Transport = {
  kind: "ollama",
  async stream(req: StreamRequest): Promise<StreamHandle> {
    const base = (req.provider.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
    const remoteModel = req.model.providers.find((p) => p.id === req.provider.id)?.remoteModel ?? req.model.id;
    const toolNameCache = new Map<string, string>();
    for (const m of req.messages) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const tc of m.toolCalls) {
          toolNameCache.set(tc.id, tc.name);
        }
      }
    }
function stripImagePrefix(url: string): string {
  const m = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  return m ? m[2].replace(/\s+/g, "") : url;
}
    const body: Record<string, unknown> = {
      model: remoteModel,
      stream: true,
      messages: sanitizeToolChains(req.messages).map((m) => {
        if (m.role === "tool") {
          const images = (m as any).images as { image_url: { url: string } }[] | undefined;
          const msg: Record<string, unknown> = { role: "tool", tool_name: toApiToolName(toolNameCache.get(m.toolCallId ?? "") ?? "unknown"), content: m.content };
          if (images?.length) {
            msg.images = images.map((img) => stripImagePrefix(img.image_url.url));
          }
          return msg;
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          const msg: Record<string, unknown> = { role: "assistant" };
          if (m.thinking) msg.thinking = m.thinking;
          msg.content = m.content;
          msg.tool_calls = m.toolCalls.map((t) => ({
            function: { name: toApiToolName(t.name), arguments: t.args },
          }));
          return msg;
        }
        const msg: Record<string, unknown> = { role: m.role };
        if (m.role === "assistant" && m.thinking) msg.thinking = m.thinking;
        msg.content = m.content;
        const images = (m as any).images as { image_url: { url: string } }[] | undefined;
        if (m.role === "user" && images?.length) {
          msg.images = images.map((img) => stripImagePrefix(img.image_url.url));
        }
        return msg;
      }),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: toApiToolName(t.name), description: t.description, parameters: t.parameters },
      }));
    }
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
      ...(req.proxyUrl ? { dispatcher: makeProxyDispatcher(req.proxyUrl) } : {}),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama returned ${res.status}: ${redactSecrets(await readBodyLimited(res), [req.provider.apiKey])}`);
    }
    const q = new AsyncEventQueue<StreamEvent>();
    let aborted = false;
    let buffer = "";
    const contentBudget: StreamContentBudget = { bytes: 0 };
    const parseLine = (raw: string): boolean => {
      const t = raw.trim();
      if (!t) return false;
      try {
        const j = JSON.parse(t);
        if (j.message?.content) {
          chargeStreamContent(contentBudget, j.message.content);
          q.push({ type: "text", delta: j.message.content });
        }
        if (j.message?.thinking) q.push({ type: "thinking", delta: j.message.thinking });
        if (j.message?.tool_calls?.length) {
          for (const tc of j.message.tool_calls) {
            if (tc.function?.name) {
              const args = typeof tc.function.arguments === "string"
                ? safeParseJson<Record<string, unknown>>(tc.function.arguments)
                : tc.function.arguments ?? {};
              q.push({
                type: "tool_call",
                id: String(tc.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
                name: fromApiToolName(tc.function.name),
                args: args ?? {},
              });
            }
          }
        }
        if (j.done) {
          if (j.prompt_eval_count || j.eval_count) {
            q.push({
              type: "usage",
              usage: { prompt: j.prompt_eval_count ?? 0, completion: j.eval_count ?? 0, thinking: 0, cost: 0 },
            });
          }
          q.push({ type: "done" });
          return true;
        }
      } catch (e) {
        if (e instanceof StreamContentLimitError) throw e;
      }
      return false;
    };
    (async () => {
      try {
        for await (const chunk of readableToAsyncIterable(res.body as ReadableStream<Uint8Array>)) {
          if (aborted) break;
          buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          if (buffer.length > 1024 * 1024) throw new Error("Provider stream event exceeded 1 MiB.");
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (parseLine(line)) { q.close(); return; }
          }
        }
        parseLine(buffer);
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