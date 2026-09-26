import { AsyncEventQueue, readableToAsyncIterable } from "../util/stream.js";
import { makeProxyDispatcher } from "../util/proxy.js";
import { fromApiToolName, toApiToolName, sanitizeToolChains, chargeStreamContent, StreamContentLimitError, type StreamEvent, type StreamHandle, type StreamRequest, type StreamContentBudget, type Transport } from "./transport.js";
import { caps } from "./capability-tracker.js";
import { withRetry, policyFor } from "./retry.js";
import { attributionHeaders, opencodeSessionHeader, isOpencodeEndpoint } from "./attribution.js";
import { getCopilotBearerToken, copilotRequestHeaders, isAgentCall, hasImageContent } from "./github-copilot.js";
import { readBodyLimited, normalizeProviderBaseUrl } from "../security/network.js";
import { redactSecrets } from "../security/redact.js";
import { safeParseJson } from "../util/json.js";
import { hostWarn } from "../log/logger.js";
const UNSUPPORTED_PARAM_RE = /does not support|unsupported.*param(?:eter)?|unknown.*param(?:eter)?|invalid.*param(?:eter)?/i;
const ENDPOINT_MISSING_RE = /returned 40[45]\b|no such endpoint|unknown endpoint|unsupported endpoint|invalid url|invalid path|cannot (?:post|resolve)/i;
const CHAT_REJECTED_RE = /does not support (?:the )?chat|chat.?completions (?:is )?not support|only supports? (?:the )?responses/i;
const RESPONSES_REJECTED_RE = /does not support (?:the )?responses|responses(?: api)? (?:is )?not support|only supports? (?:the )?chat/i;
const PERSISTENT_5XX_RE = /returned 5\d\d:/;
export function providerFailure(req: StreamRequest, base: string, status: number, body: string): Error {
  if (status === 403 && body.includes("FreeTierError") && isOpencodeEndpoint(base, req.provider.kind)) {
    return new Error(`OpenCode rejected this request. Use a paid model, or enable the backend debugging override in Settings > About > Experimental. Upstream: ${redactSecrets(body, [req.provider.apiKey])}`);
  }
  return new Error(`Provider ${req.provider.kind} returned ${status}: ${redactSecrets(body, [req.provider.apiKey])}`);
}
export type OpenAiApiFormat = "chat" | "responses";
export function isFormatMismatch(errorMessage: string, fmt: OpenAiApiFormat): boolean {
  if (PERSISTENT_5XX_RE.test(errorMessage)) return true;
  if (ENDPOINT_MISSING_RE.test(errorMessage)) return true;
  return fmt === "chat" ? CHAT_REJECTED_RE.test(errorMessage) : RESPONSES_REJECTED_RE.test(errorMessage);
}
export const openAICompatibleTransport: Transport & { withBase: (base: string) => Transport } = {
  kind: "openai",
  withBase(base) {
    return { kind: this.kind, stream: (req) => streamWithBase(req, base) };
  },
  stream(req) {
    return streamWithBase(req, "");
  },
};
async function streamWithBase(req: StreamRequest, baseOverride: string): Promise<StreamHandle> {
  const base = normalizeProviderBaseUrl(baseOverride || req.provider.baseUrl || "https://api.openai.com/v1");
  const remoteModel = req.model.providers.find((p) => p.id === req.provider.id)?.remoteModel ?? req.model.id;
  const modelKey = `${req.provider.id}:${remoteModel}`;
  const first: OpenAiApiFormat = caps.isSupported(modelKey, "chat") ? "chat" : "responses";
  const attempts: OpenAiApiFormat[] = [first, first === "chat" ? "responses" : "chat"];
  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const fmt = attempts[i];
    try {
      return fmt === "chat" ? await streamChatCompletions(req, base, modelKey) : await streamResponses(req, base, modelKey);
    } catch (e) {
      lastErr = e;
      const msg = (e as Error)?.message ?? String(e);
      if ((e as Error)?.name === "AbortError" || i === attempts.length - 1 || !isFormatMismatch(msg, fmt)) throw e;
      caps.markUnsupported(modelKey, fmt);
      hostWarn(`[arc] ${modelKey}: ${fmt === "chat" ? "Chat Completions" : "Responses"} API rejected the request; retrying with the ${fmt === "chat" ? "Responses" : "Chat Completions"} API`);
    }
  }
  throw lastErr;
}
async function streamChatCompletions(req: StreamRequest, base: string, modelKey: string): Promise<StreamHandle> {
  const remoteModel = req.model.providers.find((p) => p.id === req.provider.id)?.remoteModel ?? req.model.id;
  const hasThinking = req.messages.some((m) => m.role === "assistant" && m.thinking);
  const effortLevels: Record<string, string> = { none: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };
  const eff = req.reasoningEffort ? effortLevels[req.reasoningEffort] : undefined;
  let skipStreamOptions = false;
  let skipTemperature = false;
  const buildBody = (skipReasoning: boolean): Record<string, unknown> => {
    const wantsThink = hasThinking && !skipReasoning && caps.isSupported(modelKey, "thinking");
    const wantsEffort = !skipReasoning && eff && caps.isSupported(modelKey, "reasoning_effort");
    const useStreamOptions = !skipStreamOptions && caps.isSupported(modelKey, "stream_options");
    const omitTemperature = skipTemperature || (req.temperature === undefined && (!!eff || hasThinking));
    const body: Record<string, unknown> = {
      model: remoteModel,
      stream: true,
      ...(omitTemperature ? {} : { temperature: req.temperature ?? 0.2 }),
      messages: sanitizeToolChains(req.messages).map((m) => toOpenAIMessage(m, wantsThink, req.provider.kind)),
    };
    if (useStreamOptions) body.stream_options = { include_usage: true };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: toApiToolName(t.name), description: t.description, parameters: t.parameters },
      }));
    }
    if (req.provider.kind === "openrouter" && (wantsEffort || wantsThink)) {
      body.reasoning = {
        ...(wantsEffort && eff ? { effort: eff } : {}),
        enabled: true,
        exclude: false,
      };
    } else if (wantsEffort) {
      if (req.provider.kind === "google") {
        body.thinking_level = eff;
      } else {
        body.reasoning_effort = eff;
      }
      body.thinking = { type: "enabled" };
    } else if (wantsThink) {
      body.reasoning_effort = "high";
      body.thinking = { type: "enabled" };
    }
    return body;
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (req.provider.apiKey) headers.authorization = `Bearer ${req.provider.apiKey}`;
  Object.assign(headers, attributionHeaders(req.provider.kind));
  if (req.provider.kind === "github-copilot") {
    const bearer = await getCopilotBearerToken(req.provider.apiKey, { proxyUrl: req.proxyUrl });
    headers.authorization = `Bearer ${bearer}`;
    Object.assign(
      headers,
      copilotRequestHeaders({ vision: hasImageContent(req.messages), agentCall: isAgentCall(req.messages) }),
    );
  }
  Object.assign(headers, opencodeSessionHeader(base, req.provider.kind, req.conversationId, undefined, req.workspaceRoot));
  const MAX_ATTEMPTS = 3;
  const policy = policyFor(req.provider.kind);
  let res!: Response;
  let lastText = "";
  let skipReasoning = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const body = buildBody(skipReasoning);
    res = await withRetry(
      () => fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
        ...(req.proxyUrl ? { dispatcher: makeProxyDispatcher(req.proxyUrl) } : {}),
      }),
      policy,
    );
    if (!res.ok) lastText = await readBodyLimited(res).catch((error) => (error as Error).message);
    if (res.ok && res.body) break;
    if (res.status === 400 && !skipStreamOptions && /stream_options/i.test(lastText)) {
      caps.markUnsupported(modelKey, "stream_options");
      skipStreamOptions = true;
      continue;
    }
    if (res.status === 400 && UNSUPPORTED_PARAM_RE.test(lastText)) {
      if (!skipTemperature && /temperature/i.test(lastText)) {
        skipTemperature = true;
        continue;
      }
      if (eff && lastText.includes("reasoning_effort")) {
        caps.markUnsupported(modelKey, "reasoning_effort");
        skipReasoning = true;
        continue;
      }
      if (lastText.includes("thinking_level")) {
        caps.markUnsupported(modelKey, "reasoning_effort");
        skipReasoning = true;
        continue;
      }
      caps.markUnsupported(modelKey, "thinking");
      skipReasoning = true;
      continue;
    }
    if (!res.ok) throw providerFailure(req, base, res.status, lastText);
  }
  if (!res!.ok || !res!.body) {
    throw providerFailure(req, base, res!.status, lastText);
  }
  const q = new AsyncEventQueue<StreamEvent>();
  let aborted = false;
  let lastUsage: import("../protocol/protocol.js").TurnUsage | undefined;
  const parseUsage = (u: Record<string, unknown>): import("../protocol/protocol.js").TurnUsage => {
    const details = (u.prompt_tokens_details ?? null) as { cached_tokens?: number } | null;
    const cached = typeof details?.cached_tokens === "number" && details.cached_tokens > 0 ? details.cached_tokens : undefined;
    return {
      prompt: (u.prompt_tokens as number | undefined) ?? 0,
      completion: (u.completion_tokens as number | undefined) ?? 0,
      thinking: 0,
      cost: 0,
      ...(cached !== undefined ? { cacheRead: cached } : {}),
    };
  };
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  const flushToolCalls = () => {
    for (const entry of toolAcc.values()) {
      if (!entry.name) continue;
      q.push({
        type: "tool_call",
        id: entry.id,
        name: fromApiToolName(entry.name),
        args: safeParseJson<Record<string, unknown>>(entry.args) ?? {},
      });
    }
    toolAcc.clear();
  };
  void (async () => {
    let buffer = "";
    const contentBudget: StreamContentBudget = { bytes: 0 };
    let inThink = false;
    let thinkingBuf = "";
    const reasoningDetailTextById = new Map<string, string>();
    try {
      for await (const chunk of readableToAsyncIterable(res.body as ReadableStream<Uint8Array>)) {
        if (aborted) break;
        buffer += chunk;
        if (buffer.length > 1024 * 1024) throw new Error("Provider stream event exceeded 1 MiB.");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          if (line.startsWith(":")) { q.push({ type: "ping" }); continue; }
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            flushToolCalls();
            if (lastUsage) { q.push({ type: "usage", usage: lastUsage }); lastUsage = undefined; }
            q.push({ type: "done" });
            q.close();
            return;
          }
          try {
            const json = JSON.parse(payload);
            const choice = json.choices?.[0];
            if (!choice) {
              if (json.usage) {
                lastUsage = parseUsage(json.usage);
              } else {
                q.push({ type: "ping" });
              }
              continue;
            }
            const delta = choice.delta ?? {};
            const emitReasoningFromDetails = (): string => {
              if (!Array.isArray(delta.reasoning_details)) return "";
              let out = "";
              for (let i = 0; i < delta.reasoning_details.length; i++) {
                const d = delta.reasoning_details[i];
                if (typeof d === "string") {
                  out += d;
                  continue;
                }
                const text = typeof d?.text === "string"
                  ? d.text
                  : typeof d?.reasoning === "string"
                    ? d.reasoning
                    : "";
                if (!text) continue;
                const baseId = typeof d?.id === "string" && d.id
                  ? d.id
                  : `${d?.index ?? i}`;
                const id = baseId;
                const prev = reasoningDetailTextById.get(id) ?? "";
                let deltaText = text;
                if (prev && text.startsWith(prev)) {
                  deltaText = text.slice(prev.length);
                } else if (prev && prev.startsWith(text)) {
                  deltaText = "";
                }
                reasoningDetailTextById.set(id, text);
                if (deltaText) out += deltaText;
              }
              return out;
            };
            const detailsThinking = emitReasoningFromDetails();
            const contentThinking = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
            const plainThinking = typeof delta.reasoning === "string" ? delta.reasoning : "";
            const structuredThinking = detailsThinking || contentThinking || plainThinking;
            if (structuredThinking) q.push({ type: "thinking", delta: structuredThinking });
            if (delta.content) {
              const text = delta.content as string;
              let s = text;
              while (s) {
                if (inThink) {
                  const ei = s.indexOf("</think>");
                  if (ei >= 0) {
                    thinkingBuf += s.slice(0, ei);
                    const trimmed = thinkingBuf.trim();
                    if (trimmed && !structuredThinking) q.push({ type: "thinking", delta: trimmed });
                    thinkingBuf = "";
                    s = s.slice(ei + 8).trimStart();
                    inThink = false;
                  } else {
                    thinkingBuf += s;
                    s = "";
                  }
                } else {
                  const si = s.indexOf("<think>");
                  if (si >= 0) {
                    if (si > 0) {
                      chargeStreamContent(contentBudget, s.slice(0, si));
                      q.push({ type: "text", delta: s.slice(0, si) });
                    }
                    s = s.slice(si + 7).trimStart();
                    inThink = true;
                  } else {
                    chargeStreamContent(contentBudget, s);
                    q.push({ type: "text", delta: s });
                    s = "";
                  }
                }
              }
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const key = typeof tc.index === "number" ? tc.index : 0;
                let entry = toolAcc.get(key);
                if (!entry) { entry = { id: tc.id ?? `call_${key}`, name: "", args: "" }; toolAcc.set(key, entry); }
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;
                if (typeof tc.function?.arguments === "string") entry.args += tc.function.arguments;
                if (entry.name) {
                  q.push({ type: "tool_call_delta", id: entry.id, name: fromApiToolName(entry.name), argsDelta: tc.function?.arguments ?? "" });
                }
              }
              q.push({ type: "ping" });
            }
            if (choice.finish_reason === "tool_calls") flushToolCalls();
            if (json.usage) {
              lastUsage = parseUsage(json.usage);
            }
          } catch (e) {
            if (e instanceof StreamContentLimitError) throw e;
          }
        }
      }
    } catch (e) {
      if (!aborted) q.push({ type: "error", message: (e as Error).message });
    } finally {
      if (!aborted) {
        flushToolCalls();
        if (lastUsage) q.push({ type: "usage", usage: lastUsage });
      }
      q.close();
    }
  })();
  return {
    events: q,
    abort: () => {
      aborted = true;
      q.close();
    },
  };
}
function toOpenAIMessage(m: import("../protocol/protocol.js").ChatMessage, supportsThinking: boolean, providerKind?: import("../protocol/protocol.js").ProviderKind) {
  if (m.role === "tool") {
    const images = (m as any).images as { type: string; image_url: { url: string } }[] | undefined;
    const toolCallId = (m.toolCallId ?? "").trim();
    if (!toolCallId) {
      const content = providerKind === "openrouter"
        ? `Tool output (without tool_call_id):\n${m.content}`
        : m.content;
      return images?.length
        ? { role: "user", content: [{ type: "text", text: content }, ...images.map((img) => ({ type: "image_url", image_url: img.image_url }))] }
        : { role: "user", content };
    }
    return images?.length
      ? { role: "tool", tool_call_id: toolCallId, content: [{ type: "text", text: m.content }, ...images.map((img) => ({ type: "image_url", image_url: img.image_url }))] }
      : { role: "tool", tool_call_id: toolCallId, content: m.content };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    const msg: Record<string, unknown> = { role: "assistant" };
    if (supportsThinking && m.thinking) msg.reasoning_content = m.thinking;
    msg.content = m.content;
    msg.tool_calls = m.toolCalls.map((t) => ({
      id: t.id,
      type: "function",
      function: { name: toApiToolName(t.name), arguments: JSON.stringify(t.args) },
    }));
    return msg;
  }
  if (m.role === "assistant" && m.thinking) {
    if (supportsThinking) return { role: "assistant", reasoning_content: m.thinking, content: m.content };
    return { role: "assistant", content: m.content };
  }
  const images = (m as any).images as { type: string; image_url: { url: string } }[] | undefined;
  if (m.role === "user" && images?.length) {
    return {
      role: m.role,
      content: [
        { type: "text", text: m.content },
        ...images.map((img) => ({ type: "image_url", image_url: img.image_url })),
      ],
    };
  }
  return { role: m.role, content: m.content };
}
export function toResponsesInput(messages: import("../protocol/protocol.js").ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of sanitizeToolChains(messages)) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
      continue;
    }
    if (m.role === "tool") {
      const callId = (m.toolCallId ?? "").trim();
      if (!callId) continue;
      out.push({ type: "function_call_output", call_id: callId, output: m.content });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      if (m.content) out.push({ role: "assistant", content: m.content });
      for (const t of m.toolCalls) {
        out.push({ type: "function_call", call_id: t.id, name: toApiToolName(t.name), arguments: JSON.stringify(t.args) });
      }
      continue;
    }
    const images = (m as any).images as { type: string; image_url: { url: string } }[] | undefined;
    if (m.role === "user" && images?.length) {
      out.push({
        role: "user",
        content: [
          { type: "input_text", text: m.content },
          ...images.map((img) => ({ type: "input_image", image_url: img.image_url.url })),
        ],
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
function buildResponsesBody(req: StreamRequest, remoteModel: string, eff: string | undefined, skipReasoning: boolean, skipStore: boolean): { body: Record<string, unknown>; sentReasoning: boolean; sentStore: boolean } {
  const sentReasoning = !skipReasoning && !!eff;
  const sentStore = !skipStore;
  const body: Record<string, unknown> = {
    model: remoteModel,
    input: toResponsesInput(req.messages),
    stream: true,
  };
  if (sentStore) body.store = false;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: toApiToolName(t.name),
      description: t.description,
      parameters: t.parameters,
    }));
  }
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (sentReasoning) body.reasoning = { effort: eff, summary: "auto" };
  return { body, sentReasoning, sentStore };
}
async function streamResponses(req: StreamRequest, base: string, modelKey: string): Promise<StreamHandle> {
  const remoteModel = req.model.providers.find((p) => p.id === req.provider.id)?.remoteModel ?? req.model.id;
  const effortLevels: Record<string, string> = { none: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };
  const eff = req.reasoningEffort ? effortLevels[req.reasoningEffort] : undefined;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (req.provider.apiKey) headers.authorization = `Bearer ${req.provider.apiKey}`;
  Object.assign(headers, attributionHeaders(req.provider.kind));
  if (req.provider.kind === "github-copilot") {
    const bearer = await getCopilotBearerToken(req.provider.apiKey, { proxyUrl: req.proxyUrl });
    headers.authorization = `Bearer ${bearer}`;
    Object.assign(
      headers,
      copilotRequestHeaders({ vision: hasImageContent(req.messages), agentCall: isAgentCall(req.messages) }),
    );
  }
  Object.assign(headers, opencodeSessionHeader(base, req.provider.kind, req.conversationId, undefined, req.workspaceRoot));
  const MAX_ATTEMPTS = 2;
  const policy = policyFor(req.provider.kind);
  let res!: Response;
  let lastText = "";
  let skipReasoning = false;
  let skipStore = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { body, sentReasoning, sentStore: storeSent } = buildResponsesBody(req, remoteModel, eff, skipReasoning, skipStore);
    res = await withRetry(
      () => fetch(`${base.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
        ...(req.proxyUrl ? { dispatcher: makeProxyDispatcher(req.proxyUrl) } : {}),
      }),
      policy,
    );
    if (!res.ok) lastText = await readBodyLimited(res).catch((error) => (error as Error).message);
    if (res.ok && res.body) break;
    if (res.status === 400 && UNSUPPORTED_PARAM_RE.test(lastText)) {
      if (storeSent && /\bstore\b/i.test(lastText)) {
        caps.markUnsupported(modelKey, "store");
        skipStore = true;
        continue;
      }
      if (sentReasoning && /reasoning/i.test(lastText)) {
        caps.markUnsupported(modelKey, "reasoning_effort");
        skipReasoning = true;
        continue;
      }
    }
    if (!res.ok) throw providerFailure(req, base, res.status, lastText);
  }
  if (!res!.ok || !res!.body) {
    throw providerFailure(req, base, res!.status, lastText);
  }
  const q = new AsyncEventQueue<StreamEvent>();
  let aborted = false;
  void (async () => {
    let buffer = "";
    const contentBudget: StreamContentBudget = { bytes: 0 };
    const toolAcc = new Map<string, { callId: string; name: string; args: string }>();
    let lastUsage: import("../protocol/protocol.js").TurnUsage | undefined;
    const flushUsage = () => {
      if (lastUsage) { q.push({ type: "usage", usage: lastUsage }); lastUsage = undefined; }
    };
    try {
      for await (const chunk of readableToAsyncIterable(res.body as ReadableStream<Uint8Array>)) {
        if (aborted) break;
        buffer += chunk;
        if (buffer.length > 1024 * 1024) throw new Error("Provider stream event exceeded 1 MiB.");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          if (line.startsWith(":")) { q.push({ type: "ping" }); continue; }
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            for (const entry of toolAcc.values()) {
              if (!entry.name) continue;
              q.push({ type: "tool_call", id: entry.callId, name: fromApiToolName(entry.name), args: safeParseJson<Record<string, unknown>>(entry.args) ?? {} });
            }
            toolAcc.clear();
            flushUsage();
            q.push({ type: "done" });
            q.close();
            return;
          }
          try {
            const j = JSON.parse(payload) as {
              type?: string;
              delta?: string;
              item_id?: string;
              item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
              response?: { usage?: Record<string, unknown>; error?: { message?: string }; incomplete_details?: { reason?: string } };
              message?: string;
              error?: { message?: string } | string;
            };
            switch (j.type) {
              case "response.output_text.delta":
              case "response.refusal.delta": {
                if (j.delta) {
                  chargeStreamContent(contentBudget, j.delta);
                  q.push({ type: "text", delta: j.delta });
                }
                break;
              }
              case "response.reasoning_summary_text.delta":
              case "response.reasoning_text.delta": {
                if (j.delta) q.push({ type: "thinking", delta: j.delta });
                break;
              }
              case "response.output_item.added": {
                if (j.item?.type === "function_call") {
                  const itemId = j.item.id ?? j.item.call_id ?? "";
                  const callId = j.item.call_id ?? j.item.id ?? "";
                  toolAcc.set(itemId, { callId, name: j.item.name ?? "", args: j.item.arguments ?? "" });
                  if (j.item.name) q.push({ type: "tool_call_delta", id: callId, name: fromApiToolName(j.item.name), argsDelta: "" });
                }
                break;
              }
              case "response.function_call_arguments.delta": {
                const entry = j.item_id ? toolAcc.get(j.item_id) : undefined;
                if (entry && j.delta) {
                  entry.args += j.delta;
                  q.push({ type: "tool_call_delta", id: entry.callId, name: fromApiToolName(entry.name), argsDelta: j.delta });
                }
                break;
              }
              case "response.output_item.done": {
                if (j.item?.type === "function_call") {
                  const itemId = j.item.id ?? j.item.call_id ?? "";
                  const acc = toolAcc.get(itemId);
                  toolAcc.delete(itemId);
                  const argsText = j.item.arguments ?? acc?.args ?? "";
                  q.push({
                    type: "tool_call",
                    id: j.item.call_id ?? j.item.id ?? acc?.callId ?? "",
                    name: fromApiToolName(j.item.name ?? acc?.name ?? "tool"),
                    args: safeParseJson<Record<string, unknown>>(argsText) ?? {},
                  });
                }
                break;
              }
              case "response.completed":
              case "response.incomplete": {
                const u = (j.response?.usage ?? {}) as Record<string, unknown>;
                const inDetails = (u.input_tokens_details ?? null) as { cached_tokens?: number } | null;
                const cached = typeof inDetails?.cached_tokens === "number" && inDetails.cached_tokens > 0 ? inDetails.cached_tokens : undefined;
                lastUsage = {
                  prompt: (u.input_tokens as number | undefined) ?? 0,
                  completion: (u.output_tokens as number | undefined) ?? 0,
                  thinking: 0,
                  cost: 0,
                  ...(cached !== undefined ? { cacheRead: cached } : {}),
                };
                break;
              }
              case "response.failed": {
                q.push({ type: "error", message: j.response?.error?.message ?? "Responses API request failed" });
                q.close();
                return;
              }
              case "error": {
                const msg = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? "Responses API error";
                q.push({ type: "error", message: msg });
                q.close();
                return;
              }
            }
          } catch (e) {
            if (e instanceof StreamContentLimitError) throw e;
          }
        }
      }
    } catch (e) {
      if (!aborted) q.push({ type: "error", message: (e as Error).message });
    } finally {
      if (!aborted) {
        for (const entry of toolAcc.values()) {
          if (!entry.name) continue;
          q.push({ type: "tool_call", id: entry.callId, name: fromApiToolName(entry.name), args: safeParseJson<Record<string, unknown>>(entry.args) ?? {} });
        }
        flushUsage();
      }
      q.close();
    }
  })();
  return {
    events: q,
    abort: () => {
      aborted = true;
      q.close();
    },
  };
}