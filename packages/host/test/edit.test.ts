import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyEdit } from "../src/edit/apply";
import { tools } from "../src/agent/tools";
import type { ToolContext } from "../src/agent/tools";
describe("applyEdit", () => {
  it("applies an exact match", () => {
    const r = applyEdit({ before: "hello world", search: "world", replace: "there" });
    expect(r.ok).toBe(true);
    expect(r.after).toBe("hello there");
    expect(r.strategy).toBe("exact");
  });
  it("refuses loose matches that span most of the file", () => {
    const filler = Array.from({ length: 500 }, (_, i) => `padding line ${i}`).join("\n");
    const before = `alpha marker\n${filler}\nomega marker`;
    const r = applyEdit({ before, search: "alpha marker\nomega marker", replace: "X" });
    expect(r.ok).toBe(false);
  });
  it("tolerates trailing-whitespace drift", () => {
    const r = applyEdit({ before: "a\n  b   \nc", search: "a\n  b\nc", replace: "a\nb\nc" });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("trim");
  });
  it("tolerates blank-line collapse", () => {
    const r = applyEdit({ before: "a\n\n\n\nb", search: "a\n\nb", replace: "a\nb" });
    expect(r.ok).toBe(true);
  });
  it("rejects ambiguous match without replaceAll", () => {
    const r = applyEdit({ before: "x\nfoo\ny\nfoo\nz", search: "foo", replace: "bar" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/multiple locations/);
  });
  it("replaces all with replaceAll", () => {
    const r = applyEdit({ before: "x\nfoo\ny\nfoo\nz", search: "foo", replace: "bar", replaceAll: true });
    expect(r.ok).toBe(true);
    expect(r.matches).toBe(2);
    expect(r.after).toBe("x\nbar\ny\nbar\nz");
  });
  it("uses windowed fuzzy match when whitespace differs", () => {
    const r = applyEdit({
      before: "function f() {\n    return 1;\n}",
      search: "function f() {\n  return 1;\n}",
      replace: "function f() {\n  return 2;\n}",
    });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("fuzzy");
  });
  it("fuzzy match on CRLF files replaces at correct offsets", () => {
    const r = applyEdit({ before: "bb\r\ncc\r\n", search: "  bb\n  cc", replace: "XX" });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("fuzzy");
    expect(r.after).toBe("XX\r\n");
  });
  it("fuzzy match on mixed line endings keeps the trailing line", () => {
    const r = applyEdit({
      before: "aa\r\nbb\r\ncc",
      search: "  bb\n  cc",
      replace: "YY",
    });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("fuzzy");
    expect(r.after).toBe("aa\r\nYY");
  });
  it("returns ok=false with a clear error when no match", () => {
    const r = applyEdit({ before: "hello", search: "missing", replace: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
  it("writes (replaces) when search is empty", () => {
    const r = applyEdit({ before: "abc", search: "", replace: "def" });
    expect(r.ok).toBe(true);
    expect(r.after).toBe("def");
    expect(r.strategy).toBe("write");
  });
  it("applies a SEARCH/REPLACE block passed as the search argument", () => {
    const block = `src/foo.ts
<<<<<<< SEARCH
function add(a, b) {
  return a + b
}
=======
function add(a, b) {
  return a + b + 0
}
>>>>>>> REPLACE`;
    const r = applyEdit({
      before: "function add(a, b) {\n  return a + b\n}\n",
      search: block,
      replace: "",
    });
    expect(r.ok).toBe(true);
    expect(r.after).toBe("function add(a, b) {\n  return a + b + 0\n}\n");
    expect(r.strategy).toBe("exact");
  });
  it("applies a SEARCH/REPLACE block without a filename header", () => {
    const block = `<<<<<<< SEARCH
const x = 1
=======
const x = 2
>>>>>>> REPLACE`;
    const r = applyEdit({
      before: "const x = 1\n",
      search: block,
      replace: "",
    });
    expect(r.ok).toBe(true);
    expect(r.after).toBe("const x = 2\n");
  });
  it("extracts diff block content and falls back to fuzzy match when whitespace drifts", () => {
    const block = `<<<<<<< SEARCH
function f() {
  return 1;
}
=======
function f() {
  return 2;
}
>>>>>>> REPLACE`;
    const r = applyEdit({
      before: "function f() {\n    return 1;\n}\n",
      search: block,
      replace: "",
    });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("fuzzy");
    expect(r.after).toBe("function f() {\n  return 2;\n}\n");
  });
  it("returns a clear error when a diff block is missing the divider", () => {
    const r = applyEdit({
      before: "hello world",
      search: "<<<<<<< SEARCH\nworld\n>>>>>>> REPLACE",
      replace: "ignored",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
});
describe("file.edit empty-replace guard", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  });
  async function setup(content: string): Promise<{ tmp: string; ctx: ToolContext }> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-edit-guard-"));
    dirs.push(tmp);
    await fs.writeFile(path.join(tmp, "a.txt"), content, "utf-8");
    return { tmp, ctx: { root: tmp, workspacePath: tmp } as unknown as ToolContext };
  }
  it("rejects a missing or empty plain-text replace instead of blanking the match", async () => {
    const { ctx } = await setup("function getVersion() {\n  return 1;\n}\n");
    const missing = await tools["file.edit"].fn({ path: "a.txt", search: "function getVersion() {\n  return 1;\n}" }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.output).toMatch(/non-empty `replace`/);
    const empty = await tools["file.edit"].fn({ path: "a.txt", search: "return 1;", replace: "" }, ctx);
    expect(empty.ok).toBe(false);
    expect(empty.output).toMatch(/non-empty `replace`/);
  });
  it("still allows explicit deletion via an empty SEARCH/REPLACE block", async () => {
    const { tmp, ctx } = await setup("keep\nremove me\nkeep\n");
    const block = "x\n<<<<<<< SEARCH\nremove me\n=======\n\n>>>>>>> REPLACE";
    const r = await tools["file.edit"].fn({ path: "a.txt", search: block, replace: "" }, ctx);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, "a.txt"), "utf-8")).toBe("keep\n\nkeep\n");
  });
});