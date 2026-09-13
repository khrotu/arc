import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizeLifecyclePath } from "../compress/read-lifecycle.js";
export interface FileContextEntry {
  file: string;
  reads: number;
  edits: number;
  lastRead?: number;
  lastEdit?: number;
}
export type TouchKind = "read" | "edit";
export function normalizeTrackerPath(file: string): string {
  return normalizeLifecyclePath(file);
}
export interface FileContextTrackerOptions {
  dbPath: string;
  maxEntries?: number;
  saveDebounceMs?: number;
}
export class FileContextTracker {
  private entries = new Map<string, FileContextEntry>();
  private maxEntries: number;
  private saveDebounceMs: number;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;
  constructor(private opts: FileContextTrackerOptions) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? 500);
    this.saveDebounceMs = opts.saveDebounceMs ?? 1000;
  }
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.opts.dbPath, "utf-8");
      const parsed = JSON.parse(raw) as { entries?: FileContextEntry[] };
      if (!Array.isArray(parsed.entries)) throw new Error("bad entries");
      this.entries.clear();
      for (const e of parsed.entries) {
        if (typeof e?.file !== "string" || e.file.length === 0) continue;
        this.entries.set(normalizeTrackerPath(e.file), {
          file: normalizeTrackerPath(e.file),
          reads: Number.isFinite(e.reads) && e.reads >= 0 ? Math.floor(e.reads) : 0,
          edits: Number.isFinite(e.edits) && e.edits >= 0 ? Math.floor(e.edits) : 0,
          lastRead: Number.isFinite(e.lastRead) ? e.lastRead : undefined,
          lastEdit: Number.isFinite(e.lastEdit) ? e.lastEdit : undefined,
        });
      }
    } catch {
      try {
        const raw = await fs.readFile(this.opts.dbPath, "utf-8").catch(() => undefined);
        if (raw !== undefined) {
          await fs.writeFile(`${this.opts.dbPath}.corrupt`, raw, "utf-8").catch(() => {});
        }
      } catch {}
    } finally {
      this.loaded = true;
    }
  }
  private ensureLoaded(): void {
    if (!this.loaded) throw new Error("FileContextTracker.load() must be called before use.");
  }
  touch(file: string, kind: TouchKind): void {
    if (!this.loaded) return;
    const key = normalizeTrackerPath(file);
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing) this.entries.delete(key);
    const entry: FileContextEntry = existing ?? { file: key, reads: 0, edits: 0 };
    if (kind === "read") {
      entry.reads += 1;
      entry.lastRead = now;
    } else {
      entry.edits += 1;
      entry.lastEdit = now;
    }
    this.entries.set(key, entry);
    this.evictIfNeeded();
    this.scheduleSave();
  }
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.save(); }, this.saveDebounceMs);
    (this.saveTimer as unknown as { unref?: () => void }).unref?.();
  }
  async save(): Promise<void> {
    this.ensureLoaded();
    clearTimeout(this.saveTimer);
    try {
      await fs.mkdir(path.dirname(this.opts.dbPath), { recursive: true });
      const tmpPath = `${this.opts.dbPath}.tmp.${process.pid}.${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
      try {
        await fs.writeFile(tmpPath, JSON.stringify({ entries: [...this.entries.values()] }), "utf-8");
        await fs.rename(tmpPath, this.opts.dbPath);
      } finally {
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    } catch {
    }
  }
  get(file: string): FileContextEntry | undefined {
    return this.entries.get(normalizeTrackerPath(file));
  }
  list(): FileContextEntry[] {
    return [...this.entries.values()].reverse();
  }
  recent(n = 10): FileContextEntry[] {
    return this.list().slice(0, n);
  }
  size(): number {
    return this.entries.size;
  }
}