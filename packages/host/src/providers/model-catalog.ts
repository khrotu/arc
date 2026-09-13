import { getProviderSpec } from "./catalog.js";
import { createHash } from "node:crypto";
import type { ProviderKind } from "../protocol/protocol.js";
import { attributionHeaders } from "./attribution.js";
import { makeProxyDispatcher } from "../util/proxy.js";
import { getOrBackEntries, type OrBackEntry } from "./or-back.js";
import { readBodyLimited } from "../security/network.js";
export interface ProviderModelEntry {
  slug: string;
  providerId: string;
}
export interface GroupedModel {
  key: string;
  label: string;
  info: OpenRouterModelInfo | undefined;
  providers: ProviderModelEntry[];
}
export interface OpenRouterModelInfo {
  displayName?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  priceInPer1m?: number;
  priceOutPer1m?: number;
  priceCacheReadPer1m?: number;
  priceCacheWritePer1m?: number;
  imageInput?: boolean;
  thinking?: boolean;
}
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function normalizeVersionHyphens(id: string): string {
  return id.replace(/(\d)-(?=\d)/g, "$1.");
}
function normalizeForMatch(id: string): string {
  return normalizeVersionHyphens(id.toLowerCase());
}
function extractDisplayName(rawName: unknown): string | undefined {
  if (typeof rawName !== "string" || !rawName.trim()) return undefined;
  const trimmed = rawName.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx >= 0) {
    const after = trimmed.slice(colonIdx + 1).trim();
    if (after) return after;
  }
  return trimmed;
}
export function isNumericVersionSuffix(suffix: string, prefixPart: string): boolean {
  if (!/^\d+(\.\d+)*$/.test(suffix)) return false;
  if (!prefixPart || !/\d$/.test(prefixPart)) return false;
  return true;
}
export function stripVariantCandidates(id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  push(id);
  const normalized = normalizeVersionHyphens(id);
  if (normalized !== id) push(normalized);
  const lastSlash = id.split("/").pop() ?? id;
  if (lastSlash !== id) push(lastSlash);
  const lastSlashNorm = normalizeVersionHyphens(lastSlash);
  if (lastSlashNorm !== lastSlash) push(lastSlashNorm);
  let current = id;
  while (true) {
    const slashBase = current.split("/").pop() ?? current;
    let bestIdx = -1;
    for (const sep of ["-", ":", ".", "_"]) {
      const idx = slashBase.lastIndexOf(sep);
      if (idx > bestIdx) bestIdx = idx;
    }
    let stripped: string | undefined;
    if (bestIdx > 0) {
      const candidateBase = slashBase.slice(0, bestIdx);
      const suffix = slashBase.slice(bestIdx + 1);
      if (isNumericVersionSuffix(suffix, candidateBase)) {
        const prefix = current.includes("/") ? current.slice(0, current.lastIndexOf("/") + 1) : "";
        const candidate = prefix + candidateBase;
        if (candidate !== current) stripped = candidate;
      } else {
        const prefix = current.includes("/") ? current.slice(0, current.lastIndexOf("/") + 1) : "";
        const candidate = prefix + candidateBase;
        if (candidate !== current) stripped = candidate;
      }
    }
    if (!stripped || stripped === current) break;
    push(stripped);
    const normStripped = normalizeVersionHyphens(stripped);
    if (normStripped !== stripped) push(normStripped);
    const bare = stripped.split("/").pop() ?? stripped;
    if (bare !== stripped) push(bare);
    const bareNorm = normalizeVersionHyphens(bare);
    if (bareNorm !== bare) push(bareNorm);
    current = stripped;
    if (out.length > 20) break;
  }
  return out;
}
export function matchModelInfo(map: Map<string, OpenRouterModelInfo>, modelId: string): OpenRouterModelInfo | undefined {
  const direct = map.get(modelId);
  if (direct) return direct;
  const normalizedId = normalizeVersionHyphens(modelId);
  if (normalizedId !== modelId) {
    const normDirect = map.get(normalizedId);
    if (normDirect) return normDirect;
  }
  let lastSegment = modelId.split("/").pop() ?? modelId;
  const underscoreIdx = lastSegment.indexOf("_");
  if (underscoreIdx > 0) {
    const hfVendor = lastSegment.slice(0, underscoreIdx);
    const hfRest = lastSegment.slice(underscoreIdx + 1);
    const hfCandidate = `${hfVendor}/${hfRest}`;
    const hfHit = map.get(hfCandidate) ?? map.get(normalizeVersionHyphens(hfCandidate));
    if (hfHit) return hfHit;
    lastSegment = hfRest;
  }
  if (lastSegment !== modelId) {
    const bySegment = map.get(lastSegment);
    if (bySegment) return bySegment;
    const normLast = normalizeVersionHyphens(lastSegment);
    if (normLast !== lastSegment) {
      const byNormLast = map.get(normLast);
      if (byNormLast) return byNormLast;
    }
  }
  const lowerId = normalizeForMatch(modelId);
  const lowerSegment = normalizeForMatch(lastSegment);
  for (const [key, value] of map) {
    const lowerKey = normalizeForMatch(key);
    if (lowerKey === lowerId || lowerKey === lowerSegment || lowerKey.endsWith(`/${lowerSegment}`)) return value;
  }
  for (const [key, value] of map) {
    if (normalizeForMatch(key).endsWith(`/${lowerId}`)) return value;
  }
  for (const cand of stripVariantCandidates(modelId)) {
    if (cand === modelId) continue;
    const hit = map.get(cand);
    if (hit) return hit;
    const normCand = normalizeVersionHyphens(cand);
    if (normCand !== cand) {
      const normHit = map.get(normCand);
      if (normHit) return normHit;
    }
    const lc = normalizeForMatch(cand);
    for (const [key, value] of map) {
      const lowerKey = normalizeForMatch(key);
      if (lowerKey === lc || lowerKey.endsWith(`/${lc}`)) return value;
    }
    const candSeg = cand.split("/").pop() ?? cand;
    if (candSeg !== cand) {
      const segHit = map.get(candSeg);
      if (segHit) return segHit;
      const normSeg = normalizeVersionHyphens(candSeg);
      if (normSeg !== candSeg) {
        const normSegHit = map.get(normSeg);
        if (normSegHit) return normSegHit;
      }
      const lcSeg = normalizeForMatch(candSeg);
      for (const [key, value] of map) {
        const lowerKey = normalizeForMatch(key);
        if (lowerKey === lcSeg || lowerKey.endsWith(`/${lcSeg}`)) return value;
      }
    }
  }
  let best: OpenRouterModelInfo | undefined;
  let bestLen = -1;
  for (const [key, value] of map) {
    const lowerKey = key.toLowerCase();
    const lowerKeyBare = lowerKey.split("/").pop() ?? lowerKey;
    if (
      lowerId === lowerKey ||
      lowerId.endsWith(`/${lowerKeyBare}`) ||
      lowerId.endsWith(`/${lowerKey}`)
    ) {
      if (lowerKey.length > bestLen) {
        bestLen = lowerKey.length;
        best = value;
      }
    }
    const lastSeg = lowerId.split("/").pop() ?? lowerId;
    if (lastSeg === lowerKey || lastSeg === lowerKeyBare) {
      if (lowerKey.length > bestLen) {
        bestLen = lowerKey.length;
        best = value;
      }
    }
  }
  return best;
}
function infoFromRaw(entry: OrBackEntry): OpenRouterModelInfo | undefined {
  const id = typeof entry.id === "string" ? entry.id : undefined;
  if (!id) return undefined;
  const contextLength =
    positiveNumber(entry.context_length) ?? positiveNumber(entry.top_provider?.context_length);
  const maxCompletionTokens = positiveNumber(entry.top_provider?.max_completion_tokens);
  const priceIn = typeof entry.pricing?.prompt === "string" ? Number(entry.pricing.prompt) : undefined;
  const priceOut = typeof entry.pricing?.completion === "string" ? Number(entry.pricing.completion) : undefined;
  const priceCacheRead = typeof entry.pricing?.input_cache_read === "string" ? Number(entry.pricing.input_cache_read) : undefined;
  const priceCacheWrite = typeof entry.pricing?.input_cache_write === "string" ? Number(entry.pricing.input_cache_write) : undefined;
  const info: OpenRouterModelInfo = {};
  const displayName = extractDisplayName(entry.name);
  if (displayName) info.displayName = displayName;
  if (contextLength) info.contextLength = contextLength;
  if (maxCompletionTokens) info.maxOutputTokens = maxCompletionTokens;
  if (priceIn !== undefined && Number.isFinite(priceIn) && priceIn >= 0) info.priceInPer1m = toPer1m(priceIn);
  if (priceOut !== undefined && Number.isFinite(priceOut) && priceOut >= 0) info.priceOutPer1m = toPer1m(priceOut);
  if (priceCacheRead !== undefined && Number.isFinite(priceCacheRead) && priceCacheRead >= 0) info.priceCacheReadPer1m = toPer1m(priceCacheRead);
  if (priceCacheWrite !== undefined && Number.isFinite(priceCacheWrite) && priceCacheWrite >= 0) info.priceCacheWritePer1m = toPer1m(priceCacheWrite);
  const mods = entry.architecture?.input_modalities;
  if (Array.isArray(mods) && mods.some((v) => typeof v === "string" && v.toLowerCase() === "image")) info.imageInput = true;
  if (entry.reasoning && typeof entry.reasoning === "object") info.thinking = true;
  return Object.keys(info).length > 0 ? info : undefined;
}
function toPer1m(perToken: number): number {
  return Number((perToken * 1_000_000).toPrecision(12));
}
export function parseOpenRouterCatalogue(json: unknown): Map<string, OpenRouterModelInfo> {
  const maybeData = (json as Record<string, unknown> | undefined)?.["data"];
  const data: unknown[] = Array.isArray(maybeData) ? maybeData : Array.isArray(json) ? (json as unknown[]) : [];
  const map = new Map<string, OpenRouterModelInfo>();
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as OrBackEntry;
    const id = typeof entry.id === "string" ? entry.id : undefined;
    if (!id) continue;
    const info = infoFromRaw(entry);
    if (!info) continue;
    map.set(id, info);
    const slug = typeof entry.canonical_slug === "string" ? entry.canonical_slug : undefined;
    if (slug && slug !== id && !map.has(slug)) map.set(slug, info);
  }
  return map;
}
let infoIndex: Map<string, OpenRouterModelInfo> | undefined;
let infoIndexPromise: Promise<Map<string, OpenRouterModelInfo> | undefined> | undefined;
function indexFromEntries(entries: OrBackEntry[]): Map<string, OpenRouterModelInfo> {
  const map = new Map<string, OpenRouterModelInfo>();
  for (const entry of entries) {
    const info = infoFromRaw(entry);
    if (!info) continue;
    const id = entry.id as string;
    map.set(id, info);
    const slug = typeof entry.canonical_slug === "string" ? entry.canonical_slug : undefined;
    if (slug && slug !== id && !map.has(slug)) map.set(slug, info);
  }
  return map;
}
export async function getModelCatalogue(opts: { force?: boolean; proxyUrl?: string } = {}): Promise<Map<string, OpenRouterModelInfo> | undefined> {
  const force = opts.force === true;
  if (force) {
    infoIndex = undefined;
    infoIndexPromise = undefined;
  }
  if (infoIndex) return infoIndex;
  if (!infoIndexPromise) {
    infoIndexPromise = (async () => {
      try {
        const entries = await getOrBackEntries({ force, proxyUrl: opts.proxyUrl });
        if (entries?.length) infoIndex = indexFromEntries(entries);
        return infoIndex;
      } finally {
        infoIndexPromise = undefined;
      }
    })();
  }
  return infoIndexPromise;
}
const NAME_ACRONYMS = new Set(["glm", "gpt", "llm", "sft", "dpo", "tts", "idf"]);
export function formatFallbackName(id: string): string {
  const last = id.split("/").pop() ?? id;
  let spaced = last.replace(/[-_]+/g, " ").trim();
  spaced = spaced.replace(/(\d)\s+(\d)(?=\s|$)/g, (m, a: string, b: string) => (b.length === 1 ? `${a}.${b}` : m));
  const words = spaced.split(/\s+/);
  const out = words.map((word) => {
    if (/^[A-Z]{2,}$/.test(word)) return word;
    if (NAME_ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
    if (/^\d+(\.\d+)?[a-z]$/i.test(word) && /b$/i.test(word)) return word.toUpperCase();
    if (word === word.toLowerCase()) return word.charAt(0).toUpperCase() + word.slice(1);
    return word;
  });
  if (out.length >= 2) {
    const first = out[0].toLowerCase();
    const second = out[1].toLowerCase();
    if (/^[a-z0-9.]+$/.test(first) && second.startsWith(first) && second.length > first.length) {
      out.shift();
    }
  }
  return out.join(" ");
}
const ALIAS_FIELDS = ["instruct", "thinking", "reasoning", "free", "online", "search", "experimental", "preview", "latest", "exacto", "it", "chat"];
export function aliasKeyForSlug(slug: string): string {
  const normalized = normalizeForMatch(slug);
  const base = normalized.split("/").pop() ?? normalized;
  let out = base;
  for (let pass = 0; pass < ALIAS_FIELDS.length + 1; pass++) {
    let changed = false;
    for (const field of ALIAS_FIELDS) {
      const next = out.replace(new RegExp(`[-_:.]${field}$`), "");
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out.replace(/[-_]+$/, "");
}
const SLUG_LIST_MAX_BYTES = 12 * 1024 * 1024;
export async function listOpenAICompatibleModels(baseUrl: string | undefined, kind: string, apiKey?: string, proxyUrl?: string): Promise<string[] | undefined> {
  const spec = getProviderSpec(kind as never);
  const base = (baseUrl || spec?.defaultBaseUrl || "").replace(/\/$/, "");
  if (!base) return undefined;
  const isAnthropic = kind === "anthropic";
  const isOllama = kind === "ollama";
  const headers: Record<string, string> = { accept: "application/json", ...attributionHeaders(kind as ProviderKind) };
  if (isAnthropic) {
    headers["x-api-key"] = apiKey ?? "";
    headers["anthropic-version"] = "2023-06-01";
  } else if (!isOllama && apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const endpoint = isAnthropic ? `${base}/v1/models` : isOllama ? `${base}/api/tags` : `${base}/models`;
  const init: RequestInit = { method: "GET", headers, signal: AbortSignal.timeout(8_000) };
  if (proxyUrl) (init as Record<string, unknown>).dispatcher = proxyDispatcherFor(proxyUrl);
  try {
    const res = await fetch(endpoint, init);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const text = await readBodyLimited(res, SLUG_LIST_MAX_BYTES);
    const body = JSON.parse(text) as unknown;
    const data = Array.isArray((body as { data?: unknown[] }).data)
      ? (body as { data: unknown[] }).data
      : isOllama && Array.isArray((body as { models?: unknown[] }).models)
        ? (body as { models: unknown[] }).models
        : Array.isArray(body)
          ? (body as unknown[])
          : [];
    const slugs: string[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      if (typeof m.id === "string" && m.id) slugs.push(m.id);
      else if (typeof m.name === "string" && m.name) slugs.push(m.name);
    }
    return slugs.length ? slugs : undefined;
  } catch {
    return undefined;
  }
}
function proxyDispatcherFor(url: string): unknown {
  try {
    return makeProxyDispatcher(url);
  } catch {
    return undefined;
  }
}
export interface SlugSource {
  providerId: string;
  kind: string;
  baseUrl?: string;
  apiKey?: string;
}
const slugCache = new Map<string, { at: number; slugs: string[] }>();
const slugInflight = new Map<string, Promise<string[]>>();
export const SLUG_CACHE_TTL_MS = 5 * 60 * 1000;
function slugCacheKey(source: SlugSource): string {
  const keyFp = source.apiKey ? `|k:${fingerprintKey(source.apiKey)}` : "";
  return `${source.providerId}|${source.kind}|${source.baseUrl ?? ""}${keyFp}`;
}
function fingerprintKey(apiKey: string): string {
  try {
    return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  } catch {
    return `len${apiKey.length}`;
  }
}
function cacheSlugs(key: string, slugs: string[]): void {
  slugCache.set(key, { at: Date.now(), slugs });
  while (slugCache.size > 50) {
    const oldest = slugCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    slugCache.delete(oldest);
  }
}
export function clearProviderSlugCache(): void {
  slugCache.clear();
  slugInflight.clear();
}
export async function listProviderModelSlugs(source: SlugSource, proxyUrl?: string, opts: { force?: boolean } = {}): Promise<string[]> {
  const force = opts.force === true;
  const key = slugCacheKey(source);
  if (!force) {
    const hit = slugCache.get(key);
    if (hit && Date.now() - hit.at < SLUG_CACHE_TTL_MS) return hit.slugs;
  }
  const pending = slugInflight.get(key);
  if (pending && !force) return pending;
  let taskRef: Promise<string[]> | undefined;
  const task = (async () => {
    try {
      const fetched = await listOpenAICompatibleModels(source.baseUrl, source.kind, source.apiKey, proxyUrl);
      if (fetched === undefined) return [];
      cacheSlugs(key, fetched);
      return fetched;
    } finally {
      if (slugInflight.get(key) === taskRef) slugInflight.delete(key);
    }
  })();
  taskRef = task;
  slugInflight.set(key, task);
  return task;
}
export async function groupProviderModels(entries: ProviderModelEntry[], info?: Map<string, OpenRouterModelInfo>, opts?: { force?: boolean; proxyUrl?: string }): Promise<GroupedModel[]> {
  const catalogue = info ?? (await getModelCatalogue(opts));
  const groups = new Map<string, GroupedModel>();
  for (const entry of entries) {
    const key = aliasKeyForSlug(entry.slug);
    let group = groups.get(key);
    if (!group) {
      const resolved = catalogue ? matchModelInfo(catalogue, entry.slug) : undefined;
      group = {
        key,
        label: resolved?.displayName ?? formatFallbackName(entry.slug),
        info: resolved,
        providers: [],
      };
      groups.set(key, group);
    }
    if (!group.providers.some((p) => p.providerId === entry.providerId && p.slug === entry.slug)) {
      group.providers.push(entry);
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}