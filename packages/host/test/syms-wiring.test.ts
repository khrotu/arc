import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { tools, type ToolContext } from "../src/agent/tools";
import { TOOL_PARAM_SPECS } from "../src/agent/tool-specs";
import { LOCAL_OUT, READ_TOOLS, prettyToolTitle } from "../src/agent/agent";
import { DEFAULT_MODES } from "../src/modes/defaults";
import { toolPhrasePair } from "../src/util/group-summary";
function mockCtx(root: string): ToolContext {
  return { root, workspacePath: root } as unknown as ToolContext;
}
describe("syms.context wiring", () => {
  it("spec and handler keys match", () => {
    expect(TOOL_PARAM_SPECS["syms.context"]).toBeDefined();
    expect(tools["syms.context"]).toBeDefined();
    expect(typeof tools["syms.context"].fn).toBe("function");
    const params = TOOL_PARAM_SPECS["syms.context"].parameters as { required?: string[] };
    expect(params.required).toContain("query");
  });
  it("every handler has a spec", () => {
    for (const name of Object.keys(tools)) {
      expect(TOOL_PARAM_SPECS[name], `spec missing for handler ${name}`).toBeDefined();
    }
  });
  it("is allowed in plan and code modes", () => {
    const plan = DEFAULT_MODES.find((m) => m.slug === "plan")!;
    const code = DEFAULT_MODES.find((m) => m.slug === "code")!;
    expect(plan.allowedTools).toContain("syms.context");
    expect(code.allowedTools).toContain("syms.context");
  });
  it("is a local read tool with summary phrases", () => {
    expect(READ_TOOLS.has("syms.context")).toBe(true);
    expect(LOCAL_OUT.test("syms.context")).toBe(true);
    expect(toolPhrasePair("syms.context")).toEqual(["Built", "code context"]);
    expect(prettyToolTitle("syms.context", { query: "auth flow" }, "processing")).toContain("auth flow");
  });
  it("rejects empty queries", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-syms-wire-"));
    const r = await tools["syms.context"].fn({ query: "  " }, mockCtx(tmp));
    expect(r.ok).toBe(false);
  });
  it("builds context end to end in a temp workspace", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-syms-wire-"));
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "src", "auth.ts"),
      "export class AuthService {\n  async login(user: string) {\n    return validateToken(user);\n  }\n}\nexport function validateToken(t: string) {\n  return t.length > 3;\n}\n",
    );
    const r = await tools["syms.context"].fn({ query: "login authentication" }, mockCtx(tmp));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("AuthService");
    expect(r.output).toContain("validateToken");
    expect(r.touchedFiles).toContain("src/auth.ts");
  });
  it("supports includeCode false and clamps maxNodes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-syms-wire-"));
    await fs.writeFile(path.join(tmp, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
    const r = await tools["syms.context"].fn({ query: "alpha", includeCode: false, maxNodes: 9999 }, mockCtx(tmp));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("alpha");
    expect(r.output).not.toContain("```");
  });
});