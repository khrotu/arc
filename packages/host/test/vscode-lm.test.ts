import { describe, it, expect } from "vitest";
import {
  toVscodeLmMessages,
  toVscodeLmTools,
  selectorForVscodeLm,
  findVscodeLmModel,
  classifyVscodeLmError,
  VSCODE_LM_JUSTIFICATION,
} from "../src/providers/vscode-lm";
import type { ChatMessage } from "../src/protocol/protocol";
function msg(role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id: `m-${role}-${content.slice(0, 8)}`, role, content, ts: 1, ...extra };
}
describe("toVscodeLmMessages", () => {
  it("folds system prompts into user messages (no system role in the LM API)", () => {
    const out = toVscodeLmMessages([
      msg("system", "Be concise."),
      msg("user", "Hello"),
    ]);
    expect(out).toEqual([
      { role: "user", text: "Be concise." },
      { role: "user", text: "Hello" },
    ]);
  });
  it("maps assistant tool calls and groups consecutive tool results", () => {
    const out = toVscodeLmMessages([
      msg("assistant", "", {
        toolCalls: [
          { id: "c1", name: "file.read", args: { path: "a.ts" } },
          { id: "c2", name: "file.read", args: { path: "b.ts" } },
        ],
      }),
      msg("tool", "contents-a", { toolCallId: "c1" }),
      msg("tool", "contents-b", { toolCallId: "c2" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      role: "assistant",
      text: "",
      toolCalls: [
        { id: "c1", name: "file.read", args: { path: "a.ts" } },
        { id: "c2", name: "file.read", args: { path: "b.ts" } },
      ],
    });
    expect(out[1]).toEqual({
      role: "user",
      text: "",
      toolResults: [
        { callId: "c1", content: "contents-a" },
        { callId: "c2", content: "contents-b" },
      ],
    });
  });
  it("keeps tool results separate across intervening messages", () => {
    const out = toVscodeLmMessages([
      msg("tool", "a", { toolCallId: "c1" }),
      msg("user", "follow-up"),
      msg("tool", "b", { toolCallId: "c2" }),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].toolResults).toHaveLength(1);
    expect(out[2].toolResults).toHaveLength(1);
  });
  it("renders orphan tool output as user text", () => {
    const out = toVscodeLmMessages([msg("tool", "dangling")]);
    expect(out).toEqual([{ role: "user", text: "Tool output (without tool_call_id):\ndangling" }]);
  });
  it("drops empty assistant messages but preserves embedded image payloads", () => {
    const out = toVscodeLmMessages([
      msg("assistant", ""),
      msg("user", "hi", { images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] } as Partial<ChatMessage>),
    ]);
    expect(out).toEqual([{ role: "user", text: "hi", images: [{ mimeType: "image/png", base64: "aGVsbG8=" }] }]);
  });
  it("keeps image-only messages and drops remote URLs", () => {
    const out = toVscodeLmMessages([
      msg("user", "", {
        images: [
          { type: "image_url", image_url: { url: "https://example.com/pic.png" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/ 4AAQ" } },
        ],
      } as Partial<ChatMessage>),
    ]);
    expect(out).toEqual([{ role: "user", text: "", images: [{ mimeType: "image/jpeg", base64: "/9j/4AAQ" }] }]);
  });
});
describe("toVscodeLmTools", () => {
  it("returns undefined for empty tool lists", () => {
    expect(toVscodeLmTools(undefined)).toBeUndefined();
    expect(toVscodeLmTools([])).toBeUndefined();
  });
  it("escapes names identically to the OpenAI-compatible path", () => {
    const out = toVscodeLmTools([{ name: "file.read", description: "Read a file", parameters: { type: "object" } }]);
    expect(out).toEqual([{ name: "file_dread", description: "Read a file", inputSchema: { type: "object" } }]);
  });
  it("omits empty parameter schemas", () => {
    const out = toVscodeLmTools([{ name: "x", description: "y", parameters: {} }]);
    expect(out?.[0]).not.toHaveProperty("inputSchema");
  });
});
describe("selectorForVscodeLm", () => {
  it("returns an open selector without a slug", () => {
    expect(selectorForVscodeLm(undefined)).toEqual({});
    expect(selectorForVscodeLm("  ")).toEqual({});
  });
  it("selects bare ids directly", () => {
    expect(selectorForVscodeLm("gpt-4o")).toEqual({ id: "gpt-4o" });
  });
  it("splits vendor/family slugs while keeping the full id", () => {
    expect(selectorForVscodeLm("copilot/gpt-4o")).toEqual({ id: "copilot/gpt-4o", vendor: "copilot", family: "gpt-4o" });
  });
});
describe("findVscodeLmModel", () => {
  const models = [
    { id: "copilot/gpt-4o", vendor: "copilot", family: "gpt-4o" },
    { id: "copilot/claude-sonnet-4", vendor: "copilot", family: "claude-sonnet-4" },
  ];
  it("prefers exact id matches", () => {
    expect(findVscodeLmModel(models, "copilot/claude-sonnet-4")?.family).toBe("claude-sonnet-4");
  });
  it("falls back to family matching", () => {
    expect(findVscodeLmModel(models, "gpt-4o")?.id).toBe("copilot/gpt-4o");
  });
  it("returns the first model without a slug and undefined when empty", () => {
    expect(findVscodeLmModel(models)?.id).toBe("copilot/gpt-4o");
    expect(findVscodeLmModel([], "copilot/gpt-4o")).toBeUndefined();
    expect(findVscodeLmModel(models, "nope/nothing")).toBeUndefined();
  });
});
describe("classifyVscodeLmError", () => {
  it("maps documented LanguageModelError codes to guidance", () => {
    expect(classifyVscodeLmError({ code: "NoPermissions", message: "x" }).message).toContain("consent");
    expect(classifyVscodeLmError({ code: "Blocked", message: "x" }).message).toContain("quota");
    expect(classifyVscodeLmError({ code: "NotFound", message: "x" }).message).toContain("no longer exists");
  });
  it("passes unknown errors through", () => {
    expect(classifyVscodeLmError(new Error("boom"))).toEqual({ code: "Unknown", message: "boom" });
  });
  it("exposes a justification string for the consent prompt", () => {
    expect(VSCODE_LM_JUSTIFICATION.length).toBeGreaterThan(0);
  });
});