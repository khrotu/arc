import * as fs from "node:fs";
import * as path from "node:path";
import { getArcDir } from "../arc-dir.js";
import { getOrBackEntries } from "../providers/or-back.js";
export interface AAScores {
  intelligence?: number;
  coding?: number;
  agentic?: number;
}
export interface AAModel {
  name: string;
  slug: string;
  provider: string;
  score?: number;
  aa?: AAScores;
}
const AA_WEIGHTS: Record<keyof AAScores, number> = { intelligence: 0.5, agentic: 0.3, coding: 0.2 };
const CACHE_FILE = "aa-scores.json";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let aaList: AAModel[] = [];
let aaIndexCache: AAIndexEntry[] | undefined;
let aaRefresh: Promise<boolean> | undefined;
function compositeScore(aa: AAScores): number | undefined {
  let num = 0;
  let den = 0;
  for (const key of ["intelligence", "agentic", "coding"] as const) {
    const v = aa[key];
    const w = AA_WEIGHTS[key];
    if (typeof v === "number") {
      num += w * v;
      den += w;
    }
  }
  return den > 0 ? Math.round((num / den) * 10) / 10 : undefined;
}
export function getAAList(): AAModel[] {
  return aaList;
}
export function setAAList(rows: AAModel[]): void {
  aaList = rows;
  aaIndexCache = undefined;
}
const norm = (s: string): string => s.toLowerCase().replace(/[\s._:\-+()/]+/g, "");
interface AAIndexEntry { entry: AAModel; key: string; tokens: string[] }
function getAAIndex(): AAIndexEntry[] {
  if (!aaIndexCache) {
    aaIndexCache = [];
    for (const entry of aaList) {
      if (entry.slug) aaIndexCache.push({ entry, key: norm(entry.slug), tokens: tokenSet(entry.slug) });
      aaIndexCache.push({ entry, key: norm(entry.name), tokens: tokenSet(entry.name) });
    }
  }
  return aaIndexCache;
}
function tokenSet(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function tokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const hit = a.filter((t) => setB.has(t)).length;
  return hit / Math.max(a.length, b.length);
}
export interface AAMatch { entry: AAModel; confidence: number }
export function matchIntelligence(modelId: string, label?: string): AAMatch | undefined {
  const id = norm(modelId);
  const labelNorm = label ? norm(label) : "";
  const index = getAAIndex();
  for (const key of [id, labelNorm].filter(Boolean)) {
    const exact = index.find((x) => x.key === key);
    if (exact) return { entry: exact.entry, confidence: 1 };
  }
  let best: AAMatch | undefined;
  for (const x of index) {
    if (x.key.length >= 8 && id.length >= 8 && (id.includes(x.key) || x.key.includes(id))) {
      const confidence = Math.min(x.key.length / Math.max(id.length, x.key.length), 1);
      if (!best || confidence > best.confidence) best = { entry: x.entry, confidence };
    }
  }
  if (best) return best;
  const labelTokens = label ? label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) : [];
  const idTokens = modelId.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tokens of [labelTokens, idTokens]) {
    if (!tokens.length) continue;
    for (const x of index) {
      const c = tokenOverlap(tokens, x.tokens);
      if (c > 0.6 && (!best || c > best.confidence)) best = { entry: x.entry, confidence: c };
    }
    if (best) return best;
  }
  return undefined;
}
export function lookupIntelligence(modelId: string, label?: string): AAModel | undefined {
  return matchIntelligence(modelId, label)?.entry;
}
export function consolidateOpenRouterModels(text: string): AAModel[] {
  const parsed = JSON.parse(text) as { data?: unknown };
  if (!Array.isArray(parsed.data)) throw new Error("unexpected OpenRouter models payload");
  const best = new Map<string, AAModel>();
  for (const m of parsed.data) {
    const rec = m as { id?: string; name?: string; benchmarks?: { artificial_analysis?: Record<string, number | null> } };
    const id = rec.id ?? "";
    const slash = id.indexOf("/");
    if (slash <= 0) continue;
    const colonAfter = id.indexOf(":", slash);
    const variant = colonAfter > slash ? id.slice(colonAfter) : "";
    const slug = colonAfter > slash ? id.slice(slash + 1, colonAfter) : id.slice(slash + 1);
    if (!slug) continue;
    const raw = rec.benchmarks?.artificial_analysis;
    if (!raw) continue;
    const aa: AAScores = {};
    for (const key of ["intelligence", "agentic", "coding"] as const) {
      const v = raw[`${key}_index`];
      if (typeof v === "number") aa[key] = v;
    }
    const score = compositeScore(aa);
    if (score === undefined) continue;
    const orName = rec.name ?? slug;
    const colon = orName.indexOf(": ");
    const name = colon >= 0 ? orName.slice(colon + 2) : orName;
    if (!name) continue;
    const key = `${norm(name)}${variant}`;
    const prev = best.get(key);
    if (!prev || (prev.score ?? 0) < score) {
      best.set(key, { name: variant ? `${name} (${variant.slice(1)})` : name, slug: variant ? `${slug}${variant}` : slug, provider: id.slice(0, slash), score, aa });
    }
  }
  const rows = [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name));
  return rows;
}
export async function ensureAAList(opts: { fetchImpl?: typeof fetch; dir?: string; ttlMs?: number } = {}): Promise<boolean> {
  if (aaRefresh) return aaRefresh;
  aaRefresh = (async () => {
    const dir = opts.dir ?? path.join(getArcDir(), "router");
    const ttl = opts.ttlMs ?? CACHE_TTL_MS;
    const cachePath = path.join(dir, CACHE_FILE);
    try {
      const cache = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as { fetched?: number; models?: AAModel[] };
      if (typeof cache.fetched === "number" && Array.isArray(cache.models)) {
        setAAList(cache.models.map((m) => ({ ...m, ...(m.aa ? { score: compositeScore(m.aa) } : {}) })));
        if (Date.now() - cache.fetched <= ttl) return false;
      }
} catch {  }
    const entries = await getOrBackEntries({ fetchImpl: opts.fetchImpl, cachePath: path.join(dir, "or-back.json") });
    if (!entries?.length) return false;
    const models = consolidateOpenRouterModels(JSON.stringify({ data: entries }));
    if (models.length < 50) return false;
    setAAList(models);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(cachePath, JSON.stringify({ fetched: Date.now(), models }), { mode: 0o600 });
    return true;
  })().catch(() => false).finally(() => { aaRefresh = undefined; });
  return aaRefresh;
}