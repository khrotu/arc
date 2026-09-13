import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  collapseRepeatedLines,
  expandRepeatedLines,
  foldRepeatedBlocks,
  unfoldRepeatedBlocks,
  searchHeading,
  searchUnheading,
  diffStripIndex,
  compactLossless,
} from "../src/compress/lossless";
describe("lossless folds", () => {
  it("strips ANSI codes", () => {
    expect(stripAnsi("\u001b[31mhello\u001b[0m")).toBe("hello");
  });
  it("collapses repeated lines with exact inverse", () => {
    const text = ["a", "b", "b", "b", "b", "c"].join("\n");
    const folded = collapseRepeatedLines(text);
    expect(folded).toContain("repeated 4 times");
    expect(expandRepeatedLines(folded)).toBe(text);
  });
  it("folds repeated blocks with exact inverse", () => {
    const stanza = ["one", "two", "three", "four"].join("\n");
    const text = [stanza, stanza].join("\n");
    const { text: folded, folded: did } = foldRepeatedBlocks(text);
    expect(did).toBe(true);
    expect(unfoldRepeatedBlocks(folded)).toBe(text);
  });
  it("folds grep rows under path headers with exact inverse", () => {
    const text = ["src/a.ts:1:foo", "src/a.ts:2:bar", "src/b.ts:9:baz"].join("\n");
    const folded = searchHeading(text);
    expect(folded).toContain("##> src/a.ts");
    expect(searchUnheading(folded)).toBe(text);
  });
  it("never folds timestamp rows as grep output", () => {
    const text = ["2026-09-02 14:30:01 event fired", "2026-09-02 14:30:02 event fired"].join("\n");
    expect(searchHeading(text)).toBe(text);
  });
  it("preserves pre-existing markdown headers and bare number lines", () => {
    const text = ["## Introduction", "src/a.ts:1:foo", "src/a.ts:2:bar", "42: not a grep row"].join("\n");
    const folded = searchHeading(text);
    expect(searchUnheading(folded)).toBe(text);
  });
  it("treats absurd repeat markers as literal text", () => {
    const text = ["line", "... (repeats 999999999 lines from 1 lines back)"].join("\n");
    expect(unfoldRepeatedBlocks(text)).toBe(text);
    const text2 = ["line", "... (repeated 999999999 times)"].join("\n");
    expect(expandRepeatedLines(text2)).toBe(text2);
  });
  it("keeps diff index lines in the lossless stage", () => {
    const text = ["diff --git a/x b/x", "index abc..def 100644", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(compactLossless(text, "auto")).toContain("index abc..def");
  });
  it("strips diff index lines", () => {
    const text = ["diff --git a/x b/x", "index abc..def 100644", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(diffStripIndex(text)).not.toContain("index abc");
  });
  it("compactLossless only returns smaller round-trippable output", () => {
    const stanza = Array.from({ length: 30 }, (_, i) => `src/f.ts:${i}:result value ${i % 3}`).join("\n");
    const text = `${stanza}\n${stanza}`;
    const out = compactLossless(text, "auto");
    expect(out.length).toBeLessThan(text.length);
  });
  it("compactLossless leaves tiny inputs alone", () => {
    expect(compactLossless("hello world", "auto")).toBe("hello world");
  });
});