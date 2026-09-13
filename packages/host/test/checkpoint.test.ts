import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CheckpointStore } from "../src/checkpoint/store";
let work: string;
let storeDir: string;
let store: CheckpointStore;
let root: string;
beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), "arc-ckpt-"));
  storeDir = path.join(work, "store");
  store = new CheckpointStore({ dir: storeDir });
  root = path.join(work, "ws");
  await fs.mkdir(root, { recursive: true });
});
afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("CheckpointStore", () => {
  it("drops invalid blob hashes on load", async () => {
    const f = path.join(root, "a.txt");
    await fs.writeFile(f, "hello\n", "utf-8");
    await store.snapshot("t1", root, ["a.txt"]);
    const snap = await store.load(root, "t1");
    expect(snap).toBeDefined();
    snap!.files["evil"] = "../../../../etc/passwd";
    snap!.files["short"] = "abc123";
    const metaDir = path.join(storeDir, "turns", encodeURIComponent(root));
    await fs.writeFile(path.join(metaDir, "t1.json"), JSON.stringify(snap), "utf-8");
    const fresh = new CheckpointStore({ dir: storeDir });
    const reloaded = await fresh.load(root, "t1");
    expect(reloaded!.files["evil"]).toBeUndefined();
    expect(reloaded!.files["short"]).toBeUndefined();
    expect(reloaded!.files["a.txt"]).toMatch(/^[0-9a-f]{32}$/);
  });
  it("snapshots and restores edited files", async () => {
    const f = path.join(root, "a.txt");
    await fs.writeFile(f, "before\n", "utf-8");
    await store.snapshot("t1", root, ["a.txt"]);
    await fs.writeFile(f, "after\n", "utf-8");
    const r = await store.restore(root, "t1");
    expect(r.restored).toContain("a.txt");
    expect(await fs.readFile(f, "utf-8")).toBe("before\n");
  });
  it("deletes files that did not exist before the turn", async () => {
    const f = path.join(root, "new.txt");
    await fs.writeFile(f, "hello", "utf-8");
    await store.snapshot("t1", root, ["new.txt"]);
    await fs.unlink(f);
    const r = await store.restore(root, "t1");
    expect(r.restored).toContain("new.txt");
    expect(await fs.readFile(f, "utf-8")).toBe("hello");
  });
  it("drops later snapshots on restore", async () => {
    const f = path.join(root, "a.txt");
    await fs.writeFile(f, "v1", "utf-8");
    await store.snapshot("t1", root, ["a.txt"]);
    await fs.writeFile(f, "v2", "utf-8");
    await store.snapshot("t2", root, ["a.txt"]);
    await fs.writeFile(f, "v3", "utf-8");
    await store.snapshot("t3", root, ["a.txt"]);
    await store.restore(root, "t1");
    const turns = await store.listTurns(root);
    expect(turns).toEqual(["t1"]);
  });
  it("cost scales with touched files, not repo size (perf characteristic)", { timeout: 30_000 }, async () => {
    for (let i = 0; i < 5000; i++) {
      await fs.writeFile(path.join(root, `noise-${i}.txt`), "noise");
    }
    const target = path.join(root, "mine.txt");
    await fs.writeFile(target, "v1", "utf-8");
    const t0 = Date.now();
    await store.snapshot("t1", root, ["mine.txt"]);
    const t1 = Date.now();
    expect(t1 - t0).toBeLessThan(1000);
    const blobDir = path.join(storeDir, "objects");
    const blobs = await fs.readdir(blobDir).catch(() => []);
    let total = 0;
    async function count(d: string) {
      const es = await fs.readdir(d, { withFileTypes: true });
      for (const e of es) {
        if (e.isDirectory()) await count(path.join(d, e.name));
        else total++;
      }
    }
    await count(blobDir);
    expect(total).toBe(1);
  });
  it("reports conflicts when current content differs from snapshot", async () => {
    const f = path.join(root, "a.txt");
    await fs.writeFile(f, "snap", "utf-8");
    await store.snapshot("t1", root, ["a.txt"]);
    await fs.writeFile(f, "user-edit", "utf-8");
    const r = await store.restore(root, "t1");
    expect(r.conflicts).toContain("a.txt");
    expect(await fs.readFile(f, "utf-8")).toBe("snap");
  });
  it("gc keeps blobs still referenced by another workspace root", async () => {
    const rootB = path.join(work, "ws-b");
    await fs.mkdir(rootB, { recursive: true });
    const fa = path.join(root, "a.txt");
    const fb = path.join(rootB, "b.txt");
    await fs.writeFile(fa, "shared-content", "utf-8");
    await fs.writeFile(fb, "shared-content", "utf-8");
    await store.snapshot("t1", root, ["a.txt"]);
    await store.snapshot("t1", rootB, ["b.txt"]);
    await store.restoreRange(root, 0, Date.now());
    expect(await store.listTurns(root)).toEqual([]);
    await fs.writeFile(fb, "changed", "utf-8");
    const r = await store.restore(rootB, "t1");
    expect(r.restored).toContain("b.txt");
    expect(await fs.readFile(fb, "utf-8")).toBe("shared-content");
  });
});