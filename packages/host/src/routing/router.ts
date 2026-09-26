import type { ModelDescriptor, ModelTier, ProviderConfig, ProviderRef } from "../protocol/protocol.js";
import type { ModelRegistry } from "./registry.js";
import type { StreamEvent, StreamHandle } from "../providers/transport.js";
import { AsyncEventQueue } from "../util/stream.js";
import { perf } from "./performance.js";
export class StallError extends Error {
  constructor(msg: string, public readonly providerId: string, public readonly timeoutMs: number) {
    super(msg); this.name = "StallError";
  }
}
function isRateLimitError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("429") || m.includes("rate limit") || m.includes("too many requests");
}
const AUTH_FAILURE = /(\b401\b|\b403\b|unauthorized|forbidden|invalid[ .-]?api[ .-]?key|api[ .-]?key.*invalid|authentication (failed|error|required))/i;
export type { StreamEvent, StreamHandle };
export interface RoutingDecision {
  model: ModelDescriptor;
  provider: ProviderConfig;
  ref: ProviderRef;
  attempt: number;
}
export interface AffinityOptions {
  preferProviderId?: string;
  promptTokens?: number;
}
const STICKY_CONTEXT_TOKENS = 10_000;
const STICKY_SCORE_MARGIN = 25;
const affinityByModel = new Map<string, string>();
export function resetAffinity(): void { affinityByModel.clear(); }
function stickyRef(refs: ProviderRef[], modelId: string, opts?: AffinityOptions): ProviderRef | undefined {
  const id = opts?.preferProviderId ?? affinityByModel.get(modelId);
  if (!id) return undefined;
  const ref = refs.find((r) => r.id === id);
  if (!ref || perf.isOpen(ref.id, modelId)) return undefined;
  const tokens = opts?.promptTokens;
  if (tokens === undefined || tokens >= STICKY_CONTEXT_TOKENS) return ref;
  let best = 0;
  for (const r of refs) {
    if (r.id !== ref.id) {
      const s = perf.score(r.id, modelId);
      if (s > best) best = s;
    }
  }
  if (perf.score(ref.id, modelId) >= best - STICKY_SCORE_MARGIN) return ref;
  return undefined;
}
export function withProviderOverrides(model: ModelDescriptor, ref?: ProviderRef): ModelDescriptor {
  if (!ref) return model;
  return {
    ...model,
    contextWindow: ref.contextWindow ?? model.contextWindow,
    maxOutputTokens: ref.maxOutputTokens ?? model.maxOutputTokens,
    costPer1mIn: ref.costPer1mIn ?? model.costPer1mIn,
    costPer1mOut: ref.costPer1mOut ?? model.costPer1mOut,
    costPer1mCacheRead: ref.costPer1mCacheRead ?? model.costPer1mCacheRead,
    costPer1mCacheWrite: ref.costPer1mCacheWrite ?? model.costPer1mCacheWrite,
  };
}
export function pickForTier(
  registry: ModelRegistry,
  tier: ModelTier,
  preferModelId?: string,
): ModelDescriptor | undefined {
  if (preferModelId) {
    const m = registry.get(preferModelId);
    if (m && m.tier === tier) return m;
  }
  return registry.firstByTier(tier);
}
export function pickProvider(
  registry: ModelRegistry,
  model: ModelDescriptor,
  opts?: { rerank?: boolean } & AffinityOptions,
): { provider: ProviderConfig; ref: ProviderRef } | undefined {
  const refs = registry.providersFor(model.id);
  const len = refs.length;
  if (!len) return undefined;
  if (len === 1) {
    const pr = registry.resolveProvider(refs[0]);
    return pr ? { provider: pr, ref: refs[0] } : undefined;
  }
  const sticky = stickyRef(refs, model.id, opts);
  if (sticky) {
    const pr = registry.resolveProvider(sticky);
    if (pr) return { provider: pr, ref: sticky };
  }
  let ranked = refs;
  if (opts?.rerank) {
    ranked = [...refs].sort((a, b) => {
      const d = perf.score(b.id, model.id) - perf.score(a.id, model.id);
      return d !== 0 ? d : a.priority - b.priority;
    });
  }
  const tw = ranked.reduce((s, r) => s + (r.weight ?? 0), 0);
  if (tw > 0) {
    const ok: ProviderRef[] = [];
    let okWeight = 0;
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      if (!perf.isOpen(r.id, model.id)) { ok.push(r); okWeight += r.weight ?? 0; }
    }
    const pool = ok.length ? ok : ranked;
    const w = ok.length ? okWeight : tw;
    let p = Math.random() * w;
    for (let i = 0; i < pool.length; i++) {
      const r = pool[i];
      p -= r.weight ?? 0;
      if (p <= 0) { const pr = registry.resolveProvider(r); if (pr) return { provider: pr, ref: r }; }
    }
  }
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    if (perf.isOpen(r.id, model.id)) continue;
    const pr = registry.resolveProvider(r);
    if (pr) return { provider: pr, ref: r };
  }
  const pr = registry.resolveProvider(ranked[0]);
  return pr ? { provider: pr, ref: ranked[0] } : undefined;
}
export function recordFailure(modelId: string, providerId: string): void {
  perf.recordFailure(providerId, modelId);
}
export function recordSuccess(modelId: string, providerId: string): void {
  perf.recordSuccess(providerId, modelId);
}
export function recordStall(modelId: string, providerId: string): void {
  perf.recordStall(providerId, modelId);
}
export function resetFailures(): void { perf.clearCircuitBreakers(); }
function* orderedRefs(registry: ModelRegistry, model: ModelDescriptor, opts?: { rerank?: boolean } & AffinityOptions): Generator<ProviderRef> {
  const refs = registry.providersFor(model.id);
  if (!refs.length) return;
  const sorted = opts?.rerank
    ? [...refs].sort((a, b) => {
        const d = perf.score(b.id, model.id) - perf.score(a.id, model.id);
        return d !== 0 ? d : a.priority - b.priority;
      })
    : refs;
  const sticky = stickyRef(refs, model.id, opts);
  if (sticky) {
    yield sticky;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].id !== sticky.id) yield sorted[i];
    }
    return;
  }
  for (let i = 0; i < sorted.length; i++) yield sorted[i];
}
async function tryEach<T>(
  registry: ModelRegistry,
  model: ModelDescriptor,
  fn: (ref: ProviderRef, prov: ProviderConfig, attempt: number) => Promise<T>,
  opts?: { rerank?: boolean } & AffinityOptions,
): Promise<T> {
  const MAX_RETRIES = 4;
  const authFails = new Map<string, number>();
  for (let cycle = 0; cycle <= MAX_RETRIES; cycle++) {
    let lastErr: unknown;
    let attempt = 0;
    let anyRateLimited = false;
    for (const ref of orderedRefs(registry, model, opts)) {
      const prov = registry.resolveProvider(ref);
      if (!prov) continue;
      const keys = prov.apiKeys?.length ? prov.apiKeys : prov.apiKey ? [prov.apiKey] : [];
      if ((authFails.get(ref.id) ?? 0) >= Math.max(1, keys.length)) continue;
      const t0 = Date.now();
      let keyIdx = 0;
      for (;;) {
        const effProv = keys.length > 1 ? { ...prov, apiKey: keys[keyIdx % keys.length] } : prov;
        try {
          const out = await fn(ref, effProv, attempt++);
          perf.recordSuccess(ref.id, model.id, Date.now() - t0);
          affinityByModel.set(model.id, ref.id);
          return out;
        } catch (e) {
          lastErr = e;
          if ((e as Error)?.name === "AbortError") throw e;
          const msg = (e as Error)?.message ?? String(e);
          if (AUTH_FAILURE.test(msg)) {
            const n = (authFails.get(ref.id) ?? 0) + 1;
            authFails.set(ref.id, n);
            keyIdx++;
            if (keyIdx < Math.max(1, keys.length)) continue;
            perf.recordFailure(ref.id, model.id);
            break;
          }
          if (isRateLimitError(msg)) anyRateLimited = true;
          perf.recordFailure(ref.id, model.id);
          if (e instanceof StallError) perf.recordStall(ref.id, model.id);
          break;
        }
      }
    }
    if (!anyRateLimited || cycle >= MAX_RETRIES) {
      if (lastErr === undefined) {
        throw new Error(`All providers for ${model.id} rejected the configured credentials. Check API keys.`);
      }
      throw new Error(`All providers for ${model.id} failed: ${(lastErr as Error)?.message ?? lastErr}`);
    }
    await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** cycle, 60_000)));
  }
  throw new Error(`All providers for ${model.id} failed after retries`);
}
export async function routeWithFailover<T>(
  registry: ModelRegistry,
  model: ModelDescriptor,
  invoke: (d: RoutingDecision) => Promise<T>,
  opts?: { rerank?: boolean } & AffinityOptions,
): Promise<T> {
  return tryEach(registry, model, (r, p, n) => invoke({ model, provider: p, ref: r, attempt: n }), opts);
}
export interface ResilientOptions extends AffinityOptions {
  stallMs?: number;
  firstByteMs?: number;
  rerank?: boolean;
}
const MIN_STALL_MS = 20_000;
const MAX_STALL_MS = 60_000;
const MIN_FB_MS = 30_000;
const MAX_FB_MS = 90_000;
const DEFAULT_STALL_MS = 45_000;
const DEFAULT_FB_MS = 60_000;
function timeoutFor(pid: string, mid: string, userMs: number | undefined, minMs: number, maxMs: number, defaultMs: number): number {
  if (userMs !== undefined) return userMs;
  const lat = perf.latency(pid, mid);
  if (!lat) return defaultMs;
  const adaptive = Math.round(lat * 3);
  return Math.max(minMs, Math.min(maxMs, adaptive));
}
function wrapStall(handle: StreamHandle, pid: string, stallMs: number, firstByteMs: number, primed = false): StreamHandle {
  const q = new AsyncEventQueue<StreamEvent>();
  let dead = false;
  let sTimer: ReturnType<typeof setTimeout> | undefined;
  let fbTimer: ReturnType<typeof setTimeout> | undefined;
  let got = false;
  const kill = () => { if (sTimer) { clearTimeout(sTimer); sTimer = undefined; } if (fbTimer) { clearTimeout(fbTimer); fbTimer = undefined; } };
  const onStall = () => {
    kill();
    if (dead) return;
    dead = true;
    q.push({ type: "error", message: `Provider ${pid} stalled (${stallMs}ms)` });
    handle.abort();
    q.close();
  };
  const onFirstByteTimeout = () => {
    if (!got && !dead) {
      q.push({ type: "error", message: `Provider ${pid} timed out (${firstByteMs}ms)` });
      handle.abort(); q.close();
    }
  };
  void (async () => {
    try {
      let fbExtensions = 0;
      if (primed) {
        got = true;
      } else {
        fbTimer = setTimeout(onFirstByteTimeout, firstByteMs);
      }
      for await (const ev of handle.events) {
        if (dead) break;
        if (ev.type === "ping") {
          if (got && sTimer) {
            clearTimeout(sTimer);
            sTimer = setTimeout(onStall, stallMs);
          } else if (!got && fbTimer) {
            fbExtensions++;
            if (fbExtensions > 30) continue;
            clearTimeout(fbTimer);
            fbTimer = setTimeout(onFirstByteTimeout, firstByteMs);
          }
          continue;
        }
        if (!got) { got = true; if (fbTimer) { clearTimeout(fbTimer); fbTimer = undefined; } }
        q.push(ev);
        if (ev.type === "done" || ev.type === "error") { kill(); q.close(); return; }
        if (sTimer) clearTimeout(sTimer);
        sTimer = setTimeout(onStall, stallMs);
      }
    } catch (e) {
      if (!dead) q.push({ type: "error", message: (e as Error).message });
    } finally { kill(); q.close(); }
  })();
  return { events: q, abort: () => { dead = true; kill(); handle.abort(); q.close(); } };
}
export async function routeStream(
  registry: ModelRegistry,
  model: ModelDescriptor,
  create: (d: RoutingDecision) => Promise<StreamHandle>,
  opts?: ResilientOptions,
): Promise<StreamHandle> {
  return tryEach(registry, model, async (ref, prov, n) => {
    const stallMs = timeoutFor(ref.id, model.id, opts?.stallMs, MIN_STALL_MS, MAX_STALL_MS, DEFAULT_STALL_MS);
    const fbMs = timeoutFor(ref.id, model.id, opts?.firstByteMs, MIN_FB_MS, MAX_FB_MS, DEFAULT_FB_MS);
    const raw = await create({ model, provider: prov, ref, attempt: n });
    const primed = await primeFirstEvent(raw, ref.id, model.id, fbMs);
    return wrapStall(primed, ref.id, stallMs, fbMs, true);
  }, { rerank: opts?.rerank, preferProviderId: opts?.preferProviderId, promptTokens: opts?.promptTokens });
}
async function primeFirstEvent(raw: StreamHandle, pid: string, mid: string, firstByteMs: number): Promise<StreamHandle> {
  const iter = raw.events[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), firstByteMs);
  });
  try {
    const raced = await Promise.race([iter.next(), timeout]);
    if (timer) clearTimeout(timer);
    if (raced === "timeout") {
      try { raw.abort(); } catch {}
      try { await iter.return?.(); } catch {}
      perf.recordStall(pid, mid);
      throw new StallError(`Provider ${pid} timed out waiting for first byte (${firstByteMs}ms)`, pid, firstByteMs);
    }
    const first = raced as IteratorResult<StreamEvent>;
    if (first.done) {
      try { raw.abort(); } catch {}
      try { await iter.return?.(); } catch {}
      throw new StallError(`Provider ${pid} closed the stream without events`, pid, firstByteMs);
    }
    if (first.value?.type === "error") {
      try { raw.abort(); } catch {}
      try { await iter.return?.(); } catch {}
      throw new Error(first.value.message || `Provider ${pid} failed before first byte`);
    }
    const q = new AsyncEventQueue<StreamEvent>();
    q.push(first.value);
    void (async () => {
      try {
        let r = await iter.next();
        while (!r.done) {
          q.push(r.value);
          r = await iter.next();
        }
      } catch (e) {
        q.push({ type: "error", message: (e as Error)?.message ?? String(e) });
      } finally {
        q.close();
      }
    })();
    return {
      events: q,
      abort: () => {
        try { raw.abort(); } catch {}
        try { q.close(); } catch {}
      },
    };
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e instanceof StallError) throw e;
    try { raw.abort(); } catch {}
    throw e;
  }
}
export function estimateCost(model: ModelDescriptor, usage: { prompt: number; completion: number; thinking?: number }, ref?: Pick<ProviderRef, "costPer1mIn" | "costPer1mOut">): number {
  const t = usage.thinking ?? 0;
  const per1mIn = ref?.costPer1mIn ?? model.costPer1mIn;
  const per1mOut = ref?.costPer1mOut ?? model.costPer1mOut;
  return (usage.prompt / 1_000_000) * per1mIn + (usage.completion / 1_000_000) * per1mOut + (t / 1_000_000) * per1mOut;
}
export interface CostBreakdown {
  total: number;
  cacheRead: number;
  cacheWrite: number;
  plainInput: number;
  output: number;
}
export function costBreakdown(
  model: Pick<ModelDescriptor, "costPer1mIn" | "costPer1mOut" | "costPer1mCacheRead" | "costPer1mCacheWrite">,
  usage: { prompt: number; completion: number; thinking?: number; cacheRead?: number; cacheWrite?: number },
  ref?: Pick<ProviderRef, "costPer1mIn" | "costPer1mOut" | "costPer1mCacheRead" | "costPer1mCacheWrite">,
): CostBreakdown {
  const per1mIn = ref?.costPer1mIn ?? model.costPer1mIn;
  const per1mOut = ref?.costPer1mOut ?? model.costPer1mOut;
  const per1mRead = ref?.costPer1mCacheRead ?? model.costPer1mCacheRead ?? per1mIn;
  const per1mWrite = ref?.costPer1mCacheWrite ?? model.costPer1mCacheWrite ?? per1mIn;
  const outputCost = ((usage.completion + (usage.thinking ?? 0)) / 1_000_000) * per1mOut;
  const hit = Math.min(Math.max(0, usage.cacheRead ?? 0), usage.prompt);
  const miss = Math.max(0, usage.prompt - hit);
  const writePortion = Math.min(Math.max(0, usage.cacheWrite ?? 0), miss);
  const readCost = (hit / 1_000_000) * per1mRead;
  const writeCost = (writePortion / 1_000_000) * per1mWrite;
  const plainCost = ((miss - writePortion) / 1_000_000) * per1mIn;
  return { total: readCost + writeCost + plainCost + outputCost, cacheRead: readCost, cacheWrite: writeCost, plainInput: plainCost, output: outputCost };
}