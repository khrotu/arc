import { describe, it, expect } from "vitest";
import { sanitizeToolChains } from "../src/agent/agent";
import { toApiToolName, fromApiToolName } from "../src/providers/transport";
import type { ChatMessage } from "../src/protocol/protocol";
function msg(over: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: "user", content: "", ts: 0, ...over };
}
describe("sanitizeToolChains", () => {
  it("keeps valid tool chains intact", () => {
    const msgs = [
      msg({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", args: {} }] }),
      msg({ id: "r1", role: "tool", content: "out", toolCallId: "t1" }),
    ];
    expect(sanitizeToolChains(msgs)).toHaveLength(2);
  });
  it("keeps parallel tool responses after a single assistant", () => {
    const msgs = [
      msg({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", args: {} }, { id: "t2", name: "y", args: {} }] }),
      msg({ id: "r1", role: "tool", content: "out1", toolCallId: "t1" }),
      msg({ id: "r2", role: "tool", content: "out2", toolCallId: "t2" }),
    ];
    expect(sanitizeToolChains(msgs)).toHaveLength(3);
  });
  it("drops orphaned tool messages with no preceding assistant tool call", () => {
    const msgs = [
      msg({ id: "r0", role: "tool", content: "orphan", toolCallId: "gone" }),
      msg({ id: "u", role: "user", content: "hi" }),
      msg({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", args: {} }] }),
      msg({ id: "r1", role: "tool", content: "out", toolCallId: "t1" }),
      msg({ id: "r2", role: "tool", content: "other orphan", toolCallId: "nope" }),
    ];
    const out = sanitizeToolChains(msgs);
    expect(out.map((m) => m.id)).toEqual(["u", "a", "r1"]);
  });
  it("drops duplicate tool responses for the same tool call (post-edit LSP/verify case)", () => {
    const msgs = [
      msg({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "edit", name: "file.edit", args: {} }] }),
      msg({ id: "r1", role: "tool", content: "edited ok", toolCallId: "edit" }),
      msg({ id: "r2", role: "tool", content: "LSP reported 2 warnings", toolCallId: "edit" }),
    ];
    const out = sanitizeToolChains(msgs);
    expect(out.map((m) => m.id)).toEqual(["a", "r1"]);
  });
  it("keeps parallel tool responses with distinct ids", () => {
    const msgs = [
      msg({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "e", name: "file.edit", args: {} }, { id: "g", name: "glob", args: {} }] }),
      msg({ id: "r1", role: "tool", content: "edit ok", toolCallId: "e" }),
      msg({ id: "r2", role: "tool", content: "glob ok", toolCallId: "g" }),
      msg({ id: "r3", role: "tool", content: "edit again", toolCallId: "e" }),
    ];
    const out = sanitizeToolChains(msgs);
    expect(out.map((m) => m.id)).toEqual(["a", "r1", "r2"]);
  });
  it("strips toolCalls from an assistant whose calls were never answered (aborted turn)", () => {
    const msgs = [
      msg({ id: "u", role: "user", content: "continue" }),
      msg({ id: "a", role: "assistant", content: "partial", toolCalls: [{ id: "t1", name: "shell.run", args: {} }] }),
      msg({ id: "u2", role: "user", content: "continue again" }),
    ];
    const out = sanitizeToolChains(msgs);
    const asst = out.find((m) => m.id === "a")!;
    expect(asst.toolCalls).toBeUndefined();
    expect(out).toHaveLength(3);
  });
  it("prunes unanswered calls but keeps answered ones", () => {
    const msgs = [
      msg({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "x", name: "x", args: {} }, { id: "y", name: "y", args: {} }] }),
      msg({ id: "r1", role: "tool", content: "x done", toolCallId: "x" }),
    ];
    const out = sanitizeToolChains(msgs);
    expect(out.find((m) => m.id === "a")!.toolCalls).toEqual([{ id: "x", name: "x", args: {} }]);
  });
  it("dedupes duplicate tool_call ids in the assistant message", () => {
    const msgs = [
      msg({ id: "a", role: "assistant", content: "", toolCalls: [{ id: "c0", name: "x", args: {} }, { id: "c0", name: "y", args: {} }] }),
      msg({ id: "r1", role: "tool", content: "done", toolCallId: "c0" }),
    ];
    const out = sanitizeToolChains(msgs);
    expect(out.find((m) => m.id === "a")!.toolCalls).toEqual([{ id: "c0", name: "x", args: {} }]);
  });
});
describe("tool name codec", () => {
  it("round-trips dots, slashes, underscores, and dunder names", () => {
    for (const name of ["file.read", "mcp.call", "a/b", "x_y", "mcp__fs__echo", "a.b_c/d__e"]) {
      expect(fromApiToolName(toApiToolName(name))).toBe(name);
    }
  });
  it("emits API-safe names", () => {
    expect(toApiToolName("file.read")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});