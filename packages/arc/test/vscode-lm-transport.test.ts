import { describe, it, expect, vi, beforeEach } from "vitest";
const store = vi.hoisted(() => ({
  models: [] as any[],
  sent: [] as { messages: any[]; options: any }[],
  sendImpl: undefined as undefined | ((messages: any[], options: any) => any),
  modelListeners: [] as (() => void)[],
  noDataPart: false,
}));
vi.mock("vscode", () => {
  class LanguageModelTextPart {
    constructor(public value: string) {}
  }
  class LanguageModelToolCallPart {
    constructor(
      public callId: string,
      public name: string,
      public input: object,
    ) {}
  }
  class LanguageModelToolResultPart {
    constructor(
      public callId: string,
      public content: unknown[],
    ) {}
  }
  class LanguageModelDataPartImpl {
    static image(data: unknown, mime: string) {
      return { kind: "image-data", data, mime };
    }
  }
  const LanguageModelChatMessage = {
    User: (content: unknown) => ({ role: 1, content }),
    Assistant: (content: unknown) => ({ role: 2, content }),
  };
  const mocked: Record<string, any> = {
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelChatMessage,
    get LanguageModelDataPart() {
      return store.noDataPart ? undefined : LanguageModelDataPartImpl;
    },
    CancellationTokenSource: class {
      token = {};
      cancel = vi.fn();
      dispose = vi.fn();
    },
    lm: {
      selectChatModels: vi.fn(() => Promise.resolve(store.models)),
      onDidChangeChatModels: vi.fn((listener: () => void) => {
        store.modelListeners.push(listener);
        return { dispose: vi.fn() };
      }),
    },
  };
  return mocked;
});
vi.mock("@arc/host", async () => {
  const lm = await import("../../host/src/providers/vscode-lm.ts");
  const t = await import("../../host/src/providers/transport.ts");
  return {
    chargeStreamContent: t.chargeStreamContent,
    fromApiToolName: t.fromApiToolName,
    toApiToolName: t.toApiToolName,
    toVscodeLmMessages: lm.toVscodeLmMessages,
    toVscodeLmTools: lm.toVscodeLmTools,
    selectorForVscodeLm: lm.selectorForVscodeLm,
    findVscodeLmModel: lm.findVscodeLmModel,
    classifyVscodeLmError: lm.classifyVscodeLmError,
    VSCODE_LM_JUSTIFICATION: lm.VSCODE_LM_JUSTIFICATION,
  };
});
import { createVscodeLmTransport, listVscodeLmModels, getVscodeLmVisionSupport } from "../src/extension/vscode-lm-transport.ts";
import type { ModelDescriptor, ProviderConfig, StreamEvent } from "@arc/host";
function fakeModel(overrides: Record<string, any> = {}) {
  return {
    id: "copilot/gpt-4o",
    name: "GPT-4o",
    vendor: "copilot",
    family: "gpt-4o",
    maxInputTokens: 64000,
    capabilities: { imageInput: true, toolCalling: true },
    countTokens: vi.fn(async () => 7),
    sendRequest: vi.fn(async (messages: any[], options: any) => {
      store.sent.push({ messages, options });
      if (store.sendImpl) return store.sendImpl(messages, options);
      const { LanguageModelTextPart } = await import("vscode");
      return {
        stream: (async function* () {
          yield new (LanguageModelTextPart as any)("hello ");
          yield new (LanguageModelTextPart as any)("world");
        })(),
      };
    }),
    ...overrides,
  };
}
function req(modelId = "m1", remoteModel = "copilot/gpt-4o", messages: any[] = [{ id: "u1", role: "user", content: "hi", ts: 1 }], tools?: any): any {
  const model = {
    id: modelId,
    label: "Test",
    tier: "default",
    contextWindow: 64000,
    costPer1mIn: 0,
    costPer1mOut: 0,
    providers: [{ id: "p1", kind: "vscode-lm", remoteModel, priority: 0 }],
  } as ModelDescriptor;
  const provider = { id: "p1", kind: "vscode-lm", label: "VS Code", enabled: true } as ProviderConfig;
  return { model, provider, messages, ...(tools ? { tools } : {}), signal: undefined, proxyUrl: undefined };
}
async function collect(handle: { events: AsyncIterable<StreamEvent> }): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}
beforeEach(() => {
  store.models = [];
  store.sent = [];
  store.sendImpl = undefined;
  store.modelListeners = [];
  store.noDataPart = false;
  vi.clearAllMocks();
});
describe("listVscodeLmModels", () => {
  it("maps vscode models to id/name/vendor/family", async () => {
    store.models = [fakeModel()];
    await expect(listVscodeLmModels()).resolves.toEqual([
      { id: "copilot/gpt-4o", name: "GPT-4o", vendor: "copilot", family: "gpt-4o", maxInputTokens: 64000 },
    ]);
  });
});
describe("createVscodeLmTransport", () => {
  it("streams text then usage and done, folding system prompts", async () => {
    store.models = [fakeModel()];
    const t = createVscodeLmTransport();
    const events = await collect(
      await t.stream(
        req("m1", "copilot/gpt-4o", [
          { id: "s1", role: "system", content: "Be concise.", ts: 1 },
          { id: "u1", role: "user", content: "hi", ts: 2 },
        ]),
      ),
    );
    expect(events.filter((e) => e.type === "text")).toHaveLength(2);
    expect(events.at(-2)?.type).toBe("usage");
    expect(events.at(-1)).toEqual({ type: "done" });
    const usage = (events.at(-2) as { usage: { prompt: number; completion: number } }).usage;
    expect(usage.prompt).toBe(14);
    expect(usage.completion).toBe(7);
    const sent = store.sent[0];
    expect(sent.options.justification).toContain("Arc");
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0].role).toBe(1);
  });
  it("declares tools escaped and surfaces tool calls unescaped", async () => {
    const { LanguageModelToolCallPart } = await import("vscode");
    store.sendImpl = () => ({
      stream: (async function* () {
        yield new (LanguageModelToolCallPart as any)("c1", "file_dread", { path: "a.ts" });
      })(),
    });
    store.models = [fakeModel()];
    const t = createVscodeLmTransport();
    const events = await collect(
      await t.stream(
        req("m1", "copilot/gpt-4o", [{ id: "u1", role: "user", content: "read it", ts: 1 }], [
          { name: "file.read", description: "Read a file", parameters: { type: "object" } },
        ]),
      ),
    );
    const toolCall = events.find((e) => e.type === "tool_call") as any;
    expect(toolCall).toMatchObject({ id: "c1", name: "file.read", args: { path: "a.ts" } });
    expect(store.sent[0].options.tools).toEqual([
      { name: "file_dread", description: "Read a file", inputSchema: { type: "object" } },
    ]);
  });
  it("queries the full model set and matches locally instead of narrowing by selector", async () => {
    store.models = [fakeModel()];
    const t = createVscodeLmTransport({ warmupMs: 5 });
    await collect(await t.stream(req()));
    const { lm } = await import("vscode");
    expect((lm.selectChatModels as any).mock.calls[0]).toEqual([]);
  });
  it("waits for late-activating providers via onDidChangeChatModels", async () => {
    store.models = [];
    const t = createVscodeLmTransport({ warmupMs: 10_000 });
    const pending = t.stream(req()).then(collect);
    await new Promise((r) => setTimeout(r, 10));
    store.models = [fakeModel()];
    for (const l of store.modelListeners) l();
    const events = await pending;
    expect(events.filter((e) => e.type === "text")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "done" });
  });
  it("reports a stale binding distinctly from an empty model set", async () => {
    store.models = [fakeModel()];
    const t = createVscodeLmTransport({ warmupMs: 5 });
    await expect(t.stream(req("m1", "copilot/retired-model"))).rejects.toThrow(
      /'copilot\/retired-model' was not found.*copilot\/gpt-4o/,
    );
  });
  it("throws actionable guidance when no models are available", async () => {
    store.models = [];
    const t = createVscodeLmTransport({ warmupMs: 5 });
    await expect(t.stream(req())).rejects.toThrow(/No VS Code language models available.*Copilot Chat/);
  });
  it("sends embedded images as data parts to vision-capable models", async () => {
    store.models = [fakeModel()];
    const t = createVscodeLmTransport({ warmupMs: 5 });
    await collect(
      await t.stream(
        req("m1", "copilot/gpt-4o", [
          {
            id: "u1",
            role: "user",
            content: "what is this",
            images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
            ts: 1,
          },
        ]),
      ),
    );
    const content = store.sent[0].messages[0].content as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ value: "what is this" });
    expect(content[1]).toMatchObject({ kind: "image-data", mime: "image/png" });
    expect(Buffer.from(content[1].data).toString()).toBe("hello");
  });
  it("drops images when the model declares no vision support", async () => {
    store.models = [fakeModel({ capabilities: { imageInput: false } })];
    const t = createVscodeLmTransport({ warmupMs: 5 });
    await collect(
      await t.stream(
        req("m1", "copilot/gpt-4o", [
          {
            id: "u1",
            role: "user",
            content: "what is this",
            images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
            ts: 1,
          },
        ]),
      ),
    );
    expect(store.sent[0].messages[0].content).toBe("what is this");
  });
  it("drops images when the runtime has no data-part API", async () => {
    store.models = [fakeModel()];
    store.noDataPart = true;
    const t = createVscodeLmTransport({ warmupMs: 5 });
    await collect(
      await t.stream(
        req("m1", "copilot/gpt-4o", [
          {
            id: "u1",
            role: "user",
            content: "what is this",
            images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
            ts: 1,
          },
        ]),
      ),
    );
    expect(store.sent[0].messages[0].content).toBe("what is this");
  });
  it("reports vision support from model capabilities", async () => {
    const model = req("m1", "copilot/gpt-4o").model;
    store.models = [fakeModel()];
    await expect(getVscodeLmVisionSupport(model, "p1", { warmupMs: 5 })).resolves.toBe(true);
    store.models = [fakeModel({ capabilities: { imageInput: false } })];
    await expect(getVscodeLmVisionSupport(model, "p1", { warmupMs: 5 })).resolves.toBe(false);
    store.models = [fakeModel({ capabilities: undefined })];
    await expect(getVscodeLmVisionSupport(model, "p1", { warmupMs: 5 })).resolves.toBe(true);
    store.models = [];
    await expect(getVscodeLmVisionSupport(model, "p1", { warmupMs: 5 })).resolves.toBe(false);
  });
  it("maps sendRequest rejections to classified messages", async () => {
    store.models = [
      fakeModel({
        sendRequest: vi.fn(async () => {
          throw { code: "Blocked", message: "quota" };
        }),
      }),
    ];
    const t = createVscodeLmTransport();
    await expect(t.stream(req())).rejects.toThrow(/quota exceeded or policy/);
  });
});