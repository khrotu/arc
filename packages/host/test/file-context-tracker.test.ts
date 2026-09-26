import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { FileContextTracker } from "../src/context/context";
describe("FileContextTracker", () => {
  let root: string;
  let dbPath: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "arc-context-"));
    dbPath = path.join(root, "context.db");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it("tracks reads and edits per file", async () => {
    const tracker = new FileContextTracker({ dbPath, saveDebounceMs: 5 });
    await tracker.load();
    tracker.touch("a.ts", "read");
    tracker.touch("a.ts", "read");
    tracker.touch("a.ts", "edit");
    const entry = tracker.get("a.ts");
    expect(entry?.reads).toBe(2);
    expect(entry?.edits).toBe(1);
    expect(entry?.lastRead).toBeDefined();
    expect(entry?.lastEdit).toBeDefined();
  });
  it("orders list() by most-recently-touched first", async () => {
    const tracker = new FileContextTracker({ dbPath, saveDebounceMs: 5 });
    await tracker.load();
    tracker.touch("a.ts", "read");
    tracker.touch("b.ts", "read");
    tracker.touch("a.ts", "edit");
    const list = tracker.list();
    expect(list[0].file).toBe("a.ts");
    expect(list[1].file).toBe("b.ts");
  });
  it("evicts least-recently-touched entries beyond maxEntries", async () => {
    const tracker = new FileContextTracker({ dbPath, maxEntries: 2, saveDebounceMs: 5 });
    await tracker.load();
    tracker.touch("a.ts", "read");
    tracker.touch("b.ts", "read");
    tracker.touch("c.ts", "read");
    expect(tracker.size()).toBe(2);
    expect(tracker.get("a.ts")).toBeUndefined();
    expect(tracker.get("b.ts")).toBeDefined();
    expect(tracker.get("c.ts")).toBeDefined();
  });
  it("persists to disk and reloads", async () => {
    const tracker = new FileContextTracker({ dbPath, saveDebounceMs: 5 });
    await tracker.load();
    tracker.touch("a.ts", "edit");
    await tracker.save();
    const raw = await fs.readFile(dbPath, "utf-8");
    expect(JSON.parse(raw).entries.length).toBe(1);
    const reloaded = new FileContextTracker({ dbPath });
    await reloaded.load();
    expect(reloaded.get("a.ts")?.edits).toBe(1);
  });
  it("returns the n most recent files", async () => {
    const tracker = new FileContextTracker({ dbPath, saveDebounceMs: 5 });
    await tracker.load();
    tracker.touch("a.ts", "read");
    tracker.touch("b.ts", "read");
    tracker.touch("c.ts", "read");
    const recent = tracker.recent(2);
    expect(recent.map((e) => e.file)).toEqual(["c.ts", "b.ts"]);
  });
});