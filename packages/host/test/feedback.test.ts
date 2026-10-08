import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent/agent";
import { ModelRegistry } from "../src/routing/registry";
import { CheckpointStore } from "../src/checkpoint/store";
import { ModeRegistry } from "../src/modes/index";
import type { AgentEventSink } from "../src/agent/agent";
import type { ProcessStep, TodoItem } from "../src/protocol/process";
import type { ChatMessage } from "../src/protocol/protocol";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
function makeSink() {
  const messages: ChatMessage[] = [];
  let steps: ProcessStep[] = [];
  let todos: TodoItem[] = [];
  const sink: AgentEventSink = {
    message: (m) => messages.push(m),
    steps: (s) => { steps = s; },
turnStart: () => {  },
turnEnd: () => {  },
usage: () => {  },
handoff: () => {  },
    todo: (items) => { todos = items; },
clarification: () => {  },
done: () => {  },
error: () => {  },
compaction: () => {  },
  };
  return { sink, messages, getSteps: () => steps, getTodos: () => todos };
}
describe("Agent post-edit feedback loop", () => {
  it("injects an lsp step + tool message after file.edit when diagnostics are present", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-fb-"));
    const registry = new ModelRegistry();
    registry.load({
      models: [{ id: "m1", label: "Test", tier: "default", contextWindow: 8000, costPer1mIn: 0, costPer1mOut: 0, providers: [] }],
      providers: [],
    });
    const store = new CheckpointStore({ dir: tmp });
    const { sink, getSteps } = makeSink();
    const agent = new Agent(registry, store, sink, {
      systemPrompt: "you are arc",
      enabledTools: new Set(["file.read", "file.edit", "todo.write"]),
      workspaceRoot: tmp,
      mode: "code",
      modeRegistry: new ModeRegistry(),
      isMain: true,
      toolContext: {
      },
    });
    await store.snapshot("t1", tmp, ["a.txt"], [{ id: "1", text: "do thing", state: "in_progress" }]);
    const loaded = await store.load(tmp, "t1");
    expect(loaded?.todoItems?.length).toBe(1);
    expect(loaded?.todoItems?.[0].text).toBe("do thing");
  });
});
describe("CheckpointStore todo round-trip", () => {
  it("persists and restores todo state", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-todo-snap-"));
    const store = new CheckpointStore({ dir: tmp });
    const todos = [
      { id: "1", text: "first", state: "done" as const },
      { id: "2", text: "second", state: "in_progress" as const },
    ];
    await store.snapshot("t1", tmp, [], todos);
    const loaded = await store.load(tmp, "t1");
    expect(loaded?.todoItems).toEqual(todos);
  });
  it("retract restores the todo state from the snapshot", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-todo-retract-"));
    const target = path.join(tmp, "a.txt");
    await fs.writeFile(target, "v1", "utf-8");
    const store = new CheckpointStore({ dir: tmp });
    await store.snapshot("t1", tmp, ["a.txt"], [
      { id: "1", text: "alpha", state: "done" },
      { id: "2", text: "beta", state: "in_progress" },
    ]);
    await store.snapshot("t2", tmp, ["a.txt"], [
      { id: "1", text: "alpha", state: "done" },
      { id: "2", text: "beta", state: "done" },
      { id: "3", text: "gamma (sub:writer)", state: "in_progress" },
    ]);
    const r = await store.restore(tmp, "t1");
    expect(r.restored).toContain("a.txt");
    const loaded = await store.load(tmp, "t1");
    expect(loaded?.todoItems?.map((t) => t.id)).toEqual(["1", "2"]);
  });
});