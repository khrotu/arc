import { describe, it, expect } from "vitest";
import { extractFileSymbols, stableSymbolId, splitSearchTerms } from "../src/syms/extract";
import { rankSymbols, extractSymbolTokens } from "../src/syms/rank";
import { buildCodeContext, formatCodeContext } from "../src/syms/context";
import { gini, fileDepth, riskScore, findRedundantPairs, assertUniqueAnchor, countOccurrences } from "../src/syms/health";
const TS_SAMPLE = `export class AuthService {
  async login(user: string) {
    if (!user) throw new Error("no user");
    return validateToken(user);
  }
}
export function validateToken(t: string) {
  if (!t) throw new Error("bad token");
  return t.length > 3;
}
`;
describe("syms extract", () => {
  it("extracts classes and functions with stable ids", () => {
    const syms = extractFileSymbols("src/auth.ts", TS_SAMPLE);
    const names = syms.map((s) => s.name);
    expect(names).toContain("AuthService");
    expect(names).toContain("login");
    expect(names).toContain("validateToken");
    const again = extractFileSymbols("src/auth.ts", TS_SAMPLE);
    expect(again.map((s) => s.id)).toEqual(syms.map((s) => s.id));
    expect(stableSymbolId("a", "function", "f", 1)).toBe(stableSymbolId("a", "function", "f", 1));
  });
  it("splits camelCase search terms", () => {
    expect(splitSearchTerms("validateToken")).toContain("token");
    expect(splitSearchTerms("AuthService")).toContain("auth");
  });
  it("extracts typed and single-arg arrow consts", () => {
    const syms = extractFileSymbols("a.ts", "const f: (a: string) => number = (a) => 1;\nconst g = (x) => x;\n");
    expect(syms.map((s) => s.name)).toContain("f");
  });
  it("does not record control keywords as functions", () => {
    const syms = extractFileSymbols("a.cs", "foreach (var x in y) {\n  using (var z = q) {\n  }\n}\n");
    expect(syms.map((s) => s.name)).not.toContain("foreach");
    expect(syms.map((s) => s.name)).not.toContain("using");
  });
  it("scores typed signatures without colon inflation", () => {
    const syms = extractFileSymbols("a.ts", "function f(a: string, b: number): boolean {\n  return true;\n}\n");
    expect(syms[0].complexity).toBeLessThan(6);
  });
  it("records call edges", () => {
    const syms = extractFileSymbols("src/auth.ts", TS_SAMPLE);
    const login = syms.find((s) => s.name === "login")!;
    expect(login.calls.map((c) => c.name)).toContain("validateToken");
  });
  it("extracts python defs", () => {
    const syms = extractFileSymbols("app.py", "class Repo:\n    def save(self):\n        pass\n");
    expect(syms.map((s) => s.name)).toContain("save");
  });
});
describe("syms rank", () => {
  it("surfaces exact symbol matches first", () => {
    const syms = extractFileSymbols("src/auth.ts", TS_SAMPLE);
    const ranked = rankSymbols("validateToken", syms, 5);
    expect(ranked[0].symbol.name).toBe("validateToken");
  });
  it("extracts symbol tokens from prose", () => {
    expect(extractSymbolTokens("where is validateToken used?")).toContain("validatetoken");
  });
});
describe("syms context", () => {
  it("builds one-call context with callers and code", () => {
    const syms = extractFileSymbols("src/auth.ts", TS_SAMPLE);
    const ctx = buildCodeContext("login authentication", syms, () => TS_SAMPLE, { maxNodes: 10 });
    expect(ctx.entryPoints.length).toBeGreaterThan(0);
    expect(ctx.blocks.length).toBeGreaterThan(0);
    expect(formatCodeContext(ctx)).toContain("AuthService");
  });
  it("reports ambiguous refs instead of guessing", () => {
    const a = extractFileSymbols("a.ts", "export function dup() { return 1; }\n");
    const b = extractFileSymbols("b.ts", "export function dup() { return 2; }\n Caller: dup();\n");
    const main = extractFileSymbols("main.ts", "import { dup } from './a';\nexport function run() {\n  dup();\n  dup();\n}\n");
    const ctx = buildCodeContext("run dup", [...a, ...b, ...main], (f) => (f === "main.ts" ? "x\ndup();\ndup();\n" : "x"), {
      maxNodes: 5,
    });
    expect(ctx.related.length + ctx.entryPoints.length).toBeGreaterThan(0);
  });
  it("merges overlapping blocks without negative gaps", () => {
    const syms = extractFileSymbols("src/auth.ts", TS_SAMPLE);
    const ctx = buildCodeContext("login", syms, () => TS_SAMPLE, { maxNodes: 10, maxCodeBlocks: 5 });
    const formatted = formatCodeContext(ctx);
    expect(formatted).not.toMatch(/-\d+ lines/);
  });
  it("does not expand ambiguous refs into related", () => {
    const a = extractFileSymbols("a.ts", "export function dup() { return 1; }\n");
    const b = extractFileSymbols("b.ts", "export function dup() { return 2; }\n");
    const main = extractFileSymbols("main.ts", "export function run() {\n  dup();\n}\n");
    const ctx = buildCodeContext("run", [...a, ...b, ...main], () => "x", { maxNodes: 5 });
    expect(ctx.ambiguous.length).toBeGreaterThan(0);
    expect(ctx.related.filter((r) => r.qualified === "dup").length).toBe(0);
  });
});
describe("syms health", () => {
  it("gini is 0 for equal values, high for skewed", () => {
    expect(gini([5, 5, 5, 5])).toBeCloseTo(0, 5);
    expect(gini([1, 1, 1, 100])).toBeGreaterThan(0.5);
  });
  it("fileDepth finds the longest chain", () => {
    const edges = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set<string>([])],
    ]);
    const { depth, chain } = fileDepth(edges);
    expect(depth).toBe(3);
    expect(chain).toEqual(["a", "b", "c"]);
  });
  it("risk penalizes untested complex hotspots", () => {
    const risky = riskScore({ complexity: 10, fanIn: 8, tested: false, churn90d: 30 });
    const safe = riskScore({ complexity: 10, fanIn: 8, tested: true, churn90d: 30 });
    expect(risky).toBeGreaterThan(safe * 5);
  });
  it("finds redundant blocks", () => {
    const code = "function f() { const x = 1; const y = 2; const z = 3; return x + y + z; }";
    const pairs = findRedundantPairs(
      [
        { id: "a", code },
        { id: "b", code },
      ],
      0.5,
    );
    expect(pairs.length).toBe(1);
  });
  it("atomic anchor guard refuses ambiguous matches", () => {
    expect(assertUniqueAnchor("aaa bbb aaa", "aaa").ok).toBe(false);
    expect(assertUniqueAnchor("aaa bbb ccc", "bbb").ok).toBe(true);
    expect(assertUniqueAnchor("aaa", "zzz").ok).toBe(false);
  });
  it("fileDepth on an empty graph is depth zero", () => {
    expect(fileDepth(new Map())).toEqual({ depth: 0, chain: [] });
  });
  it("counts every anchor occurrence", () => {
    expect(countOccurrences("a a a a a", "a")).toBe(5);
  });
});