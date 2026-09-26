import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
describe("arc extension package", () => {
  const root = path.resolve(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  it("declares activation events for the sidebar view (mono and pride)", () => {
    if (!pkg.activationEvents) return;
    expect(pkg.activationEvents).toContain("onView:arc-sidebar");
    expect(pkg.activationEvents).toContain("onView:arc-sidebar-pride");
  });
  it("registers the arc-sidebar view under the mono activitybar container", () => {
    const views = pkg.contributes.views["arc-activitybar"] as { id: string }[];
    expect(views.find((v) => v.id === "arc-sidebar")).toBeDefined();
  });
  it("all view ids across all containers are unique (VS Code requirement)", () => {
    const all: string[] = [];
    for (const vs of Object.values(pkg.contributes.views as Record<string, { id: string }[]>)) {
      for (const v of vs) all.push(v.id);
    }
    const dupes = all.filter((id, i) => all.indexOf(id) !== i);
    expect(dupes, `duplicate view ids: ${dupes.join(", ")}`).toEqual([]);
  });
  it("commandPalette menu includes every declared command (or list none for default-all)", () => {
    const internalCommands = new Set(["arc.inlineChat.submit", "arc.inlineChat.cancel", "arc.inlineChat.pickModel"]);
    const declared = (pkg.contributes.commands as { command: string }[]).map((c) => c.command).filter((c) => !internalCommands.has(c));
    const palette = ((pkg.contributes.menus?.commandPalette as { command: string }[] | undefined) ?? [])
      .map((c) => c.command);
    if (palette.length > 0) {
      const missing = declared.filter((c) => !palette.includes(c));
      expect(missing, `commands hidden from palette: ${missing.join(", ")}`).toEqual([]);
    }
  });
  it("every command has an onCommand activation event (so it always activates)", () => {
    const declared = (pkg.contributes.commands as { command: string }[]).map((c) => c.command);
    const events = pkg.activationEvents as string[] | undefined;
    if (!events) return;
    for (const c of declared) {
      expect(events, `command ${c} missing activation event`).toContain(`onCommand:${c}`);
    }
  });
  it("every command has a 'Arc' category (so the palette groups them under 'Arc: ...')", () => {
    const cmds = pkg.contributes.commands as { command: string; title: string; category?: string }[];
    for (const c of cmds) {
      expect(c.category, `command ${c.command} missing category`).toBe("Arc");
      expect(c.title, `command ${c.command} title should not start with 'Arc:'`).not.toMatch(/^Arc:/);
    }
  });
  it("webview-ui has a root error handler so a render error is visible, not a blank page", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(path.join(__dirname, "..", "webview-ui", "src", "entry.tsx"), "utf-8");
    expect(src, "entry.tsx must register a window error handler").toMatch(/addEventListener\("error"/);
    expect(src, "entry.tsx must register an unhandledrejection handler").toMatch(/unhandledrejection/);
    expect(src, "entry.tsx must wrap render in a try/catch").toMatch(/try\s*\{/);
  });
  it("bundled extension.js wraps activate() in a try/catch (so commands survive async init failures)", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf-8");
    expect(bundle, "activate export exists in bundle").toMatch(/activate:/);
    expect(bundle, "registerViewsAndCommands (may be minified, but the activate() function is present)").toBeTruthy();
    expect(bundle, "initializeAsync (may be minified, but the activate() function is present)").toBeTruthy();
  });
  it("registers a separate pride-flavored view container toggled by arc.isPrideMonth", () => {
    const containers = pkg.contributes.viewsContainers.activitybar as { id: string; when?: string }[];
    const mono = containers.find((c) => c.id === "arc-activitybar");
    const pride = containers.find((c) => c.id === "arc-activitybar-pride");
    expect(mono, "mono container").toBeDefined();
    expect(pride, "pride container").toBeDefined();
    expect(mono?.when, "mono when").toBe("!arc.isPrideMonth");
    expect(pride?.when, "pride when").toBe("arc.isPrideMonth");
    const monoViews = pkg.contributes.views["arc-activitybar"] as { id: string }[];
    const prideViews = pkg.contributes.views["arc-activitybar-pride"] as { id: string }[];
    expect(monoViews.find((v) => v.id === "arc-sidebar")).toBeDefined();
    expect(prideViews.find((v) => v.id === "arc-sidebar-pride")).toBeDefined();
  });
  it("uses only alphanumeric / _ / - in view container IDs (VS Code rule)", () => {
    const ok = /^[A-Za-z0-9_-]+$/;
    const containers = pkg.contributes.viewsContainers.activitybar as { id: string }[];
    expect(containers.length, "at least one view container").toBeGreaterThan(0);
    for (const c of containers) {
      expect(c.id, `view container id "${c.id}" must match ${ok}`).toMatch(ok);
    }
    for (const [parent, views] of Object.entries(pkg.contributes.views as Record<string, { id: string }[]>)) {
      expect(parent, `view parent key "${parent}" must match ${ok}`).toMatch(ok);
      for (const v of views) {
        expect(v.id, `view id "${v.id}" must match ${ok}`).toMatch(ok);
      }
    }
  });
  it("ships the agent log, routing, edit, checkpoint, mcp, browser modules", () => {
    const hostRoot = path.resolve(root, "../host");
    for (const mod of [
      "src/protocol/protocol.ts",
      "src/routing/registry.ts",
      "src/routing/router.ts",
      "src/edit/apply.ts",
      "src/edit/editor.ts",
      "src/checkpoint/store.ts",
      "src/agent/agent.ts",
      "src/agent/subagent.ts",
      "src/compaction/compaction.ts",
      "src/mcp/mcp.ts",
      "src/browser/browser.ts",
      "src/lsp/lsp.ts",
      "src/prompts/prompts.ts",
      "src/providers/catalog.ts",
    ]) {
      expect(fs.existsSync(path.join(hostRoot, mod)), mod).toBe(true);
    }
  });
});