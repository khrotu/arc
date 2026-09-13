export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
const STOP = new Set(
  "the,a,an,and,or,of,to,in,on,for,with,from,show,find,list,get,all,please,how,what,why,where,which,that,this,these,those,is,are,was,were,be,by,as,at,it,its,into".split(
    ",",
  ),
);
const CJK_RUN = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]{2,}/g;
export function tokenizeForBm25(text: string): string[] {
  const out = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
  CJK_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CJK_RUN.exec(text)) !== null) {
    const run = m[0];
    for (let i = 0; i + 1 < run.length && out.length < 500; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}
const MUST_KEEP_WORDS =
  /\b(not|never|no|must|should|always|only|required|without|unless|error|fatal|exception|failed|denied|invalid|timeout|panic)\b/i;
const SHAPE_STRONG = /[A-Z]{2,}|[a-z]+[A-Z][a-zA-Z]*|\/[^\s]*|--?[a-z][\w-]*/;
export function mustKeepWeight(text: string): number {
  if (MUST_KEEP_WORDS.test(text)) return 1000;
  if (SHAPE_STRONG.test(text)) return 5;
  if (/\d/.test(text)) return 1;
  return 0;
}
export function isMustKeep(text: string): boolean {
  return mustKeepWeight(text) > 0;
}
export interface Bm25Corpus {
  docs: string[][];
  docLen: number[];
  avgLen: number;
  idf: Map<string, number>;
}
export function buildCorpus(rows: string[]): Bm25Corpus {
  const docs = rows.map(tokenizeForBm25);
  const docLen = docs.map((d) => d.length || 1);
  const avgLen = docLen.reduce((a, b) => a + b, 0) / Math.max(1, docLen.length);
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = Math.max(1, docs.length);
  const idf = new Map<string, number>();
  for (const [t, f] of df) idf.set(t, Math.log((n - f + 0.5) / (f + 0.5) + 1));
  return { docs, docLen, avgLen: avgLen || 1, idf };
}
export function scoreDoc(query: string[], doc: string[], docLen: number, avgLen: number, idf: Map<string, number>): number {
  const tf = new Map<string, number>();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  const uq = [...new Set(query)];
  for (const q of uq) {
    const f = tf.get(q) ?? 0;
    if (!f) continue;
    const w = idf.get(q) ?? 0;
    score += (w * f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / avgLen));
  }
  for (const q of uq) {
    if (q.length >= 8 && tf.has(q)) score += 0.3;
  }
  return score;
}
export function buildRelevanceQuery(prompt: string, toolName: string, toolArgs = ""): string[] {
  return tokenizeForBm25(`${prompt} ${toolName} ${toolArgs}`.slice(0, 4000));
}
export function segmentBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (cur.length > 0) {
        blocks.push(cur.join("\n"));
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) blocks.push(cur.join("\n"));
  return blocks.length > 0 ? blocks : [text];
}
export interface KeepPlan {
  keep: number[];
  dropped: number;
}
export type KeepBias = "front" | "back" | "none";
export function planKeep(
  rows: string[],
  queryTokens: string[],
  keepCount: number,
  bias: KeepBias = "front",
): KeepPlan {
  if (!(keepCount >= 1)) return { keep: rows.map((_, i) => i), dropped: 0 };
  keepCount = Math.floor(keepCount);
  if (rows.length <= keepCount) return { keep: rows.map((_, i) => i), dropped: 0 };
  const corpus = buildCorpus(rows);
  const scored = rows.map((row, i) => {
    let s = scoreDoc(queryTokens, corpus.docs[i], corpus.docLen[i], corpus.avgLen, corpus.idf);
    s += mustKeepWeight(row);
    if (bias === "front") s += (rows.length - i) / rows.length / 1000;
    else if (bias === "back") s += (i + 1) / rows.length / 1000;
    return { i, s };
  });
  if (bias === "none" && scored.length > 0 && scored.every((s) => s.s === scored[0].s)) {
    const step = rows.length / keepCount;
    const keep = Array.from({ length: keepCount }, (_, k) => Math.min(rows.length - 1, Math.floor(k * step))).sort((a, b) => a - b);
    return { keep: [...new Set(keep)], dropped: rows.length - new Set(keep).size };
  }
  scored.sort((a, b) => b.s - a.s);
  const keep = scored
    .slice(0, keepCount)
    .map((s) => s.i)
    .sort((a, b) => a - b);
  return { keep, dropped: rows.length - keep.length };
}