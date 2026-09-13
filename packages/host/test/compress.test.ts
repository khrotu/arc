import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { detectKind, crushJsonArray, crushLines, compressForContext } from "../src/compress/compress";
import { saveBlob, loadBlob } from "../src/compress/store";
import { getWorkspaceArcDir } from "../src/arc-dir";
describe("compress detectKind", () => {
  it("detects JSON arrays", () => {
    expect(detectKind('[{"a":1},{"a":2}]')).toBe("json-array");
  });
  it("detects JSON objects", () => {
    expect(detectKind('{"a":1,"b":2}')).toBe("json-object");
  });
  it("detects logs on many lines", () => {
    const log = Array.from({ length: 60 }, (_, i) => `2026-08-05 line ${i}`).join("\n");
    expect(detectKind(log)).toBe("log");
  });
  it("treats invalid JSON brackets as text", () => {
    expect(detectKind("[not json")).toBe("text");
  });
});
describe("compress crushJsonArray", () => {
  it("keeps head, tail, and anomaly rows", () => {
    const rows = [
      { ok: true, id: 0 },
      { ok: true, id: 1 },
      { ok: true, id: 2 },
      { ok: false, error: "boom", id: 3 },
      ...Array.from({ length: 80 }, (_, i) => ({ ok: true, id: i + 4 })),
    ];
    const out = crushJsonArray(JSON.stringify(rows));
    expect(out).toBeDefined();
    expect(out!).toContain("rows omitted");
    expect(out!).toContain("boom");
    expect(out!).toContain('"id":0');
  });
  it("returns undefined when nothing is dropped", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    expect(crushJsonArray(JSON.stringify(rows))).toBeUndefined();
  });
  it("returns undefined on invalid JSON", () => {
    expect(crushJsonArray("nope")).toBeUndefined();
  });
});
describe("compress crushLines", () => {
  it("keeps head and tail with an omission marker", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const out = crushLines(lines, 5, 3);
    expect(out).toBeDefined();
    expect(out!).toContain("line 0");
    expect(out!).toContain("line 99");
    expect(out!).toContain("92 lines omitted");
  });
  it("returns undefined when the collapse saves nothing", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(crushLines(lines, 5, 3)).toBeUndefined();
  });
});
describe("compress roundtrip", () => {
  it("saves and retrieves the original blob by id", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-compress-"));
    const content = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ i, v: `value-${i}` })));
    const id = await saveBlob(tmp, "file.grep", content);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const restored = await loadBlob(tmp, id);
    expect(restored?.content).toBe(content);
    expect(restored?.truncated).toBe(false);
    expect(await loadBlob(tmp, "deadbeef")).toBeUndefined();
    expect(await loadBlob(tmp, id.slice(0, 12))).toBeUndefined();
    const dir = path.join(getWorkspaceArcDir(tmp), "context");
    const files = await fs.readdir(dir);
    expect(files.length).toBe(1);
  });
  it("compressForContext stores a retrievable original for large JSON", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-compress-"));
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}`, ok: i % 7 === 0 ? false : true }));
    const big = JSON.stringify(rows);
    const r = await compressForContext(big, "shell.run", tmp);
    expect(r.kind).toBe("json-array");
    expect(r.id).toBeDefined();
    expect(r.output.length).toBeLessThan(big.length * 0.7);
    expect(r.output).toContain("context.retrieve");
    expect((await loadBlob(tmp, r.id!))?.content).toBe(big);
  });
  it("leaves small outputs untouched", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-compress-"));
    const small = "hello world";
    const r = await compressForContext(small, "shell.run", tmp);
    expect(r.kind).toBe("none");
    expect(r.output).toBe(small);
  });
  it("does not compress when savings are below the ratio guard", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-compress-"));
    const awkward = "x".repeat(5000);
    const r = await compressForContext(awkward, "shell.run", tmp);
    expect(r.kind).toBe("none");
    expect(r.output).toBe(awkward);
  });
});