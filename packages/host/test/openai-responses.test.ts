import { describe, it, expect, vi, afterEach } from "vitest";
import { openAICompatibleTransport, toResponsesInput, isFormatMismatch, providerFailure } from "../src/providers/openai-compatible";
import { caps } from "../src/providers/capability-tracker";
import type { StreamEvent, StreamRequest } from "../src/providers/transport";
import type { ChatMessage, ModelDescriptor, ProviderConfig } from "../src/protocol/protocol";
const msg = (id: string, role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, content, ts: 0, ...extra });
function makeReq(providerId: string, messages: ChatMessage[]): StreamRequest {
  const model: ModelDescriptor = { id: "test-model", label: "T", tier: "default", contextWindow: 1000, costPer1mIn: 0, costPer1mOut: 0, providers: [{ id: providerId, kind: "openai-compatible", priority: 0 }] };
  const provider: ProviderConfig = { id: providerId, kind: "openai-compatible", label: "P", enabled: true };
  return { model, provider, messages };
}
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
}
function sseResponse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(streamOf(text), { status: 200, headers: { "content-type": "text/event-stream" } });
}
async function collect(handle: { events: AsyncIterable<StreamEvent> }): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("toResponsesInput", () => {
  it("maps system, user, and assistant text messages", () => {
    const out = toResponsesInput([
      msg("1", "system", "be helpful"),
      msg("2", "user", "hi"),
      msg("3", "assistant", "hello"),
    ]);
    expect(out).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });
  it("converts tool calls to function_call items and tool results to function_call_output keyed by call_id", () => {
    const out = toResponsesInput([
      msg("1", "assistant", "running", { toolCalls: [{ id: "call_1", name: "shell.run", args: { command: "ls" } }] }),
      msg("2", "tool", "file list", { toolCallId: "call_1" }),
    ]);
    expect(out).toEqual([
      { role: "assistant", content: "running" },
      { type: "function_call", call_id: "call_1", name: "shell_drun", arguments: "{\"command\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "file list" },
    ]);
  });
  it("maps user images to input_image parts and drops orphan tool messages", () => {
    const out = toResponsesInput([
      msg("1", "user", "look", { images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }),
      msg("2", "tool", "orphan", { toolCallId: "" }),
    ]);
    expect(out).toEqual([
      { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] },
    ]);
  });
});
describe("isFormatMismatch", () => {
  it("detects endpoint-level failures per format", () => {
    expect(isFormatMismatch("Provider openai returned 404: Not Found", "chat")).toBe(true);
    expect(isFormatMismatch("Provider openai returned 400: Model gpt-5-codex does not support Chat Completions", "chat")).toBe(true);
    expect(isFormatMismatch("Provider openai returned 429: rate limited", "chat")).toBe(false);
    expect(isFormatMismatch("Provider openai returned 400: invalid model id", "chat")).toBe(false);
    expect(isFormatMismatch("Provider openai returned 404: /responses not found", "responses")).toBe(true);
    expect(isFormatMismatch("Provider openai returned 400: This model does not support the Responses API", "responses")).toBe(true);
    expect(isFormatMismatch("Provider openai returned 400: invalid model id", "responses")).toBe(false);
  });
  it("treats a persistent 5xx as a format mismatch for either format, but not rate limits", () => {
    expect(isFormatMismatch('Provider opencode returned 500: {"type":"error","error":{"type":"error","message":"Internal server error"}}', "chat")).toBe(true);
    expect(isFormatMismatch("Provider opencode returned 502: Bad Gateway", "chat")).toBe(true);
    expect(isFormatMismatch("Provider opencode returned 500: boom", "responses")).toBe(true);
    expect(isFormatMismatch("Provider openai returned 429: rate limited", "responses")).toBe(false);
  });
});
describe("responses streaming", () => {
  it("emits text, thinking, tool_call with call_id, and usage with cacheRead", async () => {
    const providerId = `p-stream-${Date.now()}`;
    const fetchMock = vi.fn((_url: string | URL | RequestInfo) => Promise.resolve(sseResponse([
      { type: "response.created" },
      { type: "response.reasoning_summary_text.delta", delta: "pondering" },
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: " world" },
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "shell.run", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"command\"" },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: ":\"ls\"}" },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "shell.run", arguments: "{\"command\":\"ls\"}" } },
      { type: "response.completed", response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20 } } },
    ])));
    vi.stubGlobal("fetch", fetchMock);
    caps.markUnsupported(`${providerId}:test-model`, "chat");
    const req = makeReq(providerId, [msg("1", "user", "do it")]);
    const events = await collect(await openAICompatibleTransport.stream(req));
    expect(fetchMock.mock.calls[0][0]).toContain("/responses");
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("thinking");
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Hello world");
    const toolCall = events.find((e) => e.type === "tool_call") as { id: string; name: string; args: Record<string, unknown> };
    expect(toolCall.id).toBe("call_9");
    expect(toolCall.name).toBe("shell.run");
    expect(toolCall.args).toEqual({ command: "ls" });
    const usage = events.find((e) => e.type === "usage") as { usage: { prompt: number; completion: number; cacheRead?: number } };
    expect(usage.usage.prompt).toBe(100);
    expect(usage.usage.completion).toBe(20);
    expect(usage.usage.cacheRead).toBe(80);
    expect(kinds[kinds.length - 1]).toBe("done");
  });
  it("marks failed responses as stream errors", async () => {
    const providerId = `p-fail-${Date.now()}`;
    const fetchMock = vi.fn((_url: string | URL | RequestInfo) => Promise.resolve(sseResponse([
      { type: "response.failed", response: { error: { message: "boom" } } },
    ])));
    vi.stubGlobal("fetch", fetchMock);
    caps.markUnsupported(`${providerId}:test-model`, "chat");
    const req = makeReq(providerId, [msg("1", "user", "hi")]);
    const events = await collect(await openAICompatibleTransport.stream(req));
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message === "boom")).toBe(true);
  });
  it("falls back from Chat Completions to Responses on endpoint mismatch and remembers the format", async () => {
    const providerId = `p-fallback-${Date.now()}`;
    const urls: string[] = [];
    const fetchMock = vi.fn((url: string | URL | RequestInfo) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/chat/completions")) {
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "Model test-model does not support Chat Completions" } }), { status: 404 }));
      }
      return Promise.resolve(sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      ]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const req = makeReq(providerId, [msg("1", "user", "hi")]);
    const first = await collect(await openAICompatibleTransport.stream(req));
    expect(first.some((e) => e.type === "text")).toBe(true);
    expect(urls.filter((u) => u.includes("/chat/completions")).length).toBe(1);
    expect(urls.some((u) => u.includes("/responses"))).toBe(true);
    const second = await collect(await openAICompatibleTransport.stream(req));
    expect(second.some((e) => e.type === "text")).toBe(true);
    expect(urls.filter((u) => u.includes("/chat/completions")).length).toBe(1);
    expect(urls.filter((u) => u.includes("/responses")).length).toBe(2);
  });
  it("falls back from Chat Completions to Responses on persistent 500 and remembers the format", async () => {
    const providerId = `p-500-fallback-${Date.now()}`;
    const urls: string[] = [];
    const fetchMock = vi.fn((url: string | URL | RequestInfo) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/chat/completions")) {
        return Promise.resolve(new Response(
          JSON.stringify({ type: "error", error: { type: "error", message: "Internal server error" } }),
          { status: 500, headers: { "retry-after": "0" } },
        ));
      }
      return Promise.resolve(sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      ]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const req = makeReq(providerId, [msg("1", "user", "hi")]);
    const first = await collect(await openAICompatibleTransport.stream(req));
    expect(first.some((e) => e.type === "text")).toBe(true);
    const chatCallsAfterFirst = urls.filter((u) => u.includes("/chat/completions")).length;
    expect(chatCallsAfterFirst).toBeGreaterThanOrEqual(1);
    expect(urls.some((u) => u.includes("/responses"))).toBe(true);
    const second = await collect(await openAICompatibleTransport.stream(req));
    expect(second.some((e) => e.type === "text")).toBe(true);
    expect(urls.filter((u) => u.includes("/chat/completions")).length).toBe(chatCallsAfterFirst);
    expect(urls.filter((u) => u.includes("/responses"))).toHaveLength(2);
  });
  it("rejects when both formats persistently fail with 500", async () => {
    const providerId = `p-500-both-${Date.now()}`;
    const fetchMock = vi.fn((_url: string | URL | RequestInfo) =>
      Promise.resolve(new Response(
        JSON.stringify({ type: "error", error: { type: "error", message: "Internal server error" } }),
        { status: 500, headers: { "retry-after": "0" } },
      )));
    vi.stubGlobal("fetch", fetchMock);
    const req = makeReq(providerId, [msg("1", "user", "hi")]);
    await expect(openAICompatibleTransport.stream(req)).rejects.toThrow(/returned 500/);
  });
  it("surfaces a non-mismatch chat failure without probing responses", async () => {
    const providerId = `p-hard-${Date.now()}`;
    const urls: string[] = [];
    const fetchMock = vi.fn((url: string | URL | RequestInfo) => {
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ error: { message: "invalid model id" } }), { status: 400 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const req = makeReq(providerId, [msg("1", "user", "hi")]);
    await expect(openAICompatibleTransport.stream(req)).rejects.toThrow();
    expect(urls.some((u) => u.includes("/responses"))).toBe(false);
  });
});
describe("x-opencode-session header", () => {
  function chatSse(text: string): Response {
    return sseResponse([
      { id: "x", choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
      { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  }
  function reqWith(providerId: string, kind: string, baseUrl: string | undefined, conversationId: string | undefined): StreamRequest {
    const model: ModelDescriptor = { id: "test-model", label: "T", tier: "default", contextWindow: 1000, costPer1mIn: 0, costPer1mOut: 0, providers: [{ id: providerId, kind: kind as ModelDescriptor["providers"][number]["kind"], priority: 0 }] };
    const provider: ProviderConfig = { id: providerId, kind: kind as ProviderConfig["kind"], label: "P", enabled: true, ...(baseUrl ? { baseUrl } : {}) };
    return { model, provider, messages: [msg("1", "user", "hi")], ...(conversationId ? { conversationId } : {}) };
  }
  function headersOf(call: unknown): Record<string, string> {
    const init = (call as [unknown, { headers: Record<string, string> }])[1];
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers)) out[k.toLowerCase()] = v;
    return out;
  }
  it("sends the header on chat completions to the opencode provider", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(chatSse("hi")));
    vi.stubGlobal("fetch", fetchMock);
    const req = reqWith(`p-oc-${Date.now()}`, "opencode", "https://opencode.ai/zen/v1", "conv-1");
    const events = await collect(await openAICompatibleTransport.stream(req));
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain("/chat/completions");
    expect(headersOf(fetchMock.mock.calls[0])["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(headersOf(fetchMock.mock.calls[0])["x-opencode-request"]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(headersOf(fetchMock.mock.calls[0])["user-agent"]).toMatch(/^opencode\/latest\//);
  });
  it("sends the header on the responses path and for custom endpoints pointed at opencode.ai", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(sseResponse([
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
    ])));
    vi.stubGlobal("fetch", fetchMock);
    const providerId = `p-occ-${Date.now()}`;
    caps.markUnsupported(`${providerId}:test-model`, "chat");
    const req = reqWith(providerId, "openai-compatible", "https://opencode.ai/zen/v1", "conv-9");
    const events = await collect(await openAICompatibleTransport.stream(req));
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain("/responses");
    expect(headersOf(fetchMock.mock.calls[0])["x-opencode-session"]).toMatch(/^ses_/);
  });
  it("maps FreeTierError to actionable guidance", async () => {
    const providerId = `p-ft-${Date.now()}`;
    const model: ModelDescriptor = { id: "m", label: "M", tier: "default", contextWindow: 1, costPer1mIn: 0, costPer1mOut: 0, providers: [{ id: providerId, kind: "opencode", priority: 0 }] };
    const provider: ProviderConfig = { id: providerId, kind: "opencode", label: "P", enabled: true };
    const req: StreamRequest = { model, provider, messages: [msg("1", "user", "hi")] };
    const err = providerFailure(req, "https://opencode.ai/zen/v1", 403, `{"type":"error","error":{"type":"FreeTierError"}}`);
    expect(err.message).toContain("backend debugging override");
    const plain = providerFailure(req, "https://opencode.ai/zen/v1", 500, "boom");
    expect(plain.message).toContain("returned 500");
  });
  it("omits the header without a conversation id and for other hosts", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(chatSse("hi")));
    vi.stubGlobal("fetch", fetchMock);
    const noId = reqWith(`p-nid-${Date.now()}`, "opencode", "https://opencode.ai/zen/v1", undefined);
    await collect(await openAICompatibleTransport.stream(noId));
    expect(headersOf(fetchMock.mock.calls[0])["x-opencode-session"]).toBeUndefined();
    const other = reqWith(`p-oth-${Date.now()}`, "openai", "https://api.openai.com/v1", "conv-2");
    await collect(await openAICompatibleTransport.stream(other));
    expect(headersOf(fetchMock.mock.calls[1])["x-opencode-session"]).toBeUndefined();
  });
});