import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveAuthorizedPath } from "../security/path-policy.js";
import { loadArcIgnore } from "../util/arcignore.js";
export interface TurnSnapshot {
  turnId: string;
  ts: number;
  files: Record<string, string>;
  root: string;
  todoItems?: { id: string; text: string; state: "pending" | "in_progress" | "done" | "skipped" | "blocked" | "failed" }[];
  label?: string;
}
export interface RestoreResult {
  restored: string[];
  conflicts: string[];
  errors?: string[];
}
export interface CheckpointStoreOptions {
  dir: string;
  encrypt?: (content: Buffer) => Promise<Buffer>;
  decrypt?: (content: Buffer) => Promise<Buffer>;
}
export class CheckpointStore {
  private metaCache = new Map<string, Map<string, TurnSnapshot>>();
  constructor(private opts: CheckpointStoreOptions) {}
  static hash(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
  }
  static isBlobHash(hash: string): boolean {
    return /^[0-9a-f]{32}$/.test(hash) || hash === "__none__";
  }
  private async eachLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const at = next++;
        out[at] = await fn(items[at]);
      }
    });
    await Promise.all(workers);
    return out;
  }
  async snapshot(turnId: string, root: string, files: string[], todoItems?: TurnSnapshot["todoItems"], label?: string): Promise<TurnSnapshot> {
    const prev = await this.load(root, turnId);
    const map: Record<string, string> = { ...(prev?.files ?? {}) };
    let effectiveFiles = files;
    try {
      const ignore = await loadArcIgnore(root);
      if (ignore.patterns.length || ignore.negations.length) {
        effectiveFiles = files.filter((f) => !ignore.isIgnored(f.replace(/\\/g, "/")));
      }
} catch {  }
    await this.eachLimit(effectiveFiles, 32, async (rel) => {
      const abs = resolveAuthorizedPath(root, rel);
      let content: Buffer;
      try {
        content = await fs.readFile(abs);
      } catch {
        map[rel] = "__none__";
        return;
      }
      const h = CheckpointStore.hash(content);
      map[rel] = h;
      await fs.mkdir(path.dirname(this.blobPath(h)), { recursive: true, mode: 0o700 });
      await this.writeBlob(h, content);
    });
    const snap: TurnSnapshot = { turnId, ts: Date.now(), files: map, root };
    const fresh = new Set(effectiveFiles);
    for (const [rel, hash] of Object.entries(prev?.files ?? {})) {
      if (fresh.has(rel) || !CheckpointStore.isBlobHash(hash) || hash === "__none__") continue;
      try {
        await fs.stat(resolveAuthorizedPath(root, rel));
      } catch {
        map[rel] = "__none__";
        snap.files[rel] = "__none__";
      }
    }
    if (todoItems !== undefined) snap.todoItems = todoItems;
    else if (prev?.todoItems) snap.todoItems = prev.todoItems;
    if (label || prev?.label) snap.label = label ?? prev?.label;
    const metaPath = this.metaPath(root, turnId);
    await fs.mkdir(path.dirname(metaPath), { recursive: true, mode: 0o700 });
    const tmpMeta = `${metaPath}.tmp.${process.pid}.${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    try {
      await fs.writeFile(tmpMeta, JSON.stringify(snap), { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tmpMeta, metaPath);
    } finally {
      await fs.unlink(tmpMeta).catch(() => undefined);
    }
    this.cacheFor(root).set(turnId, snap);
    return snap;
  }
  async listTurns(root: string): Promise<string[]> {
    const dir = this.turnsDir(root);
    let ids: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      ids = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name.replace(/\.json$/, ""));
    } catch {
      return [];
    }
    const cache = this.cacheFor(root);
    for (const id of [...cache.keys()]) {
      if (!ids.includes(id)) cache.delete(id);
    }
    const loaded = await Promise.all(ids.map(async (id) => ({ id, snap: await this.load(root, id).catch(() => undefined) })));
    loaded.sort((a, b) => (b.snap?.ts ?? 0) - (a.snap?.ts ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return loaded.map((t) => t.id);
  }
  async load(root: string, turnId: string): Promise<TurnSnapshot | undefined> {
    const cached = this.cacheFor(root).get(turnId);
    if (cached) return structuredClone(cached);
    try {
      const raw = await fs.readFile(this.metaPath(root, turnId), "utf-8");
      const snap = JSON.parse(raw) as TurnSnapshot;
      if (!snap || typeof snap !== "object" || !snap.files || typeof snap.files !== "object") return undefined;
      for (const [rel, hash] of Object.entries(snap.files)) {
        if (typeof rel !== "string" || typeof hash !== "string" || !CheckpointStore.isBlobHash(hash)) {
          delete snap.files[rel];
        }
      }
      this.cacheFor(root).set(turnId, snap);
      return structuredClone(snap);
    } catch {
      return undefined;
    }
  }
  async restoreSingleFile(root: string, rel: string, hash: string): Promise<RestoreResult> {
    if (!CheckpointStore.isBlobHash(hash) || hash === "__none__") {
      return { restored: [], conflicts: [], errors: [`${rel}: invalid blob hash`] };
    }
    const snap: TurnSnapshot = { turnId: "(single)", ts: Date.now(), root, files: { [rel]: hash } };
    return this.restoreFiles(root, [snap]);
  }
  async restore(root: string, turnId: string): Promise<RestoreResult> {
    const snap = await this.load(root, turnId);
    if (!snap) throw new Error(`No snapshot for turn ${turnId}`);
    const result = await this.restoreFiles(root, [snap]);
    if (!result.errors?.length) {
      await this.deleteNewerThan(root, turnId);
    }
    return result;
  }
  async restoreRange(root: string, afterTs: number, beforeTs: number): Promise<RestoreResult> {
    const all = await this.listTurns(root);
    const targets: TurnSnapshot[] = [];
    for (const id of all) {
      const snap = await this.load(root, id);
      if (snap && snap.ts > afterTs && snap.ts <= beforeTs) targets.push(snap);
    }
    if (!targets.length) return { restored: [], conflicts: [] };
    targets.sort((a, b) => a.ts - b.ts);
    const chosen = new Map<string, string>();
    for (const s of targets) {
      for (const [rel, h] of Object.entries(s.files)) {
        chosen.set(rel, h);
      }
    }
    const ordered: TurnSnapshot[] = [{ turnId: "(range)", ts: targets[0].ts, root, files: Object.fromEntries(chosen) }];
    const result = await this.restoreFiles(root, ordered);
    if (!result.errors?.length) {
      await Promise.all(targets.map(async (t) => {
        await fs.unlink(this.metaPath(root, t.turnId)).catch(() => undefined);
        this.cacheFor(root).delete(t.turnId);
      }));
      await this.gcBlobs(root);
    }
    return result;
  }
  private async restoreFiles(root: string, snaps: TurnSnapshot[]): Promise<RestoreResult> {
    const restored: string[] = [];
    const conflicts: string[] = [];
    const errors: string[] = [];
    for (const snap of snaps) {
      const entries = Object.entries(snap.files);
      const outcomes = await this.eachLimit(entries, 32, async ([rel, hash]) => {
        if (!CheckpointStore.isBlobHash(hash)) {
          return { rel, ok: false, conflict: false, error: "invalid blob hash" };
        }
        const abs = resolveAuthorizedPath(root, rel);
        try {
          if (hash === "__none__") {
            await fs.unlink(abs).catch(() => undefined);
            return { rel, ok: true, conflict: false };
          }
          let current: Buffer | undefined;
          try {
            current = await fs.readFile(abs);
          } catch {}
          const conflict = !!(current && CheckpointStore.hash(current) !== hash);
          const stored = await fs.readFile(this.blobPath(hash));
          const raw = this.opts.decrypt ? await this.opts.decrypt(stored) : stored;
          if (CheckpointStore.hash(raw) !== hash) {
            return { rel, ok: false, conflict: false, error: "blob content hash mismatch (corrupt)" };
          }
          await fs.mkdir(path.dirname(abs), { recursive: true });
          let existingMode: number | undefined;
          try {
            existingMode = (await fs.stat(abs)).mode;
          } catch {}
          if (existingMode !== undefined) {
            await fs.writeFile(abs, raw);
            try {
              await fs.chmod(abs, existingMode);
            } catch {}
          } else {
            await fs.writeFile(abs, raw);
          }
          return { rel, ok: true, conflict };
        } catch (e) {
          return { rel, ok: false, conflict: false, error: (e as Error)?.message ?? String(e) };
        }
      });
      for (const o of outcomes) {
        if (!o.ok && o.error) errors.push(`${o.rel}: ${o.error}`);
        else {
          if (!restored.includes(o.rel)) restored.push(o.rel);
          if (o.conflict && !conflicts.includes(o.rel)) conflicts.push(o.rel);
        }
      }
    }
    return errors.length ? { restored, conflicts, errors } : { restored, conflicts };
  }
  private async deleteNewerThan(root: string, keepTurnId: string): Promise<void> {
    const all = await this.listTurns(root);
    const idx = all.indexOf(keepTurnId);
    if (idx <= 0) return;
    const newer = all.slice(0, idx);
    await Promise.all(newer.map(async (id) => {
      await fs.unlink(this.metaPath(root, id)).catch(() => undefined);
      this.cacheFor(root).delete(id);
    }));
    await this.gcBlobs(root);
  }
  private async gcBlobs(_root: string): Promise<void> {
    try {
      const referenced = new Set<string>();
      const turnsBase = path.join(this.opts.dir, "turns");
      let rootDirs: string[] = [];
      try {
        rootDirs = (await fs.readdir(turnsBase)).map((name) => path.join(turnsBase, name));
      } catch {
        rootDirs = [this.turnsDir(_root)];
      }
      await Promise.all(rootDirs.map(async (dir) => {
        let entries: string[] = [];
        try {
          entries = (await fs.readdir(dir)).filter((e) => e.endsWith(".json"));
        } catch { return; }
        await Promise.all(entries.map(async (e) => {
          try {
            const snap = JSON.parse(await fs.readFile(path.join(dir, e), "utf-8")) as TurnSnapshot;
            if (snap && snap.files && typeof snap.files === "object") {
              for (const hash of Object.values(snap.files)) {
                if (typeof hash === "string" && CheckpointStore.isBlobHash(hash) && hash !== "__none__") referenced.add(hash);
              }
            }
          } catch { }
        }));
      }));
      const blobsDir = path.join(this.opts.dir, "objects");
      const blobDirs = await fs.readdir(blobsDir, { withFileTypes: true });
      await Promise.all(blobDirs.map(async (dirEnt) => {
        if (!dirEnt.isDirectory()) return;
        const subDir = path.join(blobsDir, dirEnt.name);
        const files = await fs.readdir(subDir);
        await Promise.all(files.map(async (f) => {
          if (f.includes(".tmp.")) return;
          const hash = f.endsWith(".bin") ? f.slice(0, -4) : f;
          if (!referenced.has(hash)) await fs.unlink(path.join(subDir, f)).catch(() => {});
        }));
      }));
    } catch {}
  }
  async clear(root: string) {
    const dir = this.turnsDir(root);
    try {
      const entries = await fs.readdir(dir);
      await Promise.all(entries.map((e) => fs.unlink(path.join(dir, e))));
} catch {  }
    this.metaCache.delete(root);
  }
  async compare(root: string, turnA: string, turnB: string): Promise<{ added: string[]; removed: string[]; modified: string[] }> {
    const snapA = await this.load(root, turnA);
    const snapB = await this.load(root, turnB);
    if (!snapA || !snapB) throw new Error("One or both snapshots not found.");
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const allFiles = new Set([...Object.keys(snapA.files), ...Object.keys(snapB.files)]);
    const norm = (h: string | undefined): string | undefined => (!h || h === "__none__" ? undefined : h);
    for (const file of allFiles) {
      const hashA = norm(snapA.files[file]);
      const hashB = norm(snapB.files[file]);
      if (!hashA && hashB) added.push(file);
      else if (hashA && !hashB) removed.push(file);
      else if (hashA !== hashB) modified.push(file);
    }
    return { added, removed, modified };
  }
  private cacheFor(root: string): Map<string, TurnSnapshot> {
    let m = this.metaCache.get(root);
    if (!m) {
      m = new Map();
      this.metaCache.set(root, m);
    }
    while (m.size > 200) {
      const oldest = m.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    return m;
  }
  private blobPath(hash: string): string {
    return path.join(this.opts.dir, "objects", hash.slice(0, 2), `${hash}.bin`);
  }
  private async writeBlob(hash: string, content: string | Buffer): Promise<void> {
    const blobPath = this.blobPath(hash);
    try {
      const existing = await fs.readFile(blobPath);
      const raw = this.opts.decrypt ? await this.opts.decrypt(existing) : existing;
      if (CheckpointStore.hash(raw) === hash) return;
    } catch {}
    const payload = this.opts.encrypt
      ? await this.opts.encrypt(Buffer.isBuffer(content) ? content : Buffer.from(content))
      : content;
    const tmp = `${blobPath}.tmp.${process.pid}.${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    try {
      await fs.writeFile(tmp, payload, { mode: 0o600 });
      await fs.rename(tmp, blobPath);
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
    try {
      const check = await fs.readFile(blobPath);
      const checkRaw = this.opts.decrypt ? await this.opts.decrypt(check) : check;
      if (CheckpointStore.hash(checkRaw) !== hash) {
        await fs.unlink(blobPath).catch(() => undefined);
        throw new Error(`blob verification failed for ${hash}`);
      }
    } catch (e) {
      if ((e as Error)?.message?.includes("verification failed")) throw e;
    }
  }
  private turnsDir(root: string): string {
    const id = encodeURIComponent(root);
    return path.join(this.opts.dir, "turns", id);
  }
  private metaPath(root: string, turnId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(turnId)) throw new Error("Invalid checkpoint turn id.");
    return path.join(this.turnsDir(root), `${turnId}.json`);
  }
}