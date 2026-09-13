import * as path from "node:path";
export class FileLockManager {
  private locked = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();
  private key(file: string): string {
    const resolved = path.resolve(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
  async acquire(file: string, timeoutMs = 30_000): Promise<void> {
    const k = this.key(file);
    if (!this.locked.has(k)) {
      this.locked.add(k);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiters.get(k) ?? [];
      const entry = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const q = this.waiters.get(k);
        if (q) {
          const at = q.indexOf(entry);
          if (at >= 0) q.splice(at, 1);
          if (q.length === 0) this.waiters.delete(k);
        }
        reject(new Error(`Timed out waiting for file lock: ${file}`));
      }, timeoutMs);
      queue.push(entry);
      this.waiters.set(k, queue);
    });
  }
  release(file: string): void {
    const k = this.key(file);
    const queue = this.waiters.get(k);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.waiters.delete(k);
    if (next) {
      next();
    } else {
      this.locked.delete(k);
    }
  }
}
export const fileLock = new FileLockManager();