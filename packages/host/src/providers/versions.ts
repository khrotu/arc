import * as fs from "node:fs";
import * as path from "node:path";
import { getArcDir } from "../arc-dir.js";
import { makeProxyDispatcher } from "../util/proxy.js";
import { readBodyLimited, safeFetch } from "../security/network.js";
import { setOpencodeVer } from "./attribution.js";
export const VERSIONS_URL = "https://api.github.com/repos/anomalyco/opencode/releases/latest";
export const VERSIONS_FILE = "versions.json";
const VERSIONS_TTL_MS = 24 * 60 * 60 * 1000;
const VERSIONS_MAX_BYTES = 64 * 1024;
export interface VersionsOptions {
  proxyUrl?: string;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  ttlMs?: number;
}
let mem: { at: number; ver: string } | undefined;
let inflight: Promise<string | undefined> | undefined;
function defaultCachePath(): string {
  return path.join(getArcDir(), VERSIONS_FILE);
}
export function parseOpencodeVer(json: unknown): string | undefined {
  const rec = (json ?? {}) as { tag_name?: unknown; name?: unknown };
  const raw = typeof rec.tag_name === "string" ? rec.tag_name : typeof rec.name === "string" ? rec.name : undefined;
  if (!raw) return undefined;
  const ver = raw.trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(ver)) return undefined;
  return ver;
}
export function getOpencodeVerSync(): string | undefined {
  return mem?.ver;
}
async function readCache(cachePath: string): Promise<{ at: number; ver: string } | undefined> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as { fetched?: unknown; data?: unknown };
    const fetched = typeof parsed.fetched === "number" ? parsed.fetched : undefined;
    const data = (parsed.data ?? {}) as { opencode?: unknown };
    if (typeof fetched === "number" && typeof data.opencode === "string" && parseOpencodeVer({ tag_name: data.opencode })) {
      return { at: fetched, ver: data.opencode };
    }
  } catch {}
  return undefined;
}
async function writeCache(cachePath: string, ver: string): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(cachePath, JSON.stringify({ fetched: Date.now(), data: { opencode: ver } }), { encoding: "utf-8", mode: 0o600 });
  } catch {}
}
export async function refreshOpencodeVer(opts: VersionsOptions = {}): Promise<string | undefined> {
  if (inflight) return inflight;
  let taskRef: Promise<string | undefined> | undefined;
  const task = (async () => {
    const cachePath = opts.cachePath ?? defaultCachePath();
    const ttl = opts.ttlMs ?? VERSIONS_TTL_MS;
    try {
      const cached = await readCache(cachePath);
      if (cached) {
        mem = cached;
        setOpencodeVer(cached.ver);
        if (Date.now() - cached.at < ttl) return cached.ver;
      }
    } catch {}
    try {
      const init: RequestInit = { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) };
      if (opts.proxyUrl) (init as Record<string, unknown>).dispatcher = makeProxyDispatcher(opts.proxyUrl);
      const res = opts.fetchImpl ? await opts.fetchImpl(VERSIONS_URL, init) : await safeFetch(VERSIONS_URL, init);
      if (!res.ok) throw new Error(`versions download failed (${res.status})`);
      const ver = parseOpencodeVer(JSON.parse(await readBodyLimited(res, VERSIONS_MAX_BYTES)));
      if (!ver) throw new Error("empty versions payload");
      mem = { at: Date.now(), ver };
      setOpencodeVer(ver);
      await writeCache(cachePath, ver);
      return ver;
    } catch {
      return mem?.ver;
    } finally {
      if (inflight === taskRef) inflight = undefined;
    }
  })();
  taskRef = task;
  inflight = task;
  return task;
}