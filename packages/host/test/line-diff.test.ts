import { describe, it, expect } from "vitest";
import { diffLines } from "../src/edit/line-diff";
function totals(hunks: { added?: boolean; removed?: boolean; count: number }[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    if (h.added) added += h.count;
    else if (h.removed) removed += h.count;
  }
  return { added, removed };
}
describe("diffLines", () => {
  it("keeps a pure replacement that shares no lines", () => {
    const before = "a\n  <h1>Title</h1>\nz\n";
    const after = "a\n<header>\n<h1>Title</h1>\n<nav/>\n</header>\nz\n";
    const hunks = diffLines(before, after);
    expect(totals(hunks)).toEqual({ added: 4, removed: 1 });
  });
  it("keeps trailing changes after a shared anchor", () => {
    const before = "same\nold-tail-a\nold-tail-b\n";
    const after = "same\nnew-tail\n";
    const hunks = diffLines(before, after);
    expect(totals(hunks)).toEqual({ added: 1, removed: 2 });
  });
  it("reports no changes for identical input", () => {
    const hunks = diffLines("a\nb\n", "a\nb\n");
    expect(totals(hunks)).toEqual({ added: 0, removed: 0 });
    expect(hunks.length).toBe(1);
  });
  it("counts blank lines inside added hunks", () => {
    const after = "l1\n\nl3\n\nl5\n";
    const hunks = diffLines("", after);
    const added = hunks.filter((h) => h.added);
    expect(added.length).toBe(1);
    expect(added[0].count).toBe(5);
    expect(totals(hunks)).toEqual({ added: 5, removed: 0 });
  });
  it("round-trips before/after through hunks", () => {
    const before = "one\ntwo\nthree\nfour\n";
    const after = "one\nTWO\nthree\n4\nfive\n";
    const hunks = diffLines(before, after);
    let rebuiltBefore = "";
    let rebuiltAfter = "";
    for (const h of hunks) {
      if (h.added && !h.removed) rebuiltAfter += h.value;
      else if (h.removed && !h.added) rebuiltBefore += h.value;
      else {
        rebuiltBefore += h.value;
        rebuiltAfter += h.value;
      }
    }
    expect(rebuiltBefore).toBe(before);
    expect(rebuiltAfter).toBe(after);
  });
});