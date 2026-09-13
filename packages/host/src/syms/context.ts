import type { CodeSymbol } from "./extract.js";
import { rankSymbols } from "./rank.js";
const CROSS_FILE_BLOCKLIST = new Set(
  "result,option,string,clone,new,iter,len,push,run,init,open,spawn,send,recv,get,set,map,filter,foreach,log,info,warn,error,assert,require,println,print,format,to_string,from,into,default".split(
    ",",
  ),
);
export interface ContextOptions {
  maxNodes?: number;
  includeCode?: boolean;
  maxCodeBlocks?: number;
  maxCodeLines?: number;
  maxBytesPerBlock?: number;
}
export interface ContextBlock {
  file: string;
  startLine: number;
  endLine: number;
  code: string;
  symbol: string;
}
export interface CodeContext {
  query: string;
  entryPoints: { id: string; qualified: string; file: string; line: number; score: number }[];
  related: { id: string; qualified: string; file: string; line: number; via: string }[];
  blocks: ContextBlock[];
  ambiguous: { ref: string; candidates: string[] }[];
  filesTouched: string[];
}
export type FileReader = (file: string) => string | undefined;
function resolveTargets(
  name: string,
  byName: Map<string, CodeSymbol[]>,
): { targets: CodeSymbol[]; ambiguous: boolean } {
  const cands = byName.get(name.toLowerCase()) ?? [];
  if (cands.length === 0) return { targets: [], ambiguous: false };
  if (cands.length === 1) return { targets: cands, ambiguous: false };
  return { targets: cands, ambiguous: true };
}
function mergeAdjacent(blocks: ContextBlock[], gap = 5): ContextBlock[] {
  const byFile = new Map<string, ContextBlock[]>();
  for (const b of blocks) {
    const arr = byFile.get(b.file) ?? [];
    arr.push(b);
    byFile.set(b.file, arr);
  }
  const out: ContextBlock[] = [];
  for (const arr of byFile.values()) {
    arr.sort((a, b) => a.startLine - b.startLine);
    let cur = arr[0];
    let curLines = cur.code.split("\n");
    for (let i = 1; i < arr.length; i++) {
      const next = arr[i];
      const space = next.startLine - cur.endLine;
      if (space <= gap) {
        const nextLines = next.code.split("\n");
        const overlap = Math.max(0, cur.endLine - next.startLine + 1);
        const extra = nextLines.slice(overlap);
        const marker = space > 0 ? [`${commentMarkerFor(cur.file)} ... ${space} lines ...`] : [];
        curLines = [...curLines, ...marker, ...extra];
        cur = {
          file: cur.file,
          startLine: cur.startLine,
          endLine: Math.max(cur.endLine, next.endLine),
          code: curLines.join("\n"),
          symbol: `${cur.symbol},${next.symbol}`,
        };
      } else {
        out.push(cur);
        cur = next;
        curLines = cur.code.split("\n");
      }
    }
    out.push(cur);
  }
  return out;
}
export function buildCodeContext(
  query: string,
  symbols: CodeSymbol[],
  readFile: FileReader,
  opts: ContextOptions = {},
): CodeContext {
  const maxNodes = opts.maxNodes ?? 20;
  const includeCode = opts.includeCode ?? true;
  const maxBlocks = opts.maxCodeBlocks ?? 5;
  const maxLines = opts.maxCodeLines ?? 120;
  const maxBytes = opts.maxBytesPerBlock ?? 6000;
  const ranked = rankSymbols(query, symbols, maxNodes * 2);
  const entryIds = new Set(ranked.slice(0, maxNodes).map((r) => r.symbol.id));
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const byName = new Map<string, CodeSymbol[]>();
  for (const s of symbols) {
    const arr = byName.get(s.name.toLowerCase()) ?? [];
    arr.push(s);
    byName.set(s.name.toLowerCase(), arr);
  }
  const related: CodeContext["related"] = [];
  const ambiguous: CodeContext["ambiguous"] = [];
  const seen = new Set(entryIds);
  const callersByName = new Map<string, CodeSymbol[]>();
  for (const s of symbols) {
    for (const c of s.calls) {
      const key = c.name.toLowerCase();
      const arr = callersByName.get(key) ?? [];
      if (!arr.some((x) => x.id === s.id)) arr.push(s);
      callersByName.set(key, arr);
    }
  }
  for (const r of ranked.slice(0, maxNodes)) {
    const sym = r.symbol;
    for (const call of sym.calls.slice(0, 20)) {
      if (CROSS_FILE_BLOCKLIST.has(call.name.toLowerCase())) continue;
      const { targets, ambiguous: amb } = resolveTargets(call.name, byName);
      if (amb && targets.length > 1) {
        if (!ambiguous.some((a) => a.ref === call.name)) {
          ambiguous.push({ ref: call.name, candidates: targets.slice(0, 5).map((t) => t.qualified) });
        }
        continue;
      }
      for (const t of targets.slice(0, 3)) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        related.push({ id: t.id, qualified: t.qualified, file: t.file, line: t.startLine, via: `called by ${sym.qualified}` });
      }
    }
    if (CROSS_FILE_BLOCKLIST.has(sym.name.toLowerCase())) continue;
    for (const s of callersByName.get(sym.name.toLowerCase()) ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      related.push({ id: s.id, qualified: s.qualified, file: s.file, line: s.startLine, via: `calls ${sym.qualified}` });
      if (related.length > maxNodes * 2) break;
    }
  }
  const blocks: ContextBlock[] = [];
  if (includeCode) {
    const fileCache = new Map<string, string[]>();
    const getLines = (file: string): string[] | undefined => {
      let lines = fileCache.get(file);
      if (!lines) {
        const text = readFile(file);
        if (text === undefined) return undefined;
        lines = text.split(/\r?\n/);
        fileCache.set(file, lines);
      }
      return lines;
    };
    const pushBlock = (sym: CodeSymbol): void => {
      if (blocks.length >= maxBlocks) return;
      const lines = getLines(sym.file);
      if (!lines || sym.startLine > lines.length) return;
      const start = Math.max(1, sym.startLine);
      let end = Math.min(lines.length, sym.endLine, start + maxLines - 1);
      let code = lines.slice(start - 1, end).join("\n");
      if (code.length > maxBytes) {
        code = code.slice(0, maxBytes);
        const cut = code.lastIndexOf("\n");
        if (cut > 0) code = code.slice(0, cut);
        end = start + code.split("\n").length - 1;
        code += `\n${commentMarkerFor(sym.file)} ... truncated ...`;
      } else if (end < sym.endLine) code += `\n${commentMarkerFor(sym.file)} ... (symbol continues past line ${end}) ...`;
      blocks.push({ file: sym.file, startLine: start, endLine: end, code, symbol: sym.qualified });
    };
    for (const r of ranked.slice(0, Math.min(maxBlocks, maxNodes))) pushBlock(r.symbol);
    for (const rel of related) {
      if (blocks.length >= maxBlocks) break;
      const sym = byId.get(rel.id);
      if (sym) pushBlock(sym);
    }
  }
  const merged = mergeAdjacent(blocks);
  const filesTouched = [...new Set([...ranked.slice(0, maxNodes).map((r) => r.symbol.file), ...related.map((r) => r.file)])];
  return {
    query,
    entryPoints: ranked.slice(0, maxNodes).map((r) => ({
      id: r.symbol.id,
      qualified: r.symbol.qualified,
      file: r.symbol.file,
      line: r.symbol.startLine,
      score: Math.round(r.score * 100) / 100,
    })),
    related: related.slice(0, maxNodes * 2),
    blocks: merged.slice(0, maxBlocks),
    ambiguous: ambiguous.slice(0, 10),
    filesTouched,
  };
}
export function commentMarkerFor(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (["py", "sh", "bash", "rb", "r", "toml", "yaml", "yml", "mk"].includes(ext) || file === "Makefile") return "#";
  if (["sql", "lua", "hs"].includes(ext)) return "--";
  return "//";
}
export function formatCodeContext(ctx: CodeContext): string {
  const out: string[] = [];
  out.push(`Context for: ${ctx.query}`);
  out.push(`Entry points (${ctx.entryPoints.length}):`);
  for (const e of ctx.entryPoints) out.push(`- ${e.qualified} (${e.file}:${e.line})`);
  if (ctx.related.length > 0) {
    out.push(`Related (${ctx.related.length}):`);
    for (const r of ctx.related.slice(0, 15)) out.push(`- ${r.qualified} (${r.file}:${r.line}) [${r.via}]`);
  }
  for (const b of ctx.blocks) {
    const ext = b.file.split(".").pop() ?? "";
    const safe = b.code.replace(/```/g, "~~~");
    out.push(`\n${b.file}:${b.startLine}-${b.endLine} (${b.symbol})\n\`\`\`${ext}\n${safe}\n\`\`\``);
  }
  if (ctx.ambiguous.length > 0) {
    out.push(`Ambiguous refs (not resolved, candidates shown):`);
    for (const a of ctx.ambiguous) out.push(`- ${a.ref}: ${a.candidates.join(", ")}`);
  }
  return out.join("\n");
}