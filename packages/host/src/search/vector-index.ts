import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { EmbeddingVector } from "./backend.js";
interface VectorIndexSecurity {
  encrypt?: (content: Buffer) => Promise<Buffer>;
  decrypt?: (content: Buffer) => Promise<Buffer>;
}
let security: VectorIndexSecurity = {};
export function configureVectorIndexSecurity(next: VectorIndexSecurity): void { security = next; }
export interface VectorRecord {
  id: string;
  vector: number[];
  meta: Record<string, unknown>;
}
export interface SearchHit {
  id: string;
  score: number;
  meta: Record<string, unknown>;
}
export class VectorIndex {
  private records = new Map<string, VectorRecord>();
  private expectedDim = 0;
  add(rec: VectorRecord): boolean {
    if (!Array.isArray(rec.vector) || rec.vector.length === 0) return false;
    if (typeof rec.id !== "string" || rec.id.length === 0 || Buffer.byteLength(rec.id) > 4096) return false;
    const vector = rec.vector.slice();
    for (const x of vector) {
      if (!Number.isFinite(x)) return false;
    }
    if (this.expectedDim === 0) this.expectedDim = vector.length;
    else if (vector.length !== this.expectedDim) return false;
    this.records.set(rec.id, { id: rec.id, vector, meta: { ...rec.meta } });
    return true;
  }
  remove(id: string): boolean {
    const ok = this.records.delete(id);
    if (ok && this.records.size === 0) this.expectedDim = 0;
    return ok;
  }
  get(id: string): VectorRecord | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    return { id: rec.id, vector: [...rec.vector], meta: { ...rec.meta } };
  }
  size(): number {
    return this.records.size;
  }
  clear(): void {
    this.records.clear();
    this.expectedDim = 0;
  }
  search(query: EmbeddingVector, k: number): SearchHit[] {
    if (this.records.size === 0) return [];
    if (!Array.isArray(query.values) || query.values.length === 0) return [];
    const limit = Number.isFinite(k) ? Math.max(0, Math.min(Math.floor(k), 1000)) : 0;
    if (limit === 0) return [];
    const q = normalize(query.values);
    if (!q) return [];
    const scored: SearchHit[] = [];
    for (const rec of this.records.values()) {
      if (rec.vector.length !== q.length) continue;
      const v = normalize(rec.vector);
      if (!v) continue;
      const score = cosine(q, v);
      if (!Number.isFinite(score)) continue;
      scored.push({ id: rec.id, score, meta: { ...rec.meta } });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
  filter(predicate: (rec: VectorRecord) => boolean): VectorRecord[] {
    const out: VectorRecord[] = [];
    for (const rec of this.records.values()) {
      if (predicate(rec)) out.push({ id: rec.id, vector: [...rec.vector], meta: { ...rec.meta } });
    }
    return out;
  }
  async save(filePath: string): Promise<void> {
    await fs.mkdir(pathDir(filePath), { recursive: true });
    const recs = Array.from(this.records.values());
    const metaBufs: Buffer[] = [];
    const idBufs: Buffer[] = [];
    const vecBufs: Buffer[] = [];
    let totalMeta = 0;
    let totalId = 0;
    let totalVec = 0;
    for (const rec of recs) {
      const idEnc = Buffer.from(rec.id, "utf-8");
      if (idEnc.length > 4096) throw new Error(`Record id too long: ${idEnc.length} > 4096`);
      idBufs.push(idEnc);
      totalId += idEnc.length;
      const metaEnc = Buffer.from(JSON.stringify(rec.meta), "utf-8");
      if (metaEnc.length > 65535) throw new Error(`Record meta too long: ${metaEnc.length} > 65535`);
      metaBufs.push(metaEnc);
      totalMeta += metaEnc.length;
      if (rec.vector.length > 65535) throw new Error(`Vector dim too large: ${rec.vector.length} > 65535`);
      const vecBuf = Buffer.alloc(rec.vector.length * 4);
      for (let i = 0; i < rec.vector.length; i++) vecBuf.writeFloatLE(rec.vector[i], i * 4);
      vecBufs.push(vecBuf);
      totalVec += vecBuf.length;
    }
    const header = Buffer.alloc(16);
    header.write("ARCX", 0, "ascii");
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(recs.length, 8);
    header.writeUInt32LE(0, 12);
    const bufs: Buffer[] = [header];
    for (let i = 0; i < recs.length; i++) {
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16LE(idBufs[i].length, 0);
      bufs.push(idLen, idBufs[i]);
      const metaLen = Buffer.alloc(2);
      metaLen.writeUInt16LE(metaBufs[i].length, 0);
      bufs.push(metaLen, metaBufs[i]);
      const dim = Buffer.alloc(2);
      dim.writeUInt16LE(recs[i].vector.length, 0);
      bufs.push(dim, vecBufs[i]);
    }
    const out = Buffer.concat(bufs);
    const payload = security.encrypt ? await security.encrypt(out) : out;
    const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
    try {
      await fs.writeFile(tmpPath, payload, { mode: 0o600 });
      await fs.rename(tmpPath, filePath);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
  static async load(filePath: string): Promise<VectorIndex> {
    const idx = new VectorIndex();
    const stored = await fs.readFile(filePath);
    let buf = stored;
    if (security.decrypt) {
      let decrypted: Buffer;
      try {
        decrypted = await security.decrypt(stored);
      } catch {
        throw new Error(`Cannot decrypt index file: ${filePath}`);
      }
      if (decrypted.toString("ascii", 0, 4) !== "ARCX") {
        throw new Error(`Decrypted index file is not an Arc index: ${filePath}`);
      }
      buf = decrypted;
    }
    if (buf.length < 16) throw new Error(`Truncated index file: ${filePath}`);
    const magic = buf.toString("ascii", 0, 4);
    if (magic !== "ARCX") throw new Error(`Not an Arc index file: ${filePath}`);
    const version = buf.readUInt32LE(4);
    if (version !== 1) throw new Error(`Unsupported index version: ${version}`);
    const count = buf.readUInt32LE(8);
    if (count > 10_000_000) throw new Error(`Corrupt index record count: ${filePath}`);
    let off = 16;
    for (let i = 0; i < count; i++) {
      if (off + 2 > buf.length) throw new Error(`Truncated index file: ${filePath}`);
      const idLen = buf.readUInt16LE(off); off += 2;
      if (idLen > 4096) throw new Error(`Corrupt index record id: ${filePath}`);
      if (off + idLen > buf.length) throw new Error(`Truncated index file: ${filePath}`);
      const id = buf.toString("utf-8", off, off + idLen); off += idLen;
      if (off + 2 > buf.length) throw new Error(`Truncated index file: ${filePath}`);
      const metaLen = buf.readUInt16LE(off); off += 2;
      if (metaLen > 1024 * 1024) throw new Error(`Corrupt index record meta: ${filePath}`);
      if (off + metaLen > buf.length) throw new Error(`Truncated index file: ${filePath}`);
      const metaJson = buf.toString("utf-8", off, off + metaLen); off += metaLen;
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(metaJson) as Record<string, unknown>;
      } catch {
        throw new Error(`Corrupt index record meta: ${filePath}`);
      }
      if (off + 2 > buf.length) throw new Error(`Truncated index file: ${filePath}`);
      const dim = buf.readUInt16LE(off); off += 2;
      if (dim === 0 || dim > 100_000) throw new Error(`Corrupt index record dim: ${filePath}`);
      if (off + dim * 4 > buf.length) throw new Error(`Truncated index file: ${filePath}`);
      const vector: number[] = [];
      for (let j = 0; j < dim; j++) {
        vector.push(buf.readFloatLE(off));
        off += 4;
      }
      if (!idx.add({ id, vector, meta })) throw new Error(`Corrupt index record (dim ${dim}): ${filePath}`);
    }
    return idx;
  }
}
function normalize(v: number[]): number[] | null {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return null;
  return v.map((x) => x / norm);
}
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
function pathDir(p: string): string {
  const sep = p.lastIndexOf("/");
  const bs = p.lastIndexOf("\\");
  const idx = Math.max(sep, bs);
  return idx >= 0 ? p.slice(0, idx) : ".";
}