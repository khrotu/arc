import { describe, it, expect } from "vitest";
import { scoreDiscoveryPool, coreToolNames, SEARCH_TOOL_NAME, type DiscoverableTool } from "../src/agent/tool-discovery";
const POOL: DiscoverableTool[] = [
  { name: "browser.tab", description: "Manage browser tabs: list them, open one, switch the active tab, or close one.", params: { names: ["action", "tabId", "url"], text: "action: Tab action tabId: Tab id url: Optional URL" } },
  { name: "notebook.execute", description: "Execute a code cell using the workspace's active Jupyter kernel.", params: { names: ["path", "cellIndex"], text: "path: notebook path cellIndex: cell index" } },
  { name: "shell.check", description: "Poll output and status of a background process.", params: { names: ["id", "waitForExit"], text: "id: process id" } },
];
describe("scoreDiscoveryPool", () => {
  it("matches tool names first", () => {
    const top = scoreDiscoveryPool("browser tabs", POOL);
    expect(top[0]?.name).toBe("browser.tab");
  });
  it("matches descriptions and parameter names", () => {
    expect(scoreDiscoveryPool("jupyter kernel", POOL)[0]?.name).toBe("notebook.execute");
    expect(scoreDiscoveryPool("waitForExit", POOL)[0]?.name).toBe("shell.check");
  });
  it("returns nothing for empty or unrelated queries", () => {
    expect(scoreDiscoveryPool("", POOL)).toEqual([]);
    expect(scoreDiscoveryPool("zzz-no-such-capability", POOL)).toEqual([]);
  });
});
describe("coreToolNames", () => {
  it("is the balanced preset set", () => {
    const core = coreToolNames();
    expect(core.has("file.edit")).toBe(true);
    expect(core.has("shell.run")).toBe(true);
    expect(core.has("browser.navigate")).toBe(false);
    expect(core.has("tool.search")).toBe(false);
    expect(SEARCH_TOOL_NAME).toBe("tool.search");
  });
});