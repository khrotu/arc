export interface ToolPreset {
  id: "basic" | "balanced" | "full";
  label: string;
  description: string;
  enabled: readonly string[];
}
const BASIC_TOOLS: readonly string[] = [
  "file.read", "file.write", "file.edit", "file.grep", "file.glob",
  "shell.run",
];
const BALANCED_ADDS: readonly string[] = [
  "shell.backgroundRun",
  "skill",
  "todo.write",
  "web.fetch", "web.search",
  "subagent.spawn", "clarification.askUser", "handoff",
  "syms.context", "lsp",
];
const FULL_ADDS: readonly string[] = [
  "shell.check", "shell.write", "shell.kill",
  "browser.navigate", "browser.click", "browser.type", "browser.screenshot",
  "browser.evaluate", "browser.readDom", "browser.close", "browser.hover", "browser.scroll", "browser.waitFor",
  "browser.console", "browser.network", "browser.domSnapshot",
  "browser.drag", "browser.dialog", "browser.runCode", "browser.readPage", "browser.tab", "browser.intercept", "browser.unintercept",
  "mcp.call", "mcp.create", "mcp.remove", "mcp.toggle",
  "mcp.resources/list", "mcp.resources/read", "mcp.prompts/list", "mcp.prompts/get",
  "hooks.list", "hooks.create", "hooks.update", "hooks.delete",
  "memory",
  "checkpoint.revert", "checkpoint.list", "checkpoint.compare",
  "context.retrieve", "session.exportTrace", "mode.switch",
  "notebook.read", "notebook.editCell", "notebook.addCell", "notebook.deleteCell", "notebook.execute",
  "tool.search",
];
export const TOOL_PRESETS: readonly ToolPreset[] = [
  {
    id: "basic",
    label: "Basic",
    description: "File reads, edits and shell commands.",
    enabled: BASIC_TOOLS,
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Adds background jobs, web, subagents, plans and questions.",
    enabled: [...BASIC_TOOLS, ...BALANCED_ADDS],
  },
  {
    id: "full",
    label: "Full",
    description: "Adds browser, MCP, notebooks and checkpoints.",
    enabled: [...BASIC_TOOLS, ...BALANCED_ADDS, ...FULL_ADDS],
  },
];
export function presetById(id: string): ToolPreset | undefined {
  return TOOL_PRESETS.find((p) => p.id === id);
}