import { describe, it, expect } from "vitest";
import { topToolSummaries, groupSummaryFor, describeTool, joinToolPhrases } from "../src/util/group-summary";
import type { ProcessStep } from "../src/protocol/process";
const s = (toolName?: string, title?: string, children?: ProcessStep[]): ProcessStep => ({ id: toolName ?? title ?? Math.random().toString(36).slice(2), type: "tool", title: title ?? toolName ?? "", toolName, children });
describe("describeTool", () => {
  it("maps known tools to human phrases", () => {
    expect(describeTool(s("file.read"))).toBe("Read files");
    expect(describeTool(s("shell.backgroundRun"))).toBe("Started background process");
    expect(describeTool(s("browser.click"))).toBe("Used the browser");
  });
  it("descends into children when the parent has none of its own", () => {
    const parent = s(undefined, "Called", [s("unknown.custom"), s("file.edit")]);
    expect(describeTool(parent)).toBe("Edited files");
  });
  it("covers pseudo tools like checkpoint listing", () => {
    expect(describeTool(s("checkpoint.list"))).toBe("Listed checkpoints");
    expect(describeTool(s("checkpoint.revert"))).toBe("Reverted checkpoints");
    expect(describeTool(s("session.exportTrace"))).toBe("Exported trace");
  });
});
describe("joinToolPhrases", () => {
  it("merges shared objects into one trailing noun with lowercased second verb", () => {
    expect(joinToolPhrases(["Globbed", "files"], ["Searched", "files"])).toBe("Globbed and searched files");
    expect(joinToolPhrases(["Read", "files"], ["Edited", "files"])).toBe("Read and edited files");
  });
  it("merges shared verbs into one leading verb with both objects", () => {
    expect(joinToolPhrases(["Ran", "semantic search"], ["Ran", "tests"])).toBe("Ran semantic search and tests");
  });
  it("falls back to verb+object and lowercased-verb+object for distinct pairs", () => {
    expect(joinToolPhrases(["Ran", "commands"], ["Read", "files"])).toBe("Ran commands and read files");
  });
});
describe("groupSummaryFor", () => {
  it("glob+grep yields the merged-object label", () => {
    const steps = [s("file.glob"), s("file.glob"), s("file.glob"), s("file.glob"), s("file.glob"), s("file.glob"), s("file.grep"), s("file.grep")];
    expect(groupSummaryFor(steps, "tools")).toBe("Globbed and searched files");
  });
  it("run+read yields distinct-pair fallback phrasing", () => {
    const steps = [s("shell.run"), s("shell.run"), s("shell.run"), s("shell.run"), s("shell.run"), s("file.read")];
    expect(groupSummaryFor(steps, "tools")).toBe("Ran commands and read files");
  });
  it("syms+shell yields merged-verb phrasing", () => {
    const steps = [s("syms.context"), s("syms.context"), s("shell.run")];
    expect(groupSummaryFor(steps, "tools")).toBe("Built code context and ran commands");
  });
  it("count and ai modes return the fallback", () => {
    const steps = [s("file.read")];
    expect(groupSummaryFor(steps, "count")).toBe("Called");
    expect(groupSummaryFor(steps, "ai")).toBe("Called");
  });
  it("single activity has no conjunction", () => {
    const steps = [s("file.read"), s("file.read"), s("notebook.read")];
    expect(groupSummaryFor(steps, "tools")).toBe("Read files");
  });
});
describe("topToolSummaries", () => {
  it("ranks by frequency", () => {
    const steps = [s("file.read"), s("file.read"), s("file.read"), s("shell.run")];
    expect(topToolSummaries(steps)[0]).toBe("Read files");
  });
});