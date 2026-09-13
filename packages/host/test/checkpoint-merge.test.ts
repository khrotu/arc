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
  work = await fs.mkdtemp(path.join(os.tmpdir(), "arc-ckpt2-"));
  storeDir = path.join(work, "store");
  store = new CheckpointStore({ dir: storeDir });
  root = path.join(work, "ws");
  await fs.mkdir(root, { recursive: true });
});
afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("CheckpointStore snapshot merging", () => {
  it("merges files within the same turn instead of overwriting", async () => {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    await fs.writeFile(a, "a-before");
    await fs.writeFile(b, "b-before");
    await store.snapshot("t1", root, ["a.txt"]);
    await fs.writeFile(a, "a-after");
    await fs.writeFile(b, "b-after");
    await store.snapshot("t1", root, ["b.txt"]);
    const snap = await store.load(root, "t1");
    expect(Object.keys(snap?.files ?? {}).sort()).toEqual(["a.txt", "b.txt"]);
    expect(snap?.files["a.txt"]).not.toBe("__none__");
    expect(snap?.files["b.txt"]).not.toBe("__none__");
  });
  it("shell-only snapshots in the same turn do not wipe prior file entries", async () => {
    const a = path.join(root, "a.txt");
    await fs.writeFile(a, "before");
    await store.snapshot("t1", root, ["a.txt"]);
    await fs.writeFile(a, "after");
    await store.snapshot("t1", root, []);
    await fs.writeFile(a, "after2");
    const r = await store.restore(root, "t1");
    expect(r.restored).toContain("a.txt");
    expect(await fs.readFile(a, "utf-8")).toBe("before");
  });
  it("keeps todo/label from previous snapshot of the same turn when not provided", async () => {
    await store.snapshot("t1", root, ["a.txt"], [{ id: "1", text: "task", state: "in_progress" }], "label-1");
    await store.snapshot("t1", root, []);
    const snap = await store.load(root, "t1");
    expect(snap?.todoItems?.[0].text).toBe("task");
    expect(snap?.label).toBe("label-1");
  });
});
describe("CheckpointStore restore resilience", () => {
  it("continues restoring other files when one blob is missing", async () => {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    await fs.writeFile(a, "a1");
    await fs.writeFile(b, "b1");
    await store.snapshot("t1", root, ["a.txt", "b.txt"]);
    await fs.writeFile(a, "x");
    await fs.writeFile(b, "y");
    const snap = await store.load(root, "t1");
    const hash = snap!.files["a.txt"];
    const missingBlob = path.join(storeDir, "objects", hash.slice(0, 2), `${hash}.bin`);
    await fs.unlink(missingBlob);
    const r = await store.restore(root, "t1");
    expect(r.restored).toContain("b.txt");
    expect(await fs.readFile(b, "utf-8")).toBe("b1");
    expect(r.errors?.some((e) => e.startsWith("a.txt"))).toBe(true);
  });
});
describe("CheckpointStore restoreRange", () => {
  it("restores the union of files across undone turns, oldest pre-state wins", async () => {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    await fs.writeFile(a, "orig");
    await store.snapshot("u1", root, ["a.txt"]);
    await fs.writeFile(a, "edited");
    await store.snapshot("u2", root, ["b.txt"]);
    await fs.writeFile(b, "createdB");
    await fs.writeFile(a, "edited-again");
    const all = await store.listTurns(root);
    expect(all.length).toBe(2);
    const r = await store.restoreRange(root, 0, Date.now() + 60_000);
    expect(r.restored).toContain("a.txt");
    expect(r.restored).toContain("b.txt");
    expect(await fs.readFile(a, "utf-8")).toBe("orig");
    await expect(fs.readFile(b, "utf-8")).rejects.toThrow();
    expect(await store.listTurns(root)).toEqual([]);
  });
});
describe("CheckpointStore cache", () => {
  it("listTurns reflects externally deleted metas despite cache", async () => {
    await store.snapshot("t1", root, ["a.txt"]);
    await store.snapshot("t2", root, ["a.txt"]);
    await store.load(root, "t1");
    await fs.unlink(path.join(storeDir, "turns", encodeURIComponent(root), "t1.json"));
    expect(await store.listTurns(root)).toEqual(["t2"]);
  });
});