import { describe, it, expect } from "vitest";
import { TOOL_PRESETS } from "../src/modes/tool-presets";
import { TOOL_PARAM_SPECS } from "../src/agent/tool-specs";
const KNOWN = new Set(Object.keys(TOOL_PARAM_SPECS).filter((t) => t !== "subagent.askParent"));
describe("tool presets", () => {
  it("defines basic, balanced and full in order", () => {
    expect(TOOL_PRESETS.map((p) => p.id)).toEqual(["basic", "balanced", "full"]);
    for (const p of TOOL_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(new Set(p.enabled).size).toBe(p.enabled.length);
    }
  });
  it("references only known tools", () => {
    for (const p of TOOL_PRESETS) {
      for (const name of p.enabled) {
        expect(KNOWN.has(name), `${p.id} references unknown tool ${name}`).toBe(true);
      }
    }
  });
  it("nests monotonically", () => {
    const sets = TOOL_PRESETS.map((p) => new Set(p.enabled));
    for (let i = 1; i < sets.length; i++) {
      for (const name of sets[i - 1]) {
        expect(sets[i].has(name), `${TOOL_PRESETS[i].id} drops ${name} from ${TOOL_PRESETS[i - 1].id}`).toBe(true);
      }
      expect(sets[i].size).toBeGreaterThan(sets[i - 1].size);
    }
  });
  it("basic is the six-tool core", () => {
    expect(new Set(TOOL_PRESETS[0].enabled)).toEqual(new Set([
      "file.read", "file.write", "file.edit", "file.grep", "file.glob", "shell.run",
    ]));
  });
  it("balanced is the fifteen-tool driver", () => {
    expect(new Set(TOOL_PRESETS[1].enabled)).toEqual(new Set([
      "file.read", "file.write", "file.edit", "file.grep", "file.glob", "shell.run",
      "shell.backgroundRun", "skill", "todo.write", "web.fetch", "web.search",
      "subagent.spawn", "clarification.askUser", "handoff", "syms.context", "lsp",
    ]));
  });
  it("full covers every known tool", () => {
    const full = new Set(TOOL_PRESETS[2].enabled);
    expect(full).toEqual(KNOWN);
  });
});