import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { getWorkspaceArcDir } from "../arc-dir.js";
export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  data: unknown;
  prevHash: string;
  hash: string;
  algorithm?: "sha256" | "hmac-sha256";
}
export interface AuditVerifyResult {
  ok: boolean;
  entries: number;
  brokenAtSeq?: number;
  reason?: string;
}
const GENESIS_HASH = "0".repeat(64);
interface AuditSecurity {
  getKey?: (workspaceRoot: string) => Promise<string | undefined>;
  getHead?: (workspaceRoot: string) => Promise<string | undefined>;
  setHead?: (workspaceRoot: string, hash: string) => Promise<void>;
}
let security: AuditSecurity = {};
export function configureAuditSecurity(next: AuditSecurity): void { security = next; }
function computeHash(prevHash: string, seq: number, ts: string, type: string, data: unknown): string {
  const payload = JSON.stringify({ seq, ts, type, data, prevHash });
  return createHash("sha256").update(payload).digest("hex");
}
export function auditLogPath(workspaceRoot: string): string {
  return path.join(getWorkspaceArcDir(workspaceRoot), "audit.jsonl");
}
export async function readAuditLog(filePath: string): Promise<AuditEntry[]> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw.split("\n").filter((l) => l.trim().length > 0).map((line, index) => {
      try { return JSON.parse(line) as AuditEntry; }
      catch { throw new Error(`Malformed audit entry at line ${index + 1}`); }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
const appendChains = new Map<string, Promise<unknown>>();
const LOCK_STALE_MS = 5_000;
const LOCK_ACQUIRE_ATTEMPTS = 600;
const LOCK_ACQUIRE_WAIT_MS = 25;
const MAX_ENTRY_DATA_BYTES = 64 * 1024;
async function readLastAuditEntry(filePath: string): Promise<AuditEntry | undefined> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, "r");
    const { size } = await fh.stat();
    if (size === 0) return undefined;
    const tailLen = Math.min(size, 8192);
    const buf = Buffer.alloc(tailLen);
    await fh.read(buf, 0, tailLen, size - tailLen);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim().length > 0);
    if (!lines.length) return undefined;
    if (tailLen < size && !buf.toString("utf-8").includes("\n")) return (await readAuditLog(filePath)).at(-1);
    return JSON.parse(lines[lines.length - 1]) as AuditEntry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
async function acquireFileLock(filePath: string): Promise<fs.FileHandle> {
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    try { return await fs.open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = await fs.stat(lockPath).then((stat) => Date.now() - stat.mtimeMs > LOCK_STALE_MS).catch(() => false);
      if (stale) { await fs.rm(lockPath, { force: true }); continue; }
      if (attempt === LOCK_ACQUIRE_ATTEMPTS - 1) throw new Error("Timed out acquiring audit log lock.");
      await new Promise((resolve) => setTimeout(resolve, LOCK_ACQUIRE_WAIT_MS));
    }
  }
  throw new Error("Timed out acquiring audit log lock.");
}
export async function appendAuditEntry(workspaceRoot: string, type: string, data: unknown): Promise<AuditEntry> {
  const filePath = auditLogPath(workspaceRoot);
  const prior = appendChains.get(filePath) ?? Promise.resolve();
  const task = prior.then(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const lock = await acquireFileLock(filePath);
    try {
      const last = await readLastAuditEntry(filePath);
      const anchoredHead = await security.getHead?.(workspaceRoot);
      if (anchoredHead && last?.hash !== anchoredHead) throw new Error("Audit log is missing, truncated, or rolled back relative to its protected anchor.");
      const seq = last ? last.seq + 1 : 0;
      const ts = new Date().toISOString();
      const prevHash = last?.hash ?? GENESIS_HASH;
      const key = await security.getKey?.(workspaceRoot);
      const entry: AuditEntry = { seq, ts, type, data: truncateEntryData(data), prevHash, hash: "", algorithm: key ? "hmac-sha256" : "sha256" };
      entry.hash = computeAuthenticatedHash(key, prevHash, seq, ts, type, entry.data);
      await fs.appendFile(filePath, JSON.stringify(entry) + "\n", { encoding: "utf-8", mode: 0o600 });
      await security.setHead?.(workspaceRoot, entry.hash);
      return entry;
    } finally {
      await lock.close();
      await fs.rm(`${filePath}.lock`, { force: true });
    }
  });
  const tracked = task.catch(() => undefined).finally(() => {
    if (appendChains.get(filePath) === tracked) appendChains.delete(filePath);
  });
  appendChains.set(filePath, tracked);
  return task;
}
function truncateEntryData(data: unknown): unknown {
  try {
    const json = JSON.stringify(data);
    if (json.length <= MAX_ENTRY_DATA_BYTES) return data;
    return { truncated: true, preview: json.slice(0, MAX_ENTRY_DATA_BYTES) };
  } catch {
    return { truncated: true, preview: String(data).slice(0, 1024) };
  }
}
export function verifyAuditChain(entries: AuditEntry[], key?: string): AuditVerifyResult {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) {
      return { ok: false, entries: entries.length, brokenAtSeq: e.seq, reason: `expected sequence ${i}, got ${e.seq}` };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, entries: entries.length, brokenAtSeq: e.seq, reason: "prevHash does not match the preceding entry's hash" };
    }
    const expectedHash = e.algorithm === "hmac-sha256"
      ? computeAuthenticatedHash(key, e.prevHash, e.seq, e.ts, e.type, e.data)
      : computeHash(e.prevHash, e.seq, e.ts, e.type, e.data);
    if (expectedHash !== e.hash) {
      return { ok: false, entries: entries.length, brokenAtSeq: e.seq, reason: "hash mismatch - entry has been tampered with" };
    }
    prevHash = e.hash;
  }
  return { ok: true, entries: entries.length };
}
export async function verifyAuditLogFile(filePath: string, workspaceRoot?: string): Promise<AuditVerifyResult> {
  let entries: AuditEntry[];
  try { entries = await readAuditLog(filePath); }
  catch (error) { return { ok: false, entries: 0, reason: (error as Error).message }; }
  if (!entries.length) return { ok: false, entries: 0, reason: "audit log is missing or empty" };
  const key = workspaceRoot ? await security.getKey?.(workspaceRoot) : undefined;
  const result = verifyAuditChain(entries, key);
  if (!result.ok || !workspaceRoot) return result;
  const expectedHead = await security.getHead?.(workspaceRoot);
  if (!expectedHead || expectedHead !== entries[entries.length - 1]?.hash) return { ok: false, entries: entries.length, reason: "audit head does not match the protected anchor" };
  return result;
}
function computeAuthenticatedHash(key: string | undefined, prevHash: string, seq: number, ts: string, type: string, data: unknown): string {
  const payload = JSON.stringify({ seq, ts, type, data, prevHash });
  return key ? createHmac("sha256", key).update(payload).digest("hex") : computeHash(prevHash, seq, ts, type, data);
}