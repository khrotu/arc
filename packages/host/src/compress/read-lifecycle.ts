export interface ReadEvent {
  path: string;
  start: number;
  end: number;
  turn: number;
  seq: number;
  bytes: number;
}
export type ReadVerdict = "fresh" | "stale" | "superseded";
import * as path from "node:path";
function normalizeRange(start: number, end: number): { start: number; end: number } {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { start: 0, end: 0 };
  const s = Math.max(0, Math.min(start, end));
  return { start: s, end: Math.max(s, end) };
}
export function normalizeLifecyclePath(p: string): string {
  const plat = process.platform === "win32" ? p.toLowerCase() : p;
  return path.posix.normalize(plat.replace(/\\/g, "/")).replace(/^\.\//, "").trim();
}
export class ReadLifecycle {
  private edits = new Map<string, { turn: number; seq: number }>();
  private reads: ReadEvent[] = [];
  private counter = 0;
  noteEdit(path: string, turn: number): number {
    const seq = ++this.counter;
    this.edits.set(normalizeLifecyclePath(path), { turn, seq });
    return seq;
  }
  noteRead(path: string, start: number, end: number, turn: number, bytes: number): number {
    const seq = ++this.counter;
    const range = normalizeRange(start, end);
    this.reads.push({ path: normalizeLifecyclePath(path), start: range.start, end: range.end, turn, seq, bytes });
    if (this.reads.length > 500) this.reads.splice(0, this.reads.length - 500);
    return seq;
  }
  verdict(path: string, start: number, end: number, turn: number, seq?: number): ReadVerdict {
    const key = normalizeLifecyclePath(path);
    const range = normalizeRange(start, end);
    start = range.start;
    end = range.end;
    const edited = this.edits.get(key);
    if (seq === undefined) {
      if (edited !== undefined && edited.turn >= turn) return "stale";
      for (let i = this.reads.length - 1; i >= 0; i--) {
        const r = this.reads[i];
        if (r.path !== key || r.turn <= turn) continue;
        if (r.start <= start && r.end >= end) return "superseded";
      }
      return "fresh";
    }
    if (edited !== undefined && (edited.turn > turn || (edited.turn === turn && edited.seq > seq))) return "stale";
    for (let i = this.reads.length - 1; i >= 0; i--) {
      const r = this.reads[i];
      if (r.path !== key) continue;
      if (r.turn < turn || (r.turn === turn && r.seq <= seq)) continue;
      if (r.start <= start && r.end >= end) return "superseded";
    }
    return "fresh";
  }
  elide(path: string, verdict: Exclude<ReadVerdict, "fresh">, retrievalId?: string): string {
    const tail = retrievalId ? ` Retrieve original: hash=${retrievalId}` : " Re-read the file for current content.";
    if (verdict === "stale") return `[Read content stale: ${path} was edited after this read.${tail}]`;
    return `[Read content superseded: ${path} covered by a later full read.${tail}]`;
  }
  reset(): void {
    this.edits.clear();
    this.reads = [];
    this.counter = 0;
  }
}