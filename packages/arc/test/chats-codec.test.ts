import { describe, it, expect } from "vitest";
import { encryptChatSnapshot, decryptChatSnapshot, CHATS_FILE_NAME } from "../src/extension/chats-codec.ts";
import type { ChatSnapshot } from "@arc/host";
const KEY = Buffer.alloc(32, 7);
function sampleSnapshot(): ChatSnapshot {
  return {
    chats: [
      { id: "chat-1", title: "Fix the bug", createdAt: 1700000000000, updatedAt: 1700000100000, cost: 0.00423 },
      { id: "chat-2", title: "Refactor", createdAt: 1700001000000, updatedAt: 1700001100000, cost: 0.12 },
    ],
    currentId: "chat-1",
    messages: {
      "chat-1": [
        { id: "m1", role: "user", content: "Fix the bug in src/index.ts", ts: 1700000000100 },
        {
          id: "m2", role: "assistant", content: "Let me look.", thinking: "need to find the bug", ts: 1700000000200,
          toolCalls: [{ id: "t1", name: "file.read", args: { path: "src/index.ts" } }],
          meta: { modelId: "deepseek-v4-pro", providerId: "deepseek", tier: "default" },
        },
        { id: "m3", role: "tool", content: "ok", toolCallId: "t1", ts: 1700000000300 },
        {
          id: "m4", role: "assistant", content: "Found it - image attached.", ts: 1700000000400,
          images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
          noCompact: true,
        },
      ],
      "chat-2": [
        { id: "n1", role: "assistant", content: "Refactored.", ts: 1700001000100, meta: { modelId: "gpt-5.6-luna", providerId: "openai", tier: "heavy" } },
      ],
    },
    steps: {
      "chat-1": [
        { id: "s1", type: "tool_group", title: "Called 1 tool", status: "done", children: [], ts: 1700000000250 },
      ],
    },
  };
}
describe("chats codec", () => {
  it("round-trips a full snapshot losslessly", () => {
    const snap = sampleSnapshot();
    const file = encryptChatSnapshot(snap, KEY);
    const out = decryptChatSnapshot(file, KEY);
    expect(out).toEqual(snap);
  });
  it("rejects a wrong key", () => {
    const file = encryptChatSnapshot(sampleSnapshot(), KEY);
    const wrong = Buffer.alloc(32, 9);
    expect(() => decryptChatSnapshot(file, wrong)).toThrow();
  });
  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const file = encryptChatSnapshot(sampleSnapshot(), KEY);
    file[file.length - 1] ^= 0xff;
    expect(() => decryptChatSnapshot(file, KEY)).toThrow();
  });
  it("rejects garbage and truncated files", () => {
    expect(() => decryptChatSnapshot(Buffer.from("not an arcx file at all"), KEY)).toThrow();
    const file = encryptChatSnapshot(sampleSnapshot(), KEY);
    expect(() => decryptChatSnapshot(file.subarray(0, 12), KEY)).toThrow();
  });
  it("is more compact than the equivalent JSON", () => {
    const snap = sampleSnapshot();
    const file = encryptChatSnapshot(snap, KEY);
    const jsonLen = Buffer.byteLength(JSON.stringify(snap), "utf8");
    expect(file.length).toBeLessThan(jsonLen);
  });
  it("exposes the arcx file name", () => {
    expect(CHATS_FILE_NAME).toBe("arc.chats.arcx");
  });
  it("recovers surviving messages when one frame is corrupt", async () => {
    const { decodeSnapshot, encodeSnapshot, getLastDecodeWarnings } = await import("../src/extension/chats-codec.ts");
    const snap = sampleSnapshot();
    const plain = encodeSnapshot(snap);
    const at = plain.indexOf('"path":"src/index.ts"');
    expect(at).toBeGreaterThan(0);
    plain[at] ^= 0xff;
    const out = decodeSnapshot(plain);
    const ids = (out.messages["chat-1"] ?? []).map((m: { id: string }) => m.id);
    expect(ids).toContain("m1");
    expect(ids).toContain("m3");
    expect(ids).toContain("m4");
    expect(ids).not.toContain("m2");
    expect(getLastDecodeWarnings().length).toBeGreaterThan(0);
    expect(out.messages["chat-2"].length).toBe(1);
  });
});