import * as fs from "node:fs";
import * as path from "node:path";
import { getArcDir } from "../arc-dir.js";
import { makeProxyDispatcher } from "../util/proxy.js";
import { readBodyLimited, safeFetch } from "../security/network.js";
import { hostWarn } from "../log/logger.js";
export interface OrBackEntry {
  id?: string;
  canonical_slug?: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  supported_parameters?: string[];
  reasoning?: unknown;
  benchmarks?: { artificial_analysis?: Record<string, number | null> };
}
export const OR_BACK_URL = "https://openrouter.ai/api/v1/models";
const OR_BACK_TTL_MS = 24 * 60 * 60 * 1000;
const OR_BACK_MAX_BYTES = 16 * 1024 * 1024;
export interface OrBackOptions {
  proxyUrl?: string;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  ttlMs?: number;
  force?: boolean;
}
const caches = new Map<string, { at: number; entries: OrBackEntry[] }>();
const inflight = new Map<string, Promise<OrBackEntry[] | undefined>>();
let lastFetchError: string | undefined;
export function lastOrBackFetchError(): string | undefined {
  return lastFetchError;
}
function defaultCachePath(): string {
  return path.join(getArcDir(), "or-back.json");
}
export function parseOrBack(json: unknown): OrBackEntry[] {
  const data = (json as { data?: unknown } | undefined)?.data;
  const arr = Array.isArray(data) ? data : Array.isArray(json) ? (json as unknown[]) : [];
  return arr.filter((x): x is OrBackEntry => !!x && typeof x === "object" && !Array.isArray(x));
}
export async function getOrBackEntries(opts: OrBackOptions = {}): Promise<OrBackEntry[] | undefined> {
  const cachePath = opts.cachePath ?? defaultCachePath();
  const ttl = opts.ttlMs ?? OR_BACK_TTL_MS;
  if (!opts.force) {
    const hit = caches.get(cachePath);
    if (hit && Date.now() - hit.at < ttl) return hit.entries;
  }
  const existing = inflight.get(cachePath);
  if (existing && !opts.force) return existing;
  let taskRef: Promise<OrBackEntry[] | undefined> | undefined;
  const task = (async () => {
    let fallback: OrBackEntry[] | undefined = caches.get(cachePath)?.entries;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as { fetched?: unknown; data?: unknown };
      const fetched = typeof parsed.fetched === "number" ? parsed.fetched : undefined;
      const entries = Array.isArray(parsed.data) ? (parsed.data as OrBackEntry[]) : undefined;
      if (fetched && entries?.length) {
        fallback = entries;
        caches.set(cachePath, { at: fetched, entries });
        if (!opts.force && Date.now() - fetched < ttl) return entries;
      }
    } catch {  }
    try {
      const init: RequestInit = { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) };
      if (opts.proxyUrl) (init as Record<string, unknown>).dispatcher = makeProxyDispatcher(opts.proxyUrl);
      const res = opts.fetchImpl
        ? await opts.fetchImpl(OR_BACK_URL, init)
        : await safeFetch(OR_BACK_URL, init);
      if (!res.ok) throw new Error(`or-back download failed (${res.status})`);
      const entries = parseOrBack(JSON.parse(await readBodyLimited(res, OR_BACK_MAX_BYTES)));
      if (!entries.length) throw new Error("empty or-back payload");
      lastFetchError = undefined;
      caches.set(cachePath, { at: Date.now(), entries });
      try {
        await fs.promises.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(cachePath, JSON.stringify({ fetched: Date.now(), data: entries }), { encoding: "utf-8", mode: 0o600 });
      } catch {  }
      return entries;
    } catch (e) {
      lastFetchError = (e as Error)?.message ?? String(e);
      if (opts.force) hostWarn(`[arc] or-back reload failed, serving cached data from ${cachePath}: ${lastFetchError}`);
      return fallback;
    } finally {
      if (inflight.get(cachePath) === taskRef) inflight.delete(cachePath);
    }
  })();
  taskRef = task;
  inflight.set(cachePath, task);
  return task;
}