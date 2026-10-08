import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CheckpointStore } from "../src/checkpoint/store";
let work: string;
let store: CheckpointStore;
let root: string;
beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), "arc-diffrev-"));
  store = new CheckpointStore({ dir: path.join(work, "store") });
  root = path.join(work, "ws");
  await fs.mkdir(root, { recursive: true });
});
afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function applyEdit(turnId: string, rel: string, next: string): Promise<string> {
  const abs = path.join(root, rel);
  const taken = await store.snapshot(turnId, root, [rel]);
  const hash = taken.files[rel];
  await fs.writeFile(abs, next, "utf-8");
  return hash;
}
class PreStateBook {
  private readonly map = new Map<string, { rel: string; hash: string }>();
  constructor(private readonly store: CheckpointStore, private readonly root: string) {}
  async record(stepId: string, turnId: string, rel: string): Promise<void> {
    const taken = await this.store.snapshot(turnId, this.root, [rel]);
    const hash = taken.files[rel];
    if (typeof hash === "string") this.map.set(stepId, { rel, hash });
  }
  earliest(rel: string): { stepId: string; hash: string } | undefined {
    for (const [stepId, v] of this.map) {
      if (v.rel === rel) return { stepId, hash: v.hash };
    }
    return undefined;
  }
  forgetFile(rel: string): void {
    for (const [id, v] of [...this.map]) {
      if (v.rel === rel) this.map.delete(id);
    }
  }
  size(): number {
    return this.map.size;
  }
  async revertFile(rel: string): Promise<{ ok: boolean; error?: string }> {
    const pre = this.earliest(rel);
    if (!pre) return { ok: false, error: "no pre-edit snapshot is recorded for this file" };
    const r = await this.store.restoreSingleFile(this.root, rel, pre.hash);
    if (r.errors?.length) return { ok: false, error: r.errors.join("; ") };
    this.forgetFile(rel);
    return { ok: true };
  }
}
describe("per-edit pre-state capture", () => {
  it("returns the content hash from before the edit was written", async () => {
    const abs = path.join(root, "a.txt");
    await fs.writeFile(abs, "v0\n", "utf-8");
    const hash = await applyEdit("t1", "a.txt", "v1\n");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    const r = await store.restoreSingleFile(root, "a.txt", hash);
    expect(r.errors ?? []).toEqual([]);
    expect(await fs.readFile(abs, "utf-8")).toBe("v0\n");
  });
  it("restores the state before a specific edit when a turn edits the same file repeatedly", async () => {
    const abs = path.join(root, "a.txt");
    await fs.writeFile(abs, "v0\n", "utf-8");
    const preEdit1 = await applyEdit("t1", "a.txt", "v1\n");
    const preEdit2 = await applyEdit("t1", "a.txt", "v2\n");
    const merged = await store.load(root, "t1");
    expect(merged!.files["a.txt"]).toBe(preEdit2);
    expect(preEdit1).not.toBe(preEdit2);
    await store.restoreSingleFile(root, "a.txt", preEdit2);
    expect(await fs.readFile(abs, "utf-8")).toBe("v1\n");
    await store.restoreSingleFile(root, "a.txt", preEdit1);
    expect(await fs.readFile(abs, "utf-8")).toBe("v0\n");
  });
  it("deletes a file the agent created when its edit is rejected", async () => {
    const abs = path.join(root, "added.txt");
    const preHash = await applyEdit("t1", "added.txt", "created by agent\n");
    expect(preHash).toBe("__none__");
    const r = await store.restoreSingleFile(root, "added.txt", preHash);
    expect(r.errors ?? []).toEqual([]);
    expect(r.restored).toContain("added.txt");
    await expect(fs.readFile(abs, "utf-8")).rejects.toThrow();
  });
  it("still rejects hashes that are not blob hashes", async () => {
    const abs = path.join(root, "a.txt");
    await fs.writeFile(abs, "v0\n", "utf-8");
    const r = await store.restoreSingleFile(root, "a.txt", "../../etc/passwd");
    expect(r.errors?.length).toBe(1);
    expect(await fs.readFile(abs, "utf-8")).toBe("v0\n");
  });
});
describe("rejecting a file edited more than once", () => {
  it("reverts to the state before the first edit, not the last", async () => {
    const abs = path.join(root, "a.txt");
    await fs.writeFile(abs, "v0\n", "utf-8");
    const book = new PreStateBook(store, root);
    await book.record("s1", "t1", "a.txt");
    await fs.writeFile(abs, "v1\n", "utf-8");
    await book.record("s2", "t1", "a.txt");
    await fs.writeFile(abs, "v2\n", "utf-8");
    expect(await fs.readFile(abs, "utf-8")).toBe("v2\n");
    const r = await book.revertFile("a.txt");
    expect(r.ok).toBe(true);
    expect(await fs.readFile(abs, "utf-8")).toBe("v0\n");
    expect(book.size()).toBe(0);
  });
  it("leaves other files untouched", async () => {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    await fs.writeFile(a, "a0\n", "utf-8");
    await fs.writeFile(b, "b0\n", "utf-8");
    const book = new PreStateBook(store, root);
    await book.record("s1", "t1", "a.txt");
    await fs.writeFile(a, "a1\n", "utf-8");
    await book.record("s2", "t1", "b.txt");
    await fs.writeFile(b, "b1\n", "utf-8");
    await book.revertFile("a.txt");
    expect(await fs.readFile(a, "utf-8")).toBe("a0\n");
    expect(await fs.readFile(b, "utf-8")).toBe("b1\n");
    expect(book.size()).toBe(1);
  });
  it("reports a clear error when nothing was recorded for the file", async () => {
    const book = new PreStateBook(store, root);
    const r = await book.revertFile("never-edited.txt");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no pre-edit snapshot/);
  });
});