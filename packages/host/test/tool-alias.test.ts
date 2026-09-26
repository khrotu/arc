import { describe, it, expect, beforeEach } from "vitest";
import { isCompatTarget, compatAliasReverse, applyCompatAliases, COMPAT_TOOL_ALIASES } from "../src/providers/tool-alias";
import { setRuntimePrefs } from "../src/runtime-prefs";
import type { ModelDescriptor, ProviderConfig } from "../src/protocol/protocol";
function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: "p1", kind: "opencode", label: "P", baseUrl: "https://opencode.ai/zen/v1", enabled: true, ...over };
}
function model(over: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return { id: "m1", label: "M", tier: "default", contextWindow: 1, costPer1mIn: 0, costPer1mOut: 0, providers: [{ id: "p1", kind: "opencode", remoteModel: "mimo-free", priority: 0 }], ...over };
}
beforeEach(() => {
  setRuntimePrefs({});
});
describe("isCompatTarget", () => {
  it("matches opencode endpoints with -free slugs", () => {
    expect(isCompatTarget(provider(), "mimo-free", "m1")).toBe(true);
    expect(isCompatTarget(provider(), undefined, "mimo-free")).toBe(true);
    expect(isCompatTarget(provider(), "gpt-6", "m1")).toBe(false);
    expect(isCompatTarget(provider({ kind: "openai", baseUrl: "https://api.openai.com/v1" }), "mimo-free", "m1")).toBe(false);
    expect(isCompatTarget(provider({ kind: "openai-compatible", baseUrl: "https://opencode.ai/zen/v1" }), "mimo-free", "m1")).toBe(true);
  });
});
describe("compatAliasReverse", () => {
  it("stays off without the experimental opt-in and agreement", () => {
    expect(compatAliasReverse(model(), [provider()], new Set(["file.read", "shell.run"]))).toBeUndefined();
    setRuntimePrefs({ backendDebugOverride: true });
    expect(compatAliasReverse(model(), [provider()], new Set(["file.read", "shell.run"]))).toBeUndefined();
  });
  it("requires every bound provider to be a tool-alias target with both tools enabled", () => {
    setRuntimePrefs({ backendDebugOverride: true, backendDebugAgreedAt: "2026-09-24T00:00:00.000Z" });
    expect(compatAliasReverse(model(), [provider()], new Set(["file.read", "shell.run"]))?.get("read")).toBe("file.read");
    expect(compatAliasReverse(model(), [provider()], new Set(["file.read"]))).toBeUndefined();
    const mixed = model({ providers: [{ id: "p1", kind: "opencode", remoteModel: "mimo-free", priority: 0 }, { id: "p2", kind: "openai", priority: 1 }] });
    expect(compatAliasReverse(mixed, [provider(), provider({ id: "p2", kind: "openai", baseUrl: "https://api.openai.com/v1" })], new Set(["file.read", "shell.run"]))).toBeUndefined();
    expect(compatAliasReverse(model({ providers: [] }), [provider()], new Set(["file.read", "shell.run"]))).toBeUndefined();
    expect(compatAliasReverse(model(), [provider({ enabled: false })], new Set(["file.read", "shell.run"]))).toBeUndefined();
  });
});
describe("applyCompatAliases", () => {
  it("renames real specs and skips name collisions", () => {
    const specs = [
      { name: "file.read", description: "r", parameters: {} },
      { name: "shell.run", description: "s", parameters: {} },
      { name: "file.edit", description: "e", parameters: {} },
    ];
    const out = applyCompatAliases(specs, new Map([["read", "file.read"], ["shell", "shell.run"]]));
    expect(out.map((s) => s.name)).toEqual(["read", "shell", "file.edit"]);
    expect(Object.keys(COMPAT_TOOL_ALIASES)).toEqual(["read", "shell"]);
    const colliding = applyCompatAliases([{ name: "read", description: "x", parameters: {} }, ...specs], new Map([["read", "file.read"]]));
    expect(colliding.map((s) => s.name)).toEqual(["read", "file.read", "shell.run", "file.edit"]);
  });
});