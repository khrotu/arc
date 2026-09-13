import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { EmbeddingBackend } from "./backend.js";
import { VectorIndex } from "./vector-index.js";
import { loadArcIgnore } from "../util/arcignore.js";
import { globToRegExp } from "../util/glob.js";
export interface ChunkOptions {
  maxChunkChars?: number;
  overlapChars?: number;
}
export interface IndexOptions {
  include?: string[];
  exclude?: string[];
  chunk?: ChunkOptions;
}
const DEFAULT_INCLUDE = [
  "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs",
  "**/*.py", "**/*.rs", "**/*.go", "**/*.java", "**/*.kt", "**/*.cs",
  "**/*.rb", "**/*.php", "**/*.swift", "**/*.c", "**/*.cpp", "**/*.h",
  "**/*.hpp", "**/*.md", "**/*.mdx", "**/*.txt", "**/*.json", "**/*.yaml", "**/*.yml",
  "**/*.toml", "**/*.html", "**/*.css", "**/*.scss", "**/*.sql",
];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**", "**/build/**",
  "**/.next/**", "**/.vscode/**", "**/coverage/**", "**/.cache/**",
  "**/target/**", "**/venv/**", "**/__pycache__/**", "**/*.min.js", "**/*.lock",
  "**/*.lockb", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock",
];
export { DEFAULT_INCLUDE, DEFAULT_EXCLUDE };
export interface IndexerOptions {
  backend: EmbeddingBackend;
  opts?: IndexOptions;
  batchSize?: number;
}
export interface IndexProgress {
  filesScanned: number;
  filesIndexed: number;
  chunksEmbedded: number;
  errors: number;
  chunksTruncated?: number;
}
export class Indexer {
  private index = new VectorIndex();
  private pathsById = new Map<string, { file: string; start: number; end: number }>();
  private idsByFile = new Map<string, Set<string>>();
  constructor(private opts: IndexerOptions) {}
  getIndex(): VectorIndex { return this.index; }
  async save(filePath: string): Promise<void> {
    await this.index.save(filePath);
  }
  static async load(filePath: string, backend: EmbeddingBackend): Promise<Indexer> {
    const idx = await VectorIndex.load(filePath);
    const indexer = new Indexer({ backend });
    indexer.index = idx;
    indexer.rebuildPathMap();
    return indexer;
  }
  private rebuildPathMap(): void {
    this.pathsById.clear();
    this.idsByFile.clear();
    for (const rec of this.index.filter(() => true)) {
      const file = rec.meta.file as string | undefined;
      const start = rec.meta.start as number | undefined;
      const end = rec.meta.end as number | undefined;
      if (file && typeof start === "number" && typeof end === "number") {
        this.track(rec.id, file, start, end);
      }
    }
  }
  async indexWorkspace(root: string): Promise<IndexProgress> {
    let ignore: { isIgnored: (f: string) => boolean };
    try {
      ignore = await loadArcIgnore(root);
    } catch {
      ignore = { isIgnored: () => false };
    }
    const files = await walk(root, this.opts.opts?.include ?? DEFAULT_INCLUDE, this.opts.opts?.exclude ?? DEFAULT_EXCLUDE, { ignore });
    const filtered = files.filter((f) => !ignore.isIgnored(f));
    const progress: IndexProgress = { filesScanned: files.length, filesIndexed: 0, chunksEmbedded: 0, errors: 0 };
    const batchSize = Math.max(1, Math.floor(this.opts.batchSize ?? 64));
    for (const file of filtered) {
      try {
        const full = await safeJoin(root, file);
        if (!full) {
          progress.errors += 1;
          continue;
        }
        const stat = await fs.stat(full);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        const text = await fs.readFile(full, "utf-8");
        if (text.includes("\0")) continue;
        const { chunks, truncated } = chunkText(text, this.opts.opts?.chunk ?? {});
        if (truncated) progress.chunksTruncated = (progress.chunksTruncated ?? 0) + 1;
        const staged: { id: string; vector: number[]; start: number; end: number; text: string }[] = [];
        for (let b = 0; b < chunks.length; b += batchSize) {
          const slice = chunks.slice(b, b + batchSize);
          const vecs = await this.opts.backend.embed({ model: this.opts.backend.model, input: slice.map((c) => c.text) });
          if (vecs.length !== slice.length) throw new Error(`embed returned ${vecs.length} vectors for ${slice.length} chunks`);
          for (let k = 0; k < slice.length; k++) {
            staged.push({ id: `${file}#${slice[k].start}-${slice[k].end}-${randomUUID().slice(0, 6)}`, vector: vecs[k].values, start: slice[k].start, end: slice[k].end, text: slice[k].text });
          }
        }
        this.removeFile(file);
        for (const s of staged) {
          this.track(s.id, file, s.start, s.end);
          this.index.add({ id: s.id, vector: s.vector, meta: { file, start: s.start, end: s.end, text: s.text.slice(0, 400) } });
        }
        progress.chunksEmbedded += chunks.length;
        progress.filesIndexed += 1;
      } catch {
        progress.errors += 1;
      }
    }
    return progress;
  }
  async reindexFile(root: string, file: string): Promise<number> {
    try {
      const ignore = await loadArcIgnore(root);
      if (ignore.isIgnored(file)) {
        this.removeFile(file);
        return 0;
      }
    } catch {  }
    const full = await safeJoin(root, file);
    if (!full) {
      this.removeFile(file);
      return 0;
    }
    let text: string;
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        this.removeFile(file);
        return 0;
      }
      text = await fs.readFile(full, "utf-8");
    } catch {
      this.removeFile(file);
      return 0;
    }
    if (text.includes("\0")) {
      this.removeFile(file);
      return 0;
    }
    const { chunks } = chunkText(text, this.opts.opts?.chunk ?? {});
    if (chunks.length === 0) {
      this.removeFile(file);
      return 0;
    }
    const batchSize = Math.max(1, Math.floor(this.opts.batchSize ?? 64));
    const staged: { id: string; vector: number[]; start: number; end: number; text: string }[] = [];
    for (let b = 0; b < chunks.length; b += batchSize) {
      const slice = chunks.slice(b, b + batchSize);
      const vecs = await this.opts.backend.embed({ model: this.opts.backend.model, input: slice.map((c) => c.text) });
      if (vecs.length !== slice.length) throw new Error(`embed returned ${vecs.length} vectors for ${slice.length} chunks`);
      for (let k = 0; k < slice.length; k++) {
        staged.push({ id: `${file}#${slice[k].start}-${slice[k].end}-${randomUUID().slice(0, 6)}`, vector: vecs[k].values, start: slice[k].start, end: slice[k].end, text: slice[k].text });
      }
    }
    this.removeFile(file);
    for (const s of staged) {
      this.track(s.id, file, s.start, s.end);
      this.index.add({ id: s.id, vector: s.vector, meta: { file, start: s.start, end: s.end, text: s.text.slice(0, 400) } });
    }
    return chunks.length;
  }
  private track(id: string, file: string, start: number, end: number): void {
    this.pathsById.set(id, { file, start, end });
    let set = this.idsByFile.get(file);
    if (!set) {
      set = new Set();
      this.idsByFile.set(file, set);
    }
    set.add(id);
  }
  removeFile(file: string): number {
    const ids = this.idsByFile.get(file);
    if (ids) {
      for (const id of ids) {
        this.pathsById.delete(id);
        this.index.remove(id);
      }
      const removed = ids.size;
      this.idsByFile.delete(file);
      return removed;
    }
    let removed = 0;
    for (const [id, meta] of Array.from(this.pathsById.entries())) {
      if (meta.file === file) {
        this.index.remove(id);
        this.pathsById.delete(id);
        removed++;
      }
    }
    const orphans = this.index.filter((rec) => rec.meta.file === file);
    for (const rec of orphans) {
      this.index.remove(rec.id);
      removed++;
    }
    return removed;
  }
  async search(query: string, k = 10): Promise<{ id: string; score: number; file: string; start: number; end: number; text: string }[]> {
    const vecs = await this.opts.backend.embed({ model: this.opts.backend.model, input: query });
    if (!vecs.length) return [];
    const hits = this.index.search(vecs[0], k);
    return hits.map((h) => ({
      id: h.id,
      score: h.score,
      file: typeof h.meta.file === "string" ? h.meta.file : "",
      start: typeof h.meta.start === "number" ? h.meta.start : 0,
      end: typeof h.meta.end === "number" ? h.meta.end : 0,
      text: typeof h.meta.text === "string" ? h.meta.text : "",
    }));
  }
}
export interface TextChunk {
  text: string;
  start: number;
  end: number;
}
export function chunkText(text: string, opts: ChunkOptions = {}): { chunks: TextChunk[]; truncated: boolean } {
  const max = Math.min(8000, Math.max(64, opts.maxChunkChars ?? 1500));
  const overlap = Math.min(Math.max(0, opts.overlapChars ?? 200), max - 1);
  if (text.length <= max) return { chunks: [{ text, start: 0, end: text.length }], truncated: false };
  const chunks: TextChunk[] = [];
  let i = 0;
  let done = false;
  while (i < text.length && chunks.length < 512) {
    let end = Math.min(text.length, i + max);
    if (end < text.length) {
      const nl = text.indexOf("\n", end - 100);
      if (nl > i && nl < end + 100) end = nl + 1;
    }
    const slice = text.slice(i, end);
    chunks.push({ text: slice, start: i, end });
    if (end >= text.length) {
      done = true;
      break;
    }
    i = Math.max(i + 1, end - overlap);
  }
  return { chunks, truncated: !done };
}
async function safeJoin(root: string, file: string): Promise<string | undefined> {
  if (!file || file.includes("\0") || path.isAbsolute(file)) return undefined;
  const absRoot = path.resolve(root);
  const full = path.resolve(root, file);
  const rel = path.relative(absRoot, full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(absRoot);
  } catch {
    realRoot = absRoot;
  }
  try {
    const real = await fs.realpath(full);
    const realRel = path.relative(realRoot, real);
    if (realRel === "" || realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) return undefined;
  } catch (e) {
    if ((e as { code?: string })?.code !== "ENOENT") return undefined;
    try {
      const realParent = await fs.realpath(path.dirname(full));
      const parentRel = path.relative(realRoot, realParent);
      if (parentRel === ".." || parentRel.startsWith(`..${path.sep}`) || path.isAbsolute(parentRel)) return undefined;
    } catch {
      return undefined;
    }
  }
  return full;
}
export async function walk(
  root: string,
  include: string[],
  exclude: string[],
  opts: { ignore?: { isIgnored: (f: string) => boolean }; maxFiles?: number } = {},
): Promise<string[]> {
  const out: string[] = [];
  const maxFiles = opts.maxFiles ?? 50_000;
  async function visit(dir: string) {
    if (out.length >= maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (ent.isDirectory()) {
        if (matchesAny(rel + "/", exclude)) continue;
        if (opts.ignore?.isIgnored(`${rel}/`)) continue;
        await visit(full);
      } else if (ent.isFile()) {
        if (matchesAny(rel, exclude)) continue;
        if (opts.ignore?.isIgnored(rel)) continue;
        if (matchesAny(rel, include)) out.push(rel);
      }
    }
  }
  await visit(root);
  return out;
}
export function matchesAny(p: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (matchGlob(p, pat)) return true;
  }
  return false;
}
function matchGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}