import type { CodeSymbol } from "./extract.js";
const STOP = new Set(
  "the,a,an,and,or,of,to,in,on,for,with,from,show,find,list,get,all,please,how,what,why,where,which,that,this,these,those,is,are,was,were,be,by,as,at,it,its,into,implement,create,add,fix,update,using,use,used,file,code,function,class".split(
    ",",
  ),
);
export function tokenizeQuery(text: string): string[] {
  const out = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
  const cjk = text.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]{2,}/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length && out.length < 500; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}
export function extractSymbolTokens(query: string): string[] {
  const out = new Set<string>();
  const cjkRuns = query.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    out.add(run.toLowerCase());
    for (let i = 0; i + 1 < run.length && out.size < 200; i++) out.add(run.slice(i, i + 2).toLowerCase());
  }
  const re = /[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const raw = m[0];
    if (raw.includes("::")) {
      for (const part of raw.split("::")) if (part.length >= 3) out.add(part.toLowerCase());
      out.add(raw.split("::").pop()!.toLowerCase());
    } else if (/[A-Z]/.test(raw) || raw.includes("_")) {
      out.add(raw.toLowerCase());
      for (const p of raw
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/_|\s+/)
        .map((s) => s.toLowerCase())) {
        if (p.length >= 3 && !STOP.has(p)) out.add(p);
      }
    } else if (raw.length >= 3 && !STOP.has(raw.toLowerCase())) {
      out.add(raw.toLowerCase());
    }
  }
  return [...out];
}
export function expandBigrams(tokens: string[]): string[] {
  const out = new Set(tokens);
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    out.add(`${a}${b}`);
    out.add(`${a}${b[0].toUpperCase()}${b.slice(1)}`);
    out.add(`${a}_${b}`);
  }
  return [...out];
}
export function extractPhrases(query: string): string[] {
  const out: string[] = [];
  const re = /"([^"]{8,})"|`([^`]{8,})`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) out.push((m[1] ?? m[2]).toLowerCase());
  return out;
}
const KIND_BOOST: Record<string, number> = {
  function: 2.0,
  method: 2.0,
  class: 1.5,
  interface: 1.5,
  type: 1.5,
  enum: 1.4,
  const: 1.0,
  import: 0.2,
};
function pathBoost(file: string): number {
  const f = file.toLowerCase().replace(/\\/g, "/");
  if (f.includes("node_modules") || f.includes("/vendor/") || f.includes("/dist/")) return 0.4;
  if (f.includes("/docs/") || f.endsWith(".md")) return 0.3;
  if (/(^|\/)(test|tests|__tests__)\//.test(f) || f.includes(".test.") || f.includes(".spec.")) return 0.4;
  if (f.includes("/examples/")) return 0.6;
  if (/(^|\/)(src|app|lib)\//.test(f)) return 1.25;
  return 1.0;
}
export interface RankedSymbol {
  symbol: CodeSymbol;
  score: number;
}
export function scoreSymbol(
  symbol: CodeSymbol,
  queryTokens: Set<string>,
  symbolTokens: Set<string>,
  fanIn: number,
): number {
  let score = 0;
  const nameLower = symbol.name.toLowerCase();
  const qualLower = symbol.qualified.toLowerCase();
  if (symbolTokens.has(nameLower) || symbolTokens.has(qualLower)) score += 100;
  for (const t of symbol.searchTerms) {
    if (queryTokens.has(t)) score += 5;
  }
  const sigTokens = new Set(symbol.signature.toLowerCase().split(/[^a-z0-9_]+/));
  const sigCjk = symbol.signature.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]{2,}/g) ?? [];
  for (const run of sigCjk) {
    for (let i = 0; i + 1 < run.length; i++) sigTokens.add(run.slice(i, i + 2));
  }
  for (const q of queryTokens) if (sigTokens.has(q)) score += 1.5;
  score *= KIND_BOOST[symbol.kind] ?? 1.0;
  score *= symbol.isExported ? 1.5 : 0.9;
  score *= pathBoost(symbol.file);
  if (symbol.isTest) score *= 0.4;
  score *= 1 + Math.min(Math.log2(fanIn + 1), 4) / 4;
  return score;
}
export function computeFanIn(symbols: CodeSymbol[]): Map<string, number> {
  const byName = new Map<string, CodeSymbol[]>();
  for (const s of symbols) {
    const arr = byName.get(s.name.toLowerCase()) ?? [];
    arr.push(s);
    byName.set(s.name.toLowerCase(), arr);
  }
  const fanIn = new Map<string, number>();
  for (const s of symbols) fanIn.set(s.id, 0);
  for (const s of symbols) {
    for (const c of s.calls) {
      const targets = byName.get(c.name.toLowerCase()) ?? [];
      for (const t of targets) {
        if (t.id === s.id) continue;
        fanIn.set(t.id, (fanIn.get(t.id) ?? 0) + 1);
      }
    }
  }
  return fanIn;
}
export function rankSymbols(
  query: string,
  symbols: CodeSymbol[],
  maxResults = 20,
  maxPerFile?: number,
): RankedSymbol[] {
  const tokens = new Set(expandBigrams(tokenizeQuery(query)));
  const symToks = new Set(extractSymbolTokens(query).map((t) => t.toLowerCase()));
  const phrases = extractPhrases(query);
  const fanIn = computeFanIn(symbols);
  const ranked = symbols.map((symbol) => {
    let score = scoreSymbol(symbol, tokens, symToks, fanIn.get(symbol.id) ?? 0);
    for (const ph of phrases) {
      if (symbol.signature.toLowerCase().includes(ph)) score += 50;
    }
    return { symbol, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  const perFile = new Map<string, number>();
  const cap = maxPerFile ?? Math.max(3, Math.floor(maxResults / 3));
  const out: RankedSymbol[] = [];
  for (const r of ranked) {
    if (r.score <= 0) continue;
    const n = perFile.get(r.symbol.file) ?? 0;
    if (n >= cap) continue;
    perFile.set(r.symbol.file, n + 1);
    out.push(r);
    if (out.length >= maxResults) break;
  }
  return out;
}