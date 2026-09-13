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
describe("Agent mode gate", () => {
  async function makePlanAgent() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-agent-modegate-"));
    const registry = new ModelRegistry();
    registry.load({
      models: [{
        id: "m1", label: "Test", tier: "default", contextWindow: 8000,
        costPer1mIn: 0, costPer1mOut: 0,
        providers: [{ id: "p1", kind: "openai-compatible", priority: 0, remoteModel: "test" }],
      }],
      providers: [{ id: "p1", kind: "openai-compatible", label: "p", enabled: true, baseUrl: "https://x.invalid/v1" }],
    });
    const store = new CheckpointStore({ dir: tmp });
    const { sink, messages } = makeSink();
    const agent = new Agent(registry, store, sink, {
      isMain: true,
      systemPrompt: "test",
      enabledTools: new Set(),
      mode: "plan",
      modeRegistry: new ModeRegistry(),
      toolContext: { root: tmp, workspacePath: tmp } as any,
    });
    return { agent, messages, tmp };
  }
  it("blocks mutating tools in plan mode", async () => {
    const { agent, tmp } = await makePlanAgent();
    const internal = agent as unknown as {
      executeToolCall: (t: { id: string; name: string; args: Record<string, unknown> }, turn: string) => Promise<void>;
      getMessages: () => { role: string; content: unknown }[];
    };
    await internal.executeToolCall({ id: "t1", name: "file.write", args: { path: "evil.txt", content: "x" } }, "turn-1");
    const toolMsg = internal.getMessages().filter((m) => m.role === "tool").pop();
    expect(String(toolMsg?.content ?? "")).toContain("not allowed in plan mode");
    expect(await fs.readFile(path.join(tmp, "evil.txt"), "utf-8").catch(() => "absent")).toBe("absent");
  });
  it("allows mode plumbing in plan mode", async () => {
    const { agent } = await makePlanAgent();
    const internal = agent as unknown as {
      executeToolCall: (t: { id: string; name: string; args: Record<string, unknown> }, turn: string) => Promise<void>;
      getMessages: () => { role: string; content: unknown }[];
    };
    await internal.executeToolCall({ id: "t2", name: "mode.switch", args: { slug: "code" } }, "turn-1");
    const toolMsg = internal.getMessages().filter((m) => m.role === "tool").pop();
    expect(String(toolMsg?.content ?? "")).toContain("Switched to");
  });
});
describe("Agent parallel tool execution", () => {
  it("serializes mutating tool calls into solo phases", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-agent-parallel-"));
    const registry = new ModelRegistry();
    registry.load({
      models: [{
        id: "m1", label: "Test", tier: "default", contextWindow: 8000,
        costPer1mIn: 0, costPer1mOut: 0,
        providers: [{ id: "p1", kind: "openai-compatible", priority: 0, remoteModel: "test" }],
      }],
      providers: [{ id: "p1", kind: "openai-compatible", label: "p", enabled: true, baseUrl: "https://x.invalid/v1" }],
    });
    const store = new CheckpointStore({ dir: tmp });
    const { sink } = makeSink();
    const agent = new Agent(registry, store, sink, {
      isMain: true,
      systemPrompt: "test",
      enabledTools: new Set(),
      mode: "code",
      modeRegistry: new ModeRegistry(),
      toolContext: {} as any,
    });
    const calls = [
      { id: "a", name: "shell.run", args: { command: "echo a" } },
      { id: "b", name: "shell.run", args: { command: "echo b" } },
      { id: "c", name: "shell.run", args: { command: "echo c" } },
    ];
    const internal = agent as unknown as { partitionToolCalls: (t: typeof calls) => typeof calls[] };
    const phases = internal.partitionToolCalls(calls);
    expect(phases.length).toBe(3);
    expect(phases.every((p) => p.length === 1)).toBe(true);
  });
  it("runs consecutive read-only calls in one phase", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-agent-parallel-"));
    const registry = new ModelRegistry();
    registry.load({
      models: [{
        id: "m1", label: "Test", tier: "default", contextWindow: 8000,
        costPer1mIn: 0, costPer1mOut: 0,
        providers: [{ id: "p1", kind: "openai-compatible", priority: 0, remoteModel: "test" }],
      }],
      providers: [{ id: "p1", kind: "openai-compatible", label: "p", enabled: true, baseUrl: "https://x.invalid/v1" }],
    });
    const store = new CheckpointStore({ dir: tmp });
    const { sink } = makeSink();
    const agent = new Agent(registry, store, sink, {
      isMain: true,
      systemPrompt: "test",
      enabledTools: new Set(),
      mode: "code",
      modeRegistry: new ModeRegistry(),
      toolContext: {} as any,
    });
    const calls = [
      { id: "a", name: "file.read", args: {} },
      { id: "b", name: "file.grep", args: {} },
      { id: "c", name: "shell.run", args: {} },
      { id: "d", name: "file.glob", args: {} },
    ];
    const internal = agent as unknown as { partitionToolCalls: (t: typeof calls) => typeof calls[] };
    const phases = internal.partitionToolCalls(calls);
    expect(phases.length).toBe(3);
    expect(phases[0].map((c) => c.name)).toEqual(["file.read", "file.grep"]);
    expect(phases[1].map((c) => c.name)).toEqual(["shell.run"]);
    expect(phases[2].map((c) => c.name)).toEqual(["file.glob"]);
  });
  it("separates handoff/subagent calls into their own phase", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-agent-parallel-"));
    const registry = new ModelRegistry();
    registry.load({
      models: [{
        id: "m1", label: "Test", tier: "default", contextWindow: 8000,
        costPer1mIn: 0, costPer1mOut: 0,
        providers: [{ id: "p1", kind: "openai-compatible", priority: 0, remoteModel: "test" }],
      }],
      providers: [{ id: "p1", kind: "openai-compatible", label: "p", enabled: true, baseUrl: "https://x.invalid/v1" }],
    });
    const store = new CheckpointStore({ dir: tmp });
    const { sink } = makeSink();
    const agent = new Agent(registry, store, sink, {
      isMain: true,
      systemPrompt: "test",
      enabledTools: new Set(),
      mode: "code",
      modeRegistry: new ModeRegistry(),
      toolContext: {} as any,
    });
    const calls = [
      { id: "a", name: "shell.run", args: {} },
      { id: "b", name: "handoff", args: {} },
      { id: "c", name: "shell.run", args: {} },
    ];
    const internal = agent as unknown as { partitionToolCalls: (t: typeof calls) => typeof calls[] };
    const phases = internal.partitionToolCalls(calls);
    expect(phases.length).toBe(3);
    expect(phases[0]).toHaveLength(1);
    expect(phases[1]).toHaveLength(1);
    expect(phases[1][0].name).toBe("handoff");
    expect(phases[2]).toHaveLength(1);
  });
  it("groups all handoff/subagent calls together so they don't run in parallel with each other either", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-agent-parallel-"));
    const registry = new ModelRegistry();
    registry.load({
      models: [{
        id: "m1", label: "Test", tier: "default", contextWindow: 8000,
        costPer1mIn: 0, costPer1mOut: 0,
        providers: [{ id: "p1", kind: "openai-compatible", priority: 0, remoteModel: "test" }],
      }],
      providers: [{ id: "p1", kind: "openai-compatible", label: "p", enabled: true, baseUrl: "https://x.invalid/v1" }],
    });
    const store = new CheckpointStore({ dir: tmp });
    const { sink } = makeSink();
    const agent = new Agent(registry, store, sink, {
      isMain: true,
      systemPrompt: "test",
      enabledTools: new Set(),
      mode: "code",
      modeRegistry: new ModeRegistry(),
      toolContext: {} as any,
    });
    const calls = [
      { id: "a", name: "handoff", args: {} },
      { id: "b", name: "subagent.spawn", args: {} },
    ];
    const internal = agent as unknown as { partitionToolCalls: (t: typeof calls) => typeof calls[] };
    const phases = internal.partitionToolCalls(calls);
    expect(phases.length).toBe(2);
    expect(phases[0].map((c) => c.name)).toEqual(["handoff"]);
    expect(phases[1].map((c) => c.name)).toEqual(["subagent.spawn"]);
  });
});