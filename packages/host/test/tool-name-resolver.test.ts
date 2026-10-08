import { describe, it, expect } from "vitest";
import { createToolNameResolver, toApiToolName, fromApiToolName } from "../src/providers/transport";
const TOOLS = ["file.read", "file.edit", "file.write", "shell.run", "shell.write", "shell.backgroundRun", "notebook.execute", "mcp.resources/list"];
const resolve = createToolNameResolver(TOOLS.map((name) => ({ name })));
describe("createToolNameResolver", () => {
  it("maps dot-dropped api names back to real names", () => {
    expect(resolve("fileread")).toBe("file.read");
    expect(resolve("shellwrite")).toBe("shell.write");
    expect(resolve("shellbackgroundRun")).toBe("shell.backgroundRun");
    expect(resolve("mcpresources_slist")).toBe("mcp.resources/list");
  });
  it("recovers names that lost underscore escape markers", () => {
    expect(resolve("mcpresourcesslist")).toBe("mcp.resources/list");
  });
  it("round-trips names whose real form contains an underscore", () => {
    const names = ["mcp__my_server__do_thing", "a_b"];
    const r = createToolNameResolver(names.map((name) => ({ name })));
    expect(r(toApiToolName("mcp__my_server__do_thing"))).toBe("mcp__my_server__do_thing");
    expect(r(toApiToolName("a_b"))).toBe("a_b");
  });
  it("passes unknown names through untouched so the normal error path runs", () => {
    expect(resolve("totally_unknown")).toBe("totally_unknown");
    expect(resolve("browserzclick")).toBe("browserzclick");
    expect(resolve("")).toBe("");
  });
  it("resolves deterministically when two tools collapse to the same api name", () => {
    const r = createToolNameResolver([{ name: "a.b" }, { name: "ab" }]);
    expect(r(toApiToolName("a.b"))).toBe("a.b");
    expect(r("ab")).toBe("a.b");
  });
  it("returns names verbatim when no tools are advertised", () => {
    const r = createToolNameResolver([]);
    expect(r("shellwrite")).toBe("shellwrite");
  });
});
describe("tool name encoding", () => {
  it("drops dots instead of adding tokens", () => {
    expect(toApiToolName("shell.run")).toBe("shellrun");
    expect(toApiToolName("file.write")).toBe("filewrite");
    expect(toApiToolName("mcp.resources/list")).toBe("mcpresources_slist");
  });
  it("still escapes underscores and slashes reversibly", () => {
    for (const t of ["mcp__my_server__do_thing", "a_b", "x/y"]) expect(fromApiToolName(toApiToolName(t))).toBe(t);
  });
  it("drops dots one-way; the resolver table restores them", () => {
    expect(toApiToolName("mcp.resources/list")).toBe("mcpresources_slist");
    expect(fromApiToolName("mcpresources_slist")).toBe("mcpresources/list");
  });
});