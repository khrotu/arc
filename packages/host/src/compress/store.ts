import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { getWorkspaceArcDir } from "../arc-dir.js";
const MAX_BLOBS = 200;
const MAX_DIR_BYTES = 64 * 1024 * 1024;
function contextDir(workspaceRoot: string): string {
  return path.join(getWorkspaceArcDir(workspaceRoot), "context");
}
export async function saveBlob(workspaceRoot: string, _toolName: string, content: string): Promise<string> {
  const full = createHash("sha256").update(content).digest("hex");
  const dir = contextDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${full}.txt`);
  try {
    await fs.writeFile(target, content, { encoding: "utf-8", mode: 0o600 });
  } catch {
    try {
      await fs.access(target);
    } catch {
      throw new Error("failed to persist context blob");
    }
  }
  await prune(dir);
  return full;
}
const BLOB_NAME_RE = /^[0-9a-f]{64}\.txt$/;
const MAX_BLOB_READ = 512 * 1024;
export async function loadBlob(workspaceRoot: string, id: string): Promise<{ content: string; truncated: boolean; totalBytes: number } | undefined> {
  const safe = String(id ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(safe)) return undefined;
  const target = path.join(contextDir(workspaceRoot), `${safe}.txt`);
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return undefined;
    if (stat.size > 64 * 1024 * 1024) return undefined;
    const fh = await fs.open(target, "r");
    try {
      const hash = createHash("sha256");
      const decoder = new StringDecoder("utf-8");
      let content = "";
      let contentBytes = 0;
      const truncated = stat.size > MAX_BLOB_READ;
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
        if (contentBytes < MAX_BLOB_READ) {
          const want = Math.min(bytesRead, MAX_BLOB_READ - contentBytes);
          content += decoder.write(buf.subarray(0, want));
          contentBytes += want;
        }
      }
      const tail = decoder.end();
      if (tail && !(truncated && tail === "�")) content += tail;
      if (hash.digest("hex") !== safe) return undefined;
      return { content, truncated, totalBytes: stat.size };
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}
async function prune(dir: string): Promise<void> {
  let entries: { name: string; size: number; mtimeMs: number }[] = [];
  try {
    const names = await fs.readdir(dir);
    const stats = await Promise.all(
      names
        .filter((n) => BLOB_NAME_RE.test(n))
        .map(async (n) => {
        try {
          const s = await fs.stat(path.join(dir, n));
          return { name: n, size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return undefined;
        }
      }),
    );
    entries = stats.filter((s): s is { name: string; size: number; mtimeMs: number } => s !== undefined);
  } catch {
    return;
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  while (entries.length > MAX_BLOBS || total > MAX_DIR_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    try {
      await fs.unlink(path.join(dir, oldest.name));
      total -= oldest.size;
    } catch {}
  }
}