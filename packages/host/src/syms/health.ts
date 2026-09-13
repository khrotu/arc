export function gini(values: number[]): number {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0);
  const n = xs.length;
  if (n === 0) return 0;
  const sum = xs.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * sorted[i];
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}
export function giniLabel(g: number): string {
  if (g < 0.2) return "healthy";
  if (g < 0.4) return "uneven";
  if (g < 0.6) return "concentrated";
  return "extreme";
}
export function fileDepth(fileEdges: Map<string, Set<string>>): { depth: number; chain: string[] } {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  let counter = 0;
  let compCount = 0;
  const nodes = new Set<string>(fileEdges.keys());
  for (const tos of fileEdges.values()) for (const to of tos) nodes.add(to);
  if (nodes.size === 0) return { depth: 0, chain: [] };
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
    while (work.length > 0) {
      const top = work[work.length - 1];
      if (!index.has(top.v)) {
        index.set(top.v, counter);
        low.set(top.v, counter);
        counter++;
        stack.push(top.v);
        onStack.add(top.v);
      }
      const succs = [...(fileEdges.get(top.v) ?? [])];
      if (top.i < succs.length) {
        const w = succs[top.i];
        top.i++;
        if (!index.has(w)) {
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        }
      } else {
        if (low.get(top.v) === index.get(top.v)) {
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.set(w, compCount);
          } while (w !== top.v);
          compCount++;
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
        }
      }
    }
  }
  const dag = new Map<number, Set<number>>();
  const indeg = new Map<number, number>();
  for (const [from, tos] of fileEdges) {
    const cf = comp.get(from);
    if (cf === undefined) continue;
    for (const to of tos) {
      const ct = comp.get(to);
      if (ct === undefined || cf === ct) continue;
      if (!dag.has(cf)) dag.set(cf, new Set());
      if (!dag.get(cf)!.has(ct)) {
        dag.get(cf)!.add(ct);
        indeg.set(ct, (indeg.get(ct) ?? 0) + 1);
      }
      if (!indeg.has(cf)) indeg.set(cf, indeg.get(cf) ?? 0);
    }
  }
  const compMembers = new Map<number, string[]>();
  for (const [node, c] of comp) {
    const arr = compMembers.get(c) ?? [];
    arr.push(node);
    compMembers.set(c, arr);
  }
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const queue: number[] = [];
  for (const [c, d] of indeg) {
    dist.set(c, 1);
    if (d === 0) queue.push(c);
  }
  if (queue.length === 0 && compCount > 0) {
    for (let c = 0; c < compCount; c++) {
      dist.set(c, 1);
      queue.push(c);
    }
  }
  let best = 1;
  let bestComp = queue[0] ?? 0;
  while (queue.length > 0) {
    const c = queue.shift()!;
    for (const nxt of dag.get(c) ?? []) {
      const cand = (dist.get(c) ?? 1) + 1;
      if (cand > (dist.get(nxt) ?? 0)) {
        dist.set(nxt, cand);
        prev.set(nxt, c);
        if (cand > best) {
          best = cand;
          bestComp = nxt;
        }
      }
      indeg.set(nxt, (indeg.get(nxt) ?? 1) - 1);
      if (indeg.get(nxt) === 0) queue.push(nxt);
    }
  }
  const chain: string[] = [];
  if (compCount === 0) return { depth: 0, chain };
  let cur: number | undefined = bestComp;
  while (cur !== undefined) {
    const members = compMembers.get(cur) ?? [];
    chain.unshift(members[0] ?? `component:${cur}`);
    cur = prev.get(cur);
  }
  return { depth: Math.max(1, best), chain };
}
export interface RiskInput {
  complexity: number;
  fanIn: number;
  tested: boolean;
  churn90d: number;
}
export function riskScore(r: RiskInput): number {
  const churnFactor = Math.log2(Math.max(0, r.churn90d) + 2);
  return (r.complexity + 1) * (r.fanIn + 1) * (r.tested ? 0.1 : 1) * churnFactor;
}
function normalizeForShingles(code: string): string[] {
  return code
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"([^"\\]|\\.)*"/g, '"STR"')
    .replace(/'([^'\\]|\\.)*'/g, "'STR'")
    .replace(/`([^`\\]|\\.)*`/g, "`STR`")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
}
function shingles(tokens: string[], k = 5): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= tokens.length; i++) out.add(tokens.slice(i, i + k).join(" "));
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
export interface RedundantPair {
  a: string;
  b: string;
  similarity: number;
}
export function findRedundantPairs(
  blocks: { id: string; code: string }[],
  threshold = 0.7,
  maxPairs = 20,
): RedundantPair[] {
  const shingled = blocks.map((b) => ({ id: b.id, s: shingles(normalizeForShingles(b.code)) }));
  const pairs: RedundantPair[] = [];
  const bySize = [...shingled].sort((a, b) => a.s.size - b.s.size);
  for (let x = 0; x < bySize.length && pairs.length < maxPairs; x++) {
    for (let y = x + 1; y < bySize.length && pairs.length < maxPairs; y++) {
      const small = bySize[x].s.size;
      const large = bySize[y].s.size;
      if (large === 0 || small / large < threshold) break;
      const sim = jaccard(bySize[x].s, bySize[y].s);
      if (sim >= threshold) {
        pairs.push({ a: bySize[x].id, b: bySize[y].id, similarity: Math.round(sim * 100) / 100 });
      }
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length || 1;
  }
  return count;
}
export function assertUniqueAnchor(
  fileContent: string,
  anchor: string,
): { ok: true } | { ok: false; matches: number; message: string } {
  const matches = countOccurrences(fileContent, anchor);
  if (matches === 1) return { ok: true };
  if (matches === 0) return { ok: false, matches, message: "Anchor not found: no text was changed." };
  return { ok: false, matches, message: `Anchor matches ${matches} locations: include more surrounding lines to make it unique. No text was changed.` };
}