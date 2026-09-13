import { createHash } from "node:crypto";
import { saveBlob, loadBlob } from "./store.js";
import { compactLossless, diffStripIndex, detectEol } from "./lossless.js";
import { estimateTokenCount, estimateSavedTokens } from "./estimate.js";
import { buildRelevanceQuery, planKeep } from "./bm25.js";
export type ContentKind = "json-array" | "json-object" | "log" | "search" | "diff" | "text";
export interface CompressOutcome {
  output: string;
  id?: string;
  kind: ContentKind | "none";
  originalLength: number;
  saved: number;
}
const MIN_SAVINGS_RATIO = 0.3;
const MAX_STORE_BYTES = 1024 * 1024;
const MIN_COMPRESS_CHARS = 4096;
const ERROR_MARKERS = /error|fail|exception|warn|denied|invalid|fatal|trace|timeout|abort|reject/i;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 200;
const SKIP_MAX = 500;
const cache = new Map<string, { compressed: string; id: string; kind: ContentKind; exp: number }>();
const skipSet = new Map<string, number>();
function cacheKey(toolName: string, workspaceRoot: string, text: string): string {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 32);
  const scope = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return `${toolName}:${scope}:${text.length}:${digest}`;
}
function cacheGet(key: string): { compressed: string; id: string; kind: ContentKind } | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}
function cachePut(key: string, compressed: string, id: string, kind: ContentKind): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { compressed, id, kind, exp: Date.now() + CACHE_TTL_MS });
}
function withRetrievalNote(compressed: string, id: string | undefined): string {
  return id ? `${compressed}\n[Compressed output. To view the full original, call context.retrieve with id "${id}".]` : compressed;
}
function skipPut(key: string): void {
  if (skipSet.size >= SKIP_MAX) {
    const now = Date.now();
    for (const [k, exp] of skipSet) {
      if (exp <= now) skipSet.delete(k);
    }
    while (skipSet.size >= SKIP_MAX) {
      const oldest = skipSet.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      skipSet.delete(oldest);
    }
  }
  skipSet.set(key, Date.now() + CACHE_TTL_MS);
}
function skipGet(key: string): boolean {
  const exp = skipSet.get(key);
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    skipSet.delete(key);
    return false;
  }
  return true;
}
const GREP_ROW_RE = /^(.+?):(\d+):(.*)$/;
const TIMESTAMP_ROW_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
function looksLikeSearch(lines: string[]): boolean {
  if (lines.length < 10) return false;
  let hits = 0;
  const sample = lines.slice(0, Math.min(lines.length, 60));
  for (const l of sample) {
    if (TIMESTAMP_ROW_RE.test(l)) return false;
    if (GREP_ROW_RE.test(l)) hits++;
  }
  return hits >= sample.length * 0.5;
}
function looksLikeDiff(text: string): boolean {
  return (
    text.includes("diff --git") ||
    /^@@ /m.test(text) ||
    (/^--- /m.test(text) && /^\+\+\+ /m.test(text))
  );
}
export function detectKind(text: string): ContentKind {
  const t = text.trimStart();
  if (t.startsWith("[") || t.startsWith("{")) {
    if (text.length < 256 * 1024) {
      try {
        const v = JSON.parse(text);
        if (Array.isArray(v)) return "json-array";
        if (v !== null && typeof v === "object") return "json-object";
      } catch {}
    }
  }
  const lines = text.split(/\r?\n/);
  if (looksLikeDiff(t)) return "diff";
  if (looksLikeSearch(lines)) return "search";
  if (lines.length >= 40) return "log";
  return "text";
}
export function crushSearch(text: string, toolName = "", bias: "front" | "back" = "front"): string | undefined {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  if (lines.length < 20) return undefined;
  const query = buildRelevanceQuery("", toolName, "");
  const plan = planKeep(lines, query, 40, bias);
  if (plan.dropped <= 0) return undefined;
  const keepSet = new Set(plan.keep);
  const out: string[] = [];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keepSet.has(i)) {
      if (gap > 0) {
        out.push(`... (${gap} lines omitted)`);
        gap = 0;
      }
      out.push(lines[i]);
    } else {
      gap++;
    }
  }
  if (gap > 0) out.push(`... (${gap} lines omitted)`);
  const body = out.join(eol);
  if (body.length >= text.length) return undefined;
  return `[... ${plan.dropped} of ${lines.length} lines omitted]${eol}${body}`;
}
export function crushDiff(text: string, maxHunksPerFile = 8, maxContext = 3): string | undefined {
  if (!looksLikeDiff(text)) return undefined;
  const deindexed = diffStripIndex(text);
  const lines = deindexed.split(/\r?\n/);
  if (lines.length < 30) return undefined;
  const out: string[] = [];
  let hunks = 0;
  let droppedHunks = 0;
  let i = 0;
  const isFileHeader = (at: number): boolean =>
    lines[at].startsWith("--- ") && at + 1 < lines.length && lines[at + 1].startsWith("+++ ");
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git")) {
      hunks = 0;
      out.push(line);
      i++;
      continue;
    }
    if (isFileHeader(i)) {
      hunks = 0;
      out.push(line);
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      hunks++;
      if (hunks > maxHunksPerFile) {
        droppedHunks++;
        i++;
        while (
          i < lines.length &&
          !lines[i].startsWith("@@") &&
          !lines[i].startsWith("diff --git") &&
          !isFileHeader(i)
        ) i++;
        continue;
      }
      out.push(line);
      i++;
      let ctx = 0;
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git") && !isFileHeader(i)) {
        const l = lines[i];
        if (l.startsWith("+") || l.startsWith("-")) {
          out.push(l);
          ctx = 0;
        } else if (ctx < maxContext) {
          out.push(l);
          ctx++;
        } else if (ctx === maxContext) {
          out.push(" ...");
          ctx++;
        }
        i++;
      }
    } else {
      out.push(line);
      i++;
    }
  }
  if (droppedHunks === 0 && out.length >= lines.length) return undefined;
  const eol = detectEol(text);
  const body = out.join(eol);
  if (body.length >= text.length) return undefined;
  return droppedHunks > 0 ? `[... ${droppedHunks} hunks omitted]${eol}${body}` : body;
}
export async function compressForContext(text: string, toolName: string, workspaceRoot: string): Promise<CompressOutcome> {
  if (text.length < MIN_COMPRESS_CHARS) return { output: text, kind: "none", originalLength: text.length, saved: 0 };
  const key = cacheKey(toolName, workspaceRoot, text);
  if (skipGet(key)) return { output: text, kind: "none", originalLength: text.length, saved: 0 };
  const cached = cacheGet(key);
  if (cached) {
    const live = await loadBlob(workspaceRoot, cached.id).catch(() => undefined);
    if (live && !live.truncated && live.content !== undefined) {
      const out = withRetrievalNote(cached.compressed, cached.id);
      return { output: out, id: cached.id, kind: cached.kind, originalLength: text.length, saved: estimateSavedTokens(text, out) };
    }
    cache.delete(key);
  }
  const kind = detectKind(text);
  const lossless = compactLossless(text, kind === "search" ? "search" : kind === "diff" ? "diff" : "auto");
  const base = lossless.length < text.length ? lossless : text;
  let compressed: string | undefined;
  if (kind === "json-array") compressed = crushJsonArray(text, toolName) ?? crushLines(base, 25, 15);
  else if (kind === "search") compressed = crushSearch(base, toolName, "front") ?? crushLines(base, 25, 15);
  else if (kind === "diff") compressed = crushDiff(base) ?? crushLines(base, 25, 15);
  else if (kind === "log") compressed = crushSearch(base, toolName, "back") ?? crushLines(base, 25, 15);
  else if (kind === "json-object") compressed = crushJsonObject(text) ?? crushLines(base, 40, 20);
  else compressed = crushLines(base, 40, 20);
  const savedTokens = compressed ? estimateTokenCount(text) - estimateTokenCount(compressed) : 0;
  const needsRatio = estimateTokenCount(text) * MIN_SAVINGS_RATIO;
  if (!compressed || savedTokens <= 0 || savedTokens < needsRatio) {
    skipPut(key);
    return { output: text, kind: "none", originalLength: text.length, saved: 0 };
  }
  let id: string | undefined;
  if (text.length <= MAX_STORE_BYTES) {
    try {
      id = await saveBlob(workspaceRoot, toolName, text);
    } catch {}
  }
  if (id) cachePut(key, compressed, id, kind);
  const finalOut = withRetrievalNote(compressed, id);
  return { output: finalOut, id, kind, originalLength: text.length, saved: estimateSavedTokens(text, finalOut) };
}
const MAX_ROW_CHARS = 8000;
function fullRow(r: unknown): string {
  try {
    const s = JSON.stringify(r) ?? "";
    return s.length > MAX_ROW_CHARS ? `${s.slice(0, MAX_ROW_CHARS)}...(truncated ${s.length - MAX_ROW_CHARS} chars)` : s;
  } catch {
    return "";
  }
}
export function crushJsonArray(text: string, toolName = ""): string | undefined {
  if (text.length > 256 * 1024) return undefined;
  let rows: unknown[];
  try {
    const v = JSON.parse(text);
    if (!Array.isArray(v)) return undefined;
    rows = v;
  } catch {
    return undefined;
  }
  if (rows.length <= 40 || rows.length > 20_000) return undefined;
  const keepHead = 3;
  const keepTail = 5;
  const maxKeep = 40;
  const kept = new Set<number>();
  for (let i = 0; i < Math.min(keepHead, rows.length); i++) kept.add(i);
  for (let i = rows.length - 1; i >= rows.length - keepTail && i >= 0; i--) kept.add(i);
  const rowTexts = rows.map((r) => {
    try {
      return (JSON.stringify(r) ?? "").slice(0, 2000);
    } catch {
      return "";
    }
  });
  for (let i = 0; i < rows.length && kept.size < maxKeep; i++) {
    if (kept.has(i)) continue;
    const s = rowTexts[i];
    if (s.length >= 12 && ERROR_MARKERS.test(s)) kept.add(i);
  }
  if (kept.size < maxKeep) {
    try {
      const query = buildRelevanceQuery("", toolName, "");
      const plan = planKeep(rowTexts, query, maxKeep, "front");
      for (const idx of plan.keep) {
        if (kept.size >= maxKeep) break;
        kept.add(idx);
      }
    } catch {
    }
  }
  for (let i = 0; i < rows.length && kept.size < maxKeep; i++) {
    if (!kept.has(i)) kept.add(i);
  }
  const omitted = rows.length - kept.size;
  if (omitted <= 0) return undefined;
  const parts: string[] = [];
  let prev = -1;
  let omittedRun = 0;
  const pushGap = (end: number) => {
    if (end > prev + 1) omittedRun += end - prev - 1;
  };
  for (let i = 0; i < rows.length; i++) {
    if (kept.has(i)) {
      pushGap(i);
      if (prev >= 0) {
        if (omittedRun > 0) parts.push(`... (${omittedRun} rows omitted)`);
        else parts.push(",");
      }
      parts.push(`[${i}] ${fullRow(rows[i])}`);
      omittedRun = 0;
      prev = i;
    }
  }
  if (rows.length - 1 > prev) omittedRun += rows.length - 1 - prev;
  const body = parts.join(" ");
  const summary = `[... ${omitted} of ${rows.length} rows omitted]`;
  const crushed = `${summary}\n${body}`;
  if (crushed.length >= text.length) return undefined;
  return crushed;
}
export function crushJsonObject(text: string): string | undefined {
  if (text.length > 256 * 1024) return undefined;
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    const compact = JSON.stringify(v);
    if (compact.length >= text.length * 0.7) return undefined;
    return compact;
  } catch {
    return undefined;
  }
}
export function crushLines(text: string, keepHead: number, keepTail: number): string | undefined {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  if (lines.length <= keepHead + keepTail) return undefined;
  const head = lines.slice(0, keepHead);
  const tail = lines.slice(-keepTail);
  const omitted = lines.length - head.length - tail.length;
  const collapsed = [...head, `... (${omitted} lines omitted)`, ...tail].join(eol);
  if (collapsed.length >= text.length) return undefined;
  return collapsed;
}