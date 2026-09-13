import { describe, it, expect } from "vitest";
import { estimateTokenCount, estimateSavedTokens } from "../src/compress/estimate";
import { buildRelevanceQuery, planKeep, isMustKeep, mustKeepWeight, segmentBlocks } from "../src/compress/bm25";
import { dedupBlocks } from "../src/compress/dedup";
import { ReadLifecycle } from "../src/compress/read-lifecycle";
describe("estimate", () => {
  it("prices CJK heavier than latin", () => {
    const latin = "hello world ".repeat(20);
    const cjk = "你好世界".repeat(20);
    expect(estimateTokenCount(cjk)).toBeGreaterThan(estimateTokenCount(latin) / 2);
  });
  it("reports non-negative savings", () => {
    expect(estimateSavedTokens("aaaa bbbb", "aa")).toBeGreaterThanOrEqual(0);
    expect(estimateSavedTokens("aa", "aaaa bbbb")).toBe(0);
  });
});
describe("bm25", () => {
  it("flags errors and negations as must-keep", () => {
    expect(isMustKeep("FATAL connection refused")).toBe(true);
    expect(isMustKeep("do not delete this")).toBe(true);
    expect(isMustKeep("some ordinary words here")).toBe(false);
  });
  it("tiers must-keep weights: errors dominate, shapes tiebreak", () => {
    expect(mustKeepWeight("FATAL disk full")).toBe(1000);
    expect(mustKeepWeight("do not delete")).toBe(1000);
    expect(mustKeepWeight("info heartbeat 42 ok")).toBe(1);
    expect(mustKeepWeight("src/a.ts missing")).toBe(5);
    expect(mustKeepWeight("some ordinary words here")).toBe(0);
  });
  it("keeps error rows over filler", () => {
    const rows = [...Array.from({ length: 30 }, (_, i) => `info heartbeat ${i} ok`), "FATAL disk full on node 7"];
    const plan = planKeep(rows, buildRelevanceQuery("disk failure", "shell.run"), 5);
    expect(plan.dropped).toBe(rows.length - 5);
    expect(plan.keep).toContain(rows.length - 1);
  });
  it("back bias keeps log tails, front bias keeps heads", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `plain line number ${i} here`);
    const back = planKeep(rows, [], 5, "back");
    expect(back.keep).toContain(29);
    const front = planKeep(rows, [], 5, "front");
    expect(front.keep).toContain(0);
  });
  it("non-positive keep counts fail open", () => {
    const rows = ["a", "b", "c"];
    expect(planKeep(rows, [], 0)).toEqual({ keep: [0, 1, 2], dropped: 0 });
  });
  it("no-bias with zero signal spreads evenly", () => {
    const rows = Array.from({ length: 30 }, () => "qqq");
    const plan = planKeep(rows, [], 5, "none");
    expect(plan.keep).toEqual([0, 6, 12, 18, 24]);
  });
  it("segments on blank lines", () => {
    expect(segmentBlocks("a\n\nb\n\nc")).toEqual(["a", "b", "c"]);
  });
});
describe("dedup", () => {
  it("folds later verbatim spans into pointers", () => {
    const span = ["line one here", "line two here", "line three here", "line four here"].join("\n");
    const out = dedupBlocks([
      { text: `header\n${span}\nfooter`, turn: 0 },
      { text: `other\n${span}\nend`, turn: 1 },
    ]);
    expect(out[0]).toBe(`header\n${span}\nfooter`);
    expect(String(out[1])).toContain("same as msg 0");
  });
  it("respects protected turns", () => {
    const span = ["alpha line one", "alpha line two", "alpha line three"].join("\n");
    const out = dedupBlocks([
      { text: span, turn: 0, protect: true },
      { text: span, turn: 1 },
    ]);
    expect(out[1]).toBe(span);
  });
});
describe("read lifecycle", () => {
  it("marks reads stale after an edit", () => {
    const lc = new ReadLifecycle();
    lc.noteRead("a.ts", 0, Number.MAX_SAFE_INTEGER, 1, 100);
    lc.noteEdit("a.ts", 2);
    expect(lc.verdict("a.ts", 0, Number.MAX_SAFE_INTEGER, 1)).toBe("stale");
    expect(lc.elide("a.ts", "stale")).toContain("stale");
  });
  it("marks reads superseded by a later full read", () => {
    const lc = new ReadLifecycle();
    lc.noteRead("a.ts", 10, 20, 1, 100);
    lc.noteRead("a.ts", 0, Number.MAX_SAFE_INTEGER, 2, 500);
    expect(lc.verdict("a.ts", 10, 20, 1)).toBe("superseded");
  });
  it("keeps fresh reads fresh", () => {
    const lc = new ReadLifecycle();
    lc.noteRead("a.ts", 0, Number.MAX_SAFE_INTEGER, 1, 100);
    expect(lc.verdict("a.ts", 0, Number.MAX_SAFE_INTEGER, 1)).toBe("fresh");
  });
  it("orders same-turn edit/read by sequence", () => {
    const lc = new ReadLifecycle();
    const r1 = lc.noteRead("a.ts", 0, Number.MAX_SAFE_INTEGER, 5, 100);
    lc.noteEdit("a.ts", 5);
    expect(lc.verdict("a.ts", 0, Number.MAX_SAFE_INTEGER, 5, r1)).toBe("stale");
    const r2 = lc.noteRead("a.ts", 0, Number.MAX_SAFE_INTEGER, 5, 100);
    expect(lc.verdict("a.ts", 0, Number.MAX_SAFE_INTEGER, 5, r2)).toBe("fresh");
    const lc2 = new ReadLifecycle();
    lc2.noteRead("a.ts", 0, Number.MAX_SAFE_INTEGER, 5, 100);
    expect(lc2.verdict("a.ts", 10, 20, 5, 0)).toBe("superseded");
  });
});