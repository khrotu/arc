import { describe, it, expect } from "vitest";
import { Agent, type AgentEventSink } from "../src/agent/agent";
import { ModelRegistry } from "../src/routing/registry";
import { CheckpointStore } from "../src/checkpoint/store";
import { ModeRegistry } from "../src/modes/index";
import type { ChatMessage } from "../src/protocol/protocol";
import type { ProcessStep } from "../src/protocol/process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
function makeSink() {
  const messages: ChatMessage[] = [];
  const events: string[] = [];
  let lastSteps: ProcessStep[] = [];
  const sink: AgentEventSink = {
    message: (m) => messages.push(m),
    steps: (s) => { lastSteps = s.map((x) => ({ ...x })); },
    turnStart: () => events.push("turnStart"),
    turnEnd: () => events.push("turnEnd"),
    usage: () => {},
    handoff: () => {},
    todo: () => {},
    clarification: () => {},
    done: () => events.push("done"),
    error: () => {},
  };
  return { sink, messages, events, getSteps: () => lastSteps };
}
const toolCallSse = (name: string, argFragments: string[]): string => {
  const lines: string[] = [];
  lines.push(`data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"${name}","arguments":""}}]}}]}`);
  lines.push("");
  for (const frag of argFragments) {
    lines.push(`data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${frag.replace(/"/g, '\\"')}"}}]}}]}`);
    lines.push("");
  }
  lines.push(`data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`);
  lines.push("");
  lines.push(`data: {"id":"x","choices":[{"index":0,"delta":{"content":"done"}}]}`);
  lines.push("");
  lines.push(`data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`);
  lines.push("");
  lines.push("data: [DONE]");
  lines.push("");
  return lines.join("\n");
};
describe("Agent tool calling", () => {
  it("invokes a registered tool and feeds the result back to the model", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-agent-tools-"));
    const registry = new ModelRegistry();
    registry.load({
      models: [{
        id: "m1", label: "Test", tier: "default", contextWindow: 8000,
        costPer1mIn: 0, costPer1mOut: 0,
        providers: [{ id: "p1", kind: "openai-compatible", priority: 0, remoteModel: "deepseek-v4-pro" }],
      }],
      providers: [{ id: "p1", kind: "openai-compatible", label: "ds", enabled: true, baseUrl: "https://api.deepseek.com/v1" }],
    });
    const store = new CheckpointStore({ dir: tmp });
    const { sink, messages, events, getSteps } = makeSink();
    const real = globalThis.fetch;
    let reqNum = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init: any) => {
      reqNum++;
      const body = init?.body ? String(init.body) : "";
      if (reqNum === 1) {
        return new Response(toolCallSse("todo_dwrite", ["{\"items\":[{\"id\":\"a\",\"text\":\"alpha\",\"state\":\"in_progress\"}]}"]), {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      }
      expect(body).toContain("tool_call_id");
      expect(body).toContain("call_abc");
      expect(body).toContain("Todo list updated");
      return new Response([
        'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"tool result processed"}}]}',
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
        enabledTools: new Set(["todo.write"]),
        mode: "code",
        modeRegistry: new ModeRegistry(),
        toolContext: { problems: async () => [], problemsFor: async () => [], summaryForFiles: async () => ({ hasErrors: false, hasWarnings: false, text: "" }) },
      });
      await agent.send("demonstrate todo");
      const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
      expect(lastAssistant).toBeDefined();
      expect(lastAssistant?.content).toBe("tool result processed");
      const todo = getSteps().find((s) => s.type === "todo_list");
      expect(todo).toBeDefined();
      expect(todo?.todos?.[0]?.text).toBe("alpha");
      expect(getSteps().some((s) => s.type === "tool")).toBe(false);
      expect(events).toContain("turnStart");
      expect(events).toContain("turnEnd");
      expect(events).toContain("done");
    } finally {
      globalThis.fetch = real;
    }
  });
});