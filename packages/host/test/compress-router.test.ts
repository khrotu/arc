import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { detectKind, crushSearch, crushDiff, compressForContext } from "../src/compress/compress";
describe("compress router", () => {
  it("detects search output", () => {
    const text = Array.from({ length: 30 }, (_, i) => `src/file${i % 3}.ts:${i}:match here`).join("\n");
    expect(detectKind(text)).toBe("search");
  });
  it("detects diffs", () => {
    const text = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(detectKind(text)).toBe("diff");
  });
  it("crushSearch keeps an omission summary", () => {
    const text = Array.from({ length: 200 }, (_, i) => `src/f.ts:${i}:some log line number ${i}`).join("\n");
    const out = crushSearch(text, "file.grep");
    expect(out).toBeDefined();
    expect(out!).toContain("lines omitted");
  });
  it("crushDiff truncates context but keeps changes", () => {
    const hunks = Array.from({ length: 4 }, (_, h) => `@@ -${h * 10 + 1},10 +${h * 10 + 1},10 @@\n${" context line\n".repeat(10)}-removed ${h}\n+added ${h}`).join("\n");
    const text = `diff --git a/x b/x\n${hunks}\n${"x".repeat(3000)}`;
    const out = crushDiff(text, 2, 2);
    expect(out).toBeDefined();
    expect(out!).toContain("hunks omitted");
    expect(out!).toContain("+added 0");
  });
  it("compressForContext compresses search output end to end", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-router-"));
    const text = Array.from({ length: 400 }, (_, i) => `src/mod${i % 5}.ts:${i}:result payload value=${i}`).join("\n");
    const r = await compressForContext(text, "file.grep", tmp);
    expect(r.kind).toBe("search");
    expect(r.output.length).toBeLessThan(text.length);
    expect(r.output).toContain("context.retrieve");
  });
});