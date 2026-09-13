import * as fs from "node:fs";
import * as path from "node:path";
import { Indexer, walk, matchesAny, DEFAULT_INCLUDE, DEFAULT_EXCLUDE } from "./indexer.js";
import { loadArcIgnore } from "../util/arcignore.js";
export interface WatcherOptions {
  root: string;
  indexer: Indexer;
  debounceMs?: number;
  poll?: boolean;
  pollIntervalMs?: number;
  include?: string[];
  exclude?: string[];
  onUpdate?: (files: { updated: string[]; removed: string[] }) => void;
  onError?: (file: string, error: Error) => void;
}
type WatchEvent = "change" | "rename" | "remove";
function isSafeRel(rel: string): boolean {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) return false;
  return !rel.split("/").some((p) => p === "..");
}
export class IndexWatcher {
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<string, WatchEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private knownMtimes = new Map<string, string>();
  private flushChain: Promise<void> = Promise.resolve();
  private seeded = false;
  constructor(private opts: WatcherOptions) {}
  private started = false;
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    if (this.opts.poll || process.platform === "linux") {
      this.pollLoop();
      return;
    }
    try {
      const w = fs.watch(this.opts.root, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, "/");
        const evt: WatchEvent = event === "rename" ? "rename" : "change";
        this.schedule(rel, evt);
      });
      w.on("error", () => {
        try { w.close(); } catch {}
        this.watchers = this.watchers.filter((x) => x !== w);
        if (!this.stopped && this.watchers.length === 0) this.pollLoop();
      });
      this.watchers.push(w);
    } catch {
      this.pollLoop();
    }
  }
  stop(): void {
    this.stopped = true;
    this.started = false;
    for (const w of this.watchers) {
try { w.close(); } catch {  }
    }
    this.watchers = [];
    this.pending.clear();
    this.knownMtimes.clear();
    this.seeded = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }
  private schedule(rel: string, evt: WatchEvent): void {
    this.pending.set(rel, evt);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flushChain = this.flushChain.then(() => this.flush()).catch(() => {});
    }, this.opts.debounceMs ?? 250);
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }
  private async flush(): Promise<void> {
    if (this.stopped) return;
    const items = Array.from(this.pending.entries());
    this.pending.clear();
    this.timer = undefined;
    const include = this.opts.include ?? DEFAULT_INCLUDE;
    const exclude = this.opts.exclude ?? DEFAULT_EXCLUDE;
    const expanded: [string, WatchEvent][] = [];
    for (const [rel, evt] of items) {
      if (!isSafeRel(rel)) continue;
      if (evt !== "remove") {
        try {
          const stat = await fs.promises.stat(path.join(this.opts.root, rel)).catch(() => undefined);
          if (stat?.isDirectory()) {
            let ignoreSub: { isIgnored: (f: string) => boolean } | undefined;
            try {
              const arcIgnore = await loadArcIgnore(this.opts.root);
              ignoreSub = { isIgnored: (f) => arcIgnore.isIgnored(f) };
            } catch {}
            const sub = await walk(path.join(this.opts.root, rel), include, exclude, { ...(ignoreSub ? { ignore: ignoreSub } : {}), maxFiles: 5000 });
            const prefix = rel ? `${rel}/` : "";
            for (const child of sub) expanded.push([`${prefix}${child}`, "change"]);
            continue;
          }
        } catch {}
      }
      expanded.push([rel, evt]);
    }
    const updated: string[] = [];
    const removed: string[] = [];
    let ignore: { isIgnored: (f: string) => boolean };
    try {
      ignore = await loadArcIgnore(this.opts.root);
    } catch {
      ignore = { isIgnored: () => false };
    }
    for (const [rel, evt] of expanded) {
      if (ignore.isIgnored(rel)) {
        if (evt === "remove") this.opts.indexer.removeFile(rel);
        continue;
      }
      if (matchesAny(rel, exclude) || !matchesAny(rel, include)) {
        continue;
      }
      try {
        const full = path.join(this.opts.root, rel);
        const stat = await fs.promises.stat(full).catch(() => undefined);
        if (!stat) {
          this.opts.indexer.removeFile(rel);
          removed.push(rel);
          continue;
        }
        if (!stat.isFile()) continue;
        await this.opts.indexer.reindexFile(this.opts.root, rel);
        updated.push(rel);
      } catch (e) {
        this.opts.onError?.(rel, e as Error);
      }
    }
    if (updated.length || removed.length) this.opts.onUpdate?.({ updated, removed });
  }
  private pollLoop(): void {
    const arm = (t: ReturnType<typeof setTimeout>) => {
      if (typeof (t as unknown as { unref?: () => void }).unref === "function") (t as unknown as { unref: () => void }).unref();
      return t;
    };
    const tick = async () => {
      if (this.stopped) return;
      try {
        this.flushChain = this.flushChain.then(() => this.pollScan()).catch(() => {});
        await this.flushChain;
      } catch {
      }
      if (this.stopped) return;
      this.pollTimer = arm(setTimeout(tick, this.opts.pollIntervalMs ?? 5000));
    };
    this.pollTimer = arm(setTimeout(tick, 0));
  }
  private async pollScan(): Promise<void> {
    if (this.stopped) return;
    const include = this.opts.include ?? DEFAULT_INCLUDE;
    const exclude = this.opts.exclude ?? DEFAULT_EXCLUDE;
    let ignore: { isIgnored: (f: string) => boolean };
    try {
      ignore = await loadArcIgnore(this.opts.root);
    } catch {
      ignore = { isIgnored: () => false };
    }
    const files = await walk(this.opts.root, include, exclude, { ignore });
    const seedOnly = !this.seeded && this.opts.indexer.getIndex().size() > 0;
    this.seeded = true;
    const seen = new Set<string>();
    const updated: string[] = [];
    const removed: string[] = [];
    for (const rel of files) {
      seen.add(rel);
      const full = path.join(this.opts.root, rel);
      let stamp: string;
      try {
        const stat = await fs.promises.stat(full);
        stamp = `${stat.mtimeMs}:${stat.size}`;
      } catch {
        continue;
      }
      const prev = this.knownMtimes.get(rel);
      if (prev === undefined || prev !== stamp) {
        this.knownMtimes.set(rel, stamp);
        if (seedOnly) continue;
        try {
          await this.opts.indexer.reindexFile(this.opts.root, rel);
          updated.push(rel);
        } catch (e) {
          this.opts.onError?.(rel, e as Error);
        }
      }
    }
    for (const rel of Array.from(this.knownMtimes.keys())) {
      if (!seen.has(rel)) {
        this.knownMtimes.delete(rel);
        this.opts.indexer.removeFile(rel);
        removed.push(rel);
      }
    }
    if (updated.length || removed.length) this.opts.onUpdate?.({ updated, removed });
  }
}