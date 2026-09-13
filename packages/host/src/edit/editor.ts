import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyEdit, type ApplyEditResult } from "./apply.js";
import { fileLock } from "./lock.js";
import { resolveAuthorizedPath } from "../security/path-policy.js";
export class FileEditor {
  constructor(private root: string, private allowExternal = false) {}
  async read(file: string, opts?: { offset?: number; limit?: number }): Promise<string> {
    const full = this.resolve(file);
    const stat = await fs.stat(full);
    if (stat.size > 4 * 1024 * 1024) throw new Error("File exceeds the 4 MiB read limit; read a smaller generated artifact instead.");
    const raw = await fs.readFile(full, "utf-8");
    const rawOffset = opts?.offset ?? 1;
    const rawLimit = opts?.limit;
    if (!Number.isInteger(rawOffset) || rawOffset < 1) throw new Error(`Invalid read offset: ${String(opts?.offset)} (want a positive integer).`);
    if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) throw new Error(`Invalid read limit: ${String(opts?.limit)} (want a positive integer).`);
    if (rawOffset === 1 && rawLimit === undefined) return raw;
    const lines = raw.split("\n");
    const end = rawLimit !== undefined ? Math.min(lines.length, rawOffset + rawLimit - 1) : lines.length;
    return lines.slice(rawOffset - 1, end).join("\n");
  }
  async exists(file: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(file));
      return true;
    } catch {
      return false;
    }
  }
  async apply(file: string, search: string, replace: string, opts?: { replaceAll?: boolean; validate?: (content: string) => Promise<void> }): Promise<ApplyEditResult & { file: string }> {
    const full = this.resolve(file);
    await fileLock.acquire(full);
    try {
      let before = "";
      let created = false;
      try {
        const st = await fs.stat(full);
        if (!st.isFile()) {
          return { ok: false, after: "", matches: 0, strategy: "exact", diff: [], error: `Not a file: ${file}`, file };
        }
        if (st.size > 4 * 1024 * 1024) {
          return { ok: false, after: "", matches: 0, strategy: "exact", diff: [], error: `File too large to edit safely (>4MB): ${file}`, file };
        }
        before = await fs.readFile(full, "utf-8");
      } catch (e) {
        if ((e as { code?: string })?.code !== "ENOENT") throw e;
        created = true;
      }
      const result = applyEdit({ before, search, replace, replaceAll: opts?.replaceAll });
      if (created) {
        if (search !== "") {
          return { ok: false, after: before, matches: 0, strategy: "exact", diff: [], error: `File does not exist: ${file}`, file };
        }
        await opts?.validate?.(replace);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, replace, { encoding: "utf-8", mode: 0o600 });
        return {
          ok: true,
          after: replace,
          matches: 1,
          strategy: "write",
          diff: [{ value: "", count: 0, added: false, removed: false }, { value: replace, count: 0, added: true, removed: false }],
          file,
        };
      }
      if (!result.ok) {
        return { ...result, file };
      }
      await opts?.validate?.(result.after);
      await this.writeAtomic(full, result.after);
      return { ...result, file };
    } finally {
      fileLock.release(full);
    }
  }
  private async writeAtomic(full: string, content: string): Promise<void> {
    let mode = 0o600;
    try {
      const st = await fs.stat(full);
      mode = st.mode & 0o777;
    } catch {}
    const tmp = `${full}.tmp.${process.pid}.${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    try {
      await fs.writeFile(tmp, content, { encoding: "utf-8", mode });
      try {
        await fs.chmod(tmp, mode);
      } catch {}
      await fs.rename(tmp, full);
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }
  resolve(file: string): string {
    return resolveAuthorizedPath(this.root, file, this.allowExternal);
  }
  applyInline(before: string, after: string): { ok: boolean; diff: { value: string; added?: boolean; removed?: boolean; count: number }[] } {
    const result = applyEdit({ before, search: "", replace: after });
    if (result.ok) {
      return { ok: true, diff: result.diff.map(d => ({ ...d, count: d.count ?? 0 })) };
    }
    return {
      ok: true,
      diff: [
        { value: before, count: 0, removed: true },
        { value: after, count: 0, added: true },
      ],
    };
  }
}