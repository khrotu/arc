import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Agent, type AgentEventSink } from "../src/agent/agent";
import { ModelRegistry } from "../src/routing/registry";
import { CheckpointStore } from "../src/checkpoint/store";
import { ModeRegistry } from "../src/modes/index";
import { initSession } from "../src/approvals/engine";
import type { ChatMessage } from "../src/protocol/protocol";
function makeSink() {
  const messages: ChatMessage[] = [];
  const sink: AgentEventSink = {
    message: (m) => messages.push(m),
    steps: () => {},
    turnStart: () => {},
    turnEnd: () => {},
    usage: () => {},
    handoff: () => {},
    todo: () => {},
    clarification: () => {},
    done: () => {},
    error: () => {},
    guidance: () => {},
    compaction: () => {},
  };
  return { sink, messages };
}
const toolCallSse = (name: string, args: string): string => {
  const escaped = args.replace(/"/g, '\\"');
  return [
    `data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"${name}","arguments":"${escaped}"}}]}}]}`,
    "",
    `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    "",
    'data: {"id":"x","choices":[{"index":0,"delta":{"content":"done"}}]}',
    "",
    'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
};
describe("Agent context compression", () => {
  it("compresses oversized tool output with a retrievable marker", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-agent-compress-"));
    const registry = new ModelRegistry();
    registry.load({
      models: [{
        id: "m1", label: "Test", tier: "default", contextWindow: 8000,
        costPer1mIn: 0, costPer1mOut: 0,
        providers: [{ id: "p1", kind: "openai-compatible", priority: 0, remoteModel: "m" }],
      }],
      providers: [{ id: "p1", kind: "openai-compatible", label: "ds", enabled: true, baseUrl: "https://api.example.com/v1" }],
    });
    const store = new CheckpointStore({ dir: tmp });
    const { sink, messages } = makeSink();
    const real = globalThis.fetch;
    let reqNum = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init: any) => {
      reqNum++;
      if (reqNum === 1) {
        return new Response(toolCallSse("file.grep", '{"pattern":"foo"}'), {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      }
      const body = String(init?.body ?? "");
      expect(body).toContain("lines omitted");
      expect(body).toContain("context.retrieve");
      return new Response([
        'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"final"}}]}',
        "",
        'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    try {
      const agent = new Agent(registry, store, sink, {
        isMain: true,
        systemPrompt: "You are a test assistant.",
        enabledTools: new Set(["file.grep", "context.retrieve"]),
        workspaceRoot: tmp,
        mode: "code",
        modeRegistry: new ModeRegistry(),
        initialSessionApprovals: { ...initSession(), autoApproveMode: "all" },
        toolContext: {
          problems: async () => [],
          problemsFor: async () => [],
          summaryForFiles: async () => ({ hasErrors: false, hasWarnings: false, text: "" }),
          grep: async () => Array.from({ length: 120 }, (_, i) => ({ file: `src/f${i}.ts`, line: i, column: 1, text: `match ${i} ${"x".repeat(80)}` })),
        },
        autoSessionNotes: false,
      });
      await agent.send("find foo");
      const toolMsg = agent.getMessages().filter((m) => m.role === "tool").pop();
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("lines omitted");
      expect(toolMsg!.content).toContain("context.retrieve");
      const id = toolMsg!.content.match(/id "([a-f0-9]+)"/)?.[1];
      expect(id).toBeDefined();
      const { loadBlob } = await import("../src/compress/store");
      const restored = await loadBlob(tmp, id!);
      expect(restored).toBeDefined();
      expect(restored!.content.length).toBeGreaterThan(8000);
    } finally {
      globalThis.fetch = real;
    }
  });
});