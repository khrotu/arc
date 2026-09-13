export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "import";
export interface SymbolCall {
  name: string;
  line: number;
}
export interface CodeSymbol {
  id: string;
  kind: SymbolKind;
  name: string;
  qualified: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  searchTerms: string[];
  calls: SymbolCall[];
  isExported: boolean;
  isTest: boolean;
  complexity: number;
  truncated?: boolean;
}
export const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "java", "kt", "cs", "rb", "php",
  "swift", "c", "h", "cpp", "hpp", "cc", "scala",
]);
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export function stableSymbolId(file: string, kind: string, name: string, line: number): string {
  const a = fnv1a(`${file}:${kind}:${name}:${line}`).toString(16).padStart(8, "0");
  const b = fnv1a(`${name}:${line}:${file}`).toString(16).padStart(8, "0");
  return `${kind}:${a.slice(0, 8)}${b.slice(0, 4)}`;
}
export function splitSearchTerms(name: string): string[] {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+|_+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 2);
  const out = new Set(parts);
  const cjk = name.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]{2,}/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length && out.size < 100; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}
interface PendingDef {
  kind: SymbolKind;
  name: string;
  line: number;
  indent: number;
  isExported: boolean;
  classScope: string;
}
const PATTERNS: { kind: SymbolKind; re: RegExp; nameIdx: number; check?: (line: string, name: string) => boolean }[] = [
  { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/, nameIdx: 1 },
  { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_]+)/, nameIdx: 1 },
  { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=/, nameIdx: 1 },
  { kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_]+)/, nameIdx: 1 },
  { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/, nameIdx: 1 },
  { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?(?:def|fn|func)\s+([A-Za-z0-9_]+)/, nameIdx: 1 },
  { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/, nameIdx: 1 },
  { kind: "const", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\b/, nameIdx: 1, check: (line, name) => {
    const rest = line.slice(line.indexOf(name) + name.length);
    return ARROW_ASSIGN.test(rest) || PLAIN_ASSIGN.test(rest);
  } },
  { kind: "method", re: /^[ \t]*(?:(?:public|private|protected|static|async|override|readonly|abstract|final|synchronized|native|default)\s+){0,4}([A-Za-z0-9_]+)\s*\([^;{}()]*\)\s*[{:]/, nameIdx: 1 },
  { kind: "import", re: /^\s*(?:import|from|use|require)\s+/, nameIdx: -1 },
];
const CALL_RE = /([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*|\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/g;
const ARROW_ASSIGN = /=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=;{}]+?)?\s*=>|[A-Za-z0-9_$]+\s*=>|<[^<>{}]*>\s*\([^)]*\)\s*=>)/;
const PLAIN_ASSIGN = /^\s*(?::[^=;]+)?\s*=\s*\S/;
const TEST_WRAPPERS = new Set(["describe", "it", "test", "expect", "beforeEach", "afterEach", "beforeAll", "afterAll", "vitest", "jest"]);
const DEF_KEYWORDS = new Set(
  "if,for,while,switch,catch,return,import,from,require,foreach,using,lock,do,try,finally,throw,new,delete,typeof,sizeof,nameof,checked,unchecked,fixed,await,yield,else,elif,except,with,class,def,fn,func,function".split(","),
);
function isTestFile(file: string, name: string): boolean {
  const segs = file.replace(/\\/g, "/").toLowerCase().split("/");
  if (segs.some((s) => s === "test" || s === "tests" || s === "__tests__")) return true;
  const base = segs[segs.length - 1] ?? "";
  if (base.includes(".test.") || base.includes(".spec.")) return true;
  if (/^(test_|.*_test\.[^.]+|.*_test)$/i.test(base)) return true;
  return /^(test_|.*_test)$/i.test(name);
}
function indentOf(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].replace(/\t/g, "  ").length : 0;
}
export function extractFileSymbols(file: string, text: string): CodeSymbol[] {
  const lines = text.split(/\r?\n/);
  const pending: PendingDef[] = [];
  let classScope = "";
  const classStack: { name: string; indent: number }[] = [];
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const indent = indentOf(line);
    while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) classStack.pop();
    classScope = classStack.length > 0 ? classStack[classStack.length - 1].name : "";
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (!m) continue;
      if (p.kind === "import") break;
      const name = m[p.nameIdx];
      if (!name || DEF_KEYWORDS.has(name) || name === "if") break;
      if (p.check && !p.check(line, name)) continue;
      if (p.kind === "method" && !classScope && TEST_WRAPPERS.has(name)) break;
      if (p.kind === "method" && !classScope) {
        pending.push({ kind: "function", name, line: lineNo, indent, isExported: /^\s*export\s+/.test(line), classScope: "" });
      } else {
        pending.push({
          kind: p.kind === "method" && classScope ? "method" : p.kind === "method" ? "function" : p.kind,
          name,
          line: lineNo,
          indent,
          isExported: /^\s*export\s+/.test(line) || /^\s*pub\b/.test(line),
          classScope,
        });
      }
      if (p.kind === "class") classStack.push({ name, indent });
      break;
    }
  });
  return pending.map((def, i) => {
    const next = pending[i + 1];
    let endLine = next && next.line > def.line ? Math.min(next.line - 1, def.line + 400) : Math.min(lines.length, def.line + 120);
    if (endLine < def.line) endLine = def.line;
    const clamped = endLine >= def.line + 400 || (next === undefined && endLine >= def.line + 120);
    const qualified = def.classScope ? `${def.classScope}::${def.name}` : def.name;
    const body = lines.slice(def.line - 1, endLine).join("\n");
    const calls = extractCalls(body, def.line, def.name);
    const complexity = countComplexity(body);
    const isTest = isTestFile(file, def.name);
    return {
      id: stableSymbolId(file, def.kind, qualified, def.line),
      kind: def.kind,
      name: def.name,
      qualified,
      file,
      startLine: def.line,
      endLine,
      signature: lines[def.line - 1].trim().slice(0, 200),
      searchTerms: splitSearchTerms(qualified),
      calls,
      isExported: def.isExported,
      isTest,
      complexity,
      ...(clamped ? { truncated: true as const } : {}),
    };
  });
}
function extractCalls(body: string, baseLine: number, selfName: string): SymbolCall[] {
  const out: SymbolCall[] = [];
  const bodyLines = body.split("\n");
  for (let li = 0; li < bodyLines.length; li++) {
    let line = bodyLines[li];
    if (li === 0) {
      const brace = line.indexOf("{");
      if (brace < 0) continue;
      line = line.slice(brace + 1);
    }
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(line)) !== null) {
      const raw = m[1];
      const simple = raw.includes("::") ? raw.split("::").pop()! : raw.includes(".") ? raw.split(".").pop()! : raw;
      if (simple === selfName || DEF_KEYWORDS.has(simple)) continue;
      if (simple.length < 2) continue;
      out.push({ name: simple, line: baseLine + li });
      if (out.length >= 60) return out;
    }
  }
  return out;
}
function countComplexity(body: string): number {
  const branches = (body.match(/\b(if|else|case|catch)\b|&&|\|\||\?/g) ?? []).length;
  const loops = (body.match(/\b(for|while|loop|foreach)\b/g) ?? []).length;
  const fns = (body.match(/\bfunction\b|=>/g) ?? []).length;
  return branches * 2 + loops * 2 + fns + Math.min(10, Math.floor(body.length / 800));
}