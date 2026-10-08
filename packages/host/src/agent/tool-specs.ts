import { createHash } from "node:crypto";
import type { ToolSpec } from "../providers/transport.js";
type JsonSchema = Record<string, unknown>;
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string): JsonSchema => ({ type: "number", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const enumStr = (values: string[], description: string): JsonSchema => ({ type: "string", enum: values, description });
const TAB_ID = "Optional tab id to target (defaults to the active tab).";
const NB_PATH = "Workspace-relative path to the .ipynb file.";
export const TOOL_PARAM_SPECS: Record<string, { description: string; parameters: JsonSchema }> = {
  "file.read": {
    description: "Read a file from the workspace.",
    parameters: obj({
      path: str("Workspace-relative file path."),
      offset: num("Optional 1-based start line. Defaults to 1."),
      limit: num("Optional max lines to return. Defaults to the entire file."),
    }, ["path"]),
  },
  "file.edit": {
    description: "Apply an edit to an existing file. Prefer a SEARCH/REPLACE block in `search`; use plain text only for trivial one-line tweaks.",
    parameters: obj({
      path: str("Workspace-relative file path."),
      search: str("SEARCH/REPLACE block (preferred) or exact text to find, with enough surrounding lines to be unique."),
      replace: str("Replacement text. Ignored when `search` is a SEARCH/REPLACE block."),
      replaceAll: bool("Replace every occurrence instead of the first."),
      runAfter: str("Optional shell command to run after the edit (e.g. 'pnpm build')."),
    }, ["path"]),
  },
  "file.write": {
    description: "Create a new file or overwrite an existing one.",
    parameters: obj({
      path: str("Workspace-relative file path."),
      content: str("Full file contents."),
      runAfter: str("Optional shell command to run after writing (e.g. 'pnpm test')."),
    }),
  },
  "file.grep": {
    description: "Search the workspace for a regex pattern using ripgrep.",
    parameters: obj({
      pattern: str("The regex pattern to search for in file contents."),
      include: str("Optional file pattern filter (e.g. '*.ts', '*.{ts,tsx}')."),
    }, ["pattern"]),
  },
  "file.glob": {
    description: "Find files matching a glob pattern.",
    parameters: obj({
      pattern: str("Glob pattern (e.g. '**/*.ts', 'src/**/*.tsx')."),
    }, ["pattern"]),
  },
  "shell.run": {
    description: "Run a shell command in the workspace (subject to approval).",
    parameters: obj({
      command: str("The command line to run."),
      cwd: str("Optional working directory (defaults to the workspace root)."),
      timeout: str("Optional timeout in seconds. Use -1 for no limit (default). On timeout the process is moved to the background instead of killed: the result returns partial output plus a background id for shell.check."),
      untilSuccess: bool("Repeat the command until it exits 0 (condition wait, e.g. server readiness). Uses interval/timeout below instead of the single-run timeout."),
      interval: num("Poll interval in seconds for untilSuccess (default 1, min 0.25)."),
    }),
  },
  "shell.backgroundRun": {
    description: "Launch a long-running shell process in the background.",
    parameters: obj({
      command: str("The command line to run."),
      cwd: str("Optional working directory (defaults to the workspace root)."),
    }, ["command"]),
  },
  "shell.check": {
    description: "Poll output and status of a background process. Prefer a single check with waitForExit over repeated polling.",
    parameters: obj({
      id: str("The background process id returned by shell.backgroundRun."),
      waitForExit: bool("Block until the process exits instead of returning immediately."),
      timeout: num("Max seconds to wait with waitForExit (default 3600)."),
    }, ["id"]),
  },
  "shell.write": {
    description: "Send input to a running background process. To stop a server, use shell.kill: a Ctrl+C byte only affects programs that read it from stdin.",
    parameters: obj({
      id: str("The background process id."),
      input: str("Plain-text input sent verbatim. Must not contain control characters: they may be stripped before delivery, failing silently."),
      inputEscaped: str("Alternative to input for bytes that cannot be sent raw. Backslash escapes (\\n, \\t, \\\\, \\x03, \\u0003) are decoded before sending; Ctrl+C is \\u0003. Takes precedence over input when non-empty."),
    }, ["id"]),
  },
  "shell.kill": {
    description: "Terminate a running background process by id. Use this to stop servers started with shell.backgroundRun.",
    parameters: obj({
      id: str("The background process id."),
    }, ["id"]),
  },
  "lsp": {
    description: "Get LSP problems across the workspace, or for a single file when path is given.",
    parameters: obj({
      path: str("Optional workspace-relative file path to scope diagnostics to."),
    }),
  },
  "todo.write": {
    description: "Set the live to-do plan as a flat list. Mark the active item in_progress and flip items to done after verifying; independent items may progress together.",
    parameters: obj({
      items: {
        type: "array",
        description: "The full to-do list (replaces the previous one).",
        items: obj({
          id: str("Stable id for the item."),
          text: str("What the step does."),
          state: enumStr(["pending", "in_progress", "done"], "Item state."),
        }, ["id", "text", "state"]),
      },
    }, ["items"]),
  },
  "browser.navigate": {
    description: "Navigate the browser to a URL.",
    parameters: obj({ url: str("Absolute URL."), tabId: str(TAB_ID) }, ["url"]),
  },
  "browser.click": {
    description: "Click an element by selector.",
    parameters: obj({ selector: str("CSS selector."), tabId: str(TAB_ID) }, ["selector"]),
  },
  "browser.type": {
    description: "Type text into an element.",
    parameters: obj({ selector: str("CSS selector."), text: str("Text to type."), tabId: str(TAB_ID) }, ["selector", "text"]),
  },
  "browser.screenshot": {
    description: "Capture a screenshot of the current page.",
    parameters: obj({ path: str("Optional output path."), tabId: str(TAB_ID) }),
  },
  "browser.evaluate": {
    description: "Evaluate JavaScript in the page.",
    parameters: obj({ script: str("JavaScript source to run."), tabId: str(TAB_ID) }, ["script"]),
  },
  "browser.readDom": {
    description: "Read the page's accessibility tree.",
    parameters: obj({ tabId: str(TAB_ID) }),
  },
  "browser.close": {
    description: "Close the browser.",
    parameters: obj({}),
  },
  "browser.tab": {
    description: "Manage browser tabs: list them, open one, switch the active tab, or close one.",
    parameters: obj({
      action: enumStr(["list", "new", "switch", "close"], "Tab action (default list)."),
      tabId: str("Tab id for switch/close (see list)."),
      url: str("Optional URL for a new tab to navigate to."),
    }),
  },
  "browser.intercept": {
    description: "Intercept network requests matching a URL glob pattern (e.g. '**/api/**'), to mock a response or block the request entirely. Applies to all tabs.",
    parameters: obj({
      pattern: str("URL glob pattern to match, e.g. '**/api/users' or '**/*.png'."),
      status: num("HTTP status code to respond with when mocking (default 200)."),
      body: str("Response body to return when mocking."),
      contentType: str("Content-Type header for the mocked response (default application/json)."),
      block: bool("If true, aborts matching requests instead of returning a mocked response."),
    }, ["pattern"]),
  },
  "browser.unintercept": {
    description: "Stop intercepting requests matching a previously registered pattern.",
    parameters: obj({ pattern: str("The exact pattern previously passed to browser.intercept.") }, ["pattern"]),
  },
  "web.fetch": {
    description: "Fetch raw text content from a web URL.",
    parameters: obj({
      url: str("Full URL to fetch."),
    }, ["url"]),
  },
  "web.search": {
    description: "Search the web and return the top results.",
    parameters: obj({
      query: str("Search query string."),
      count: num("Maximum number of results to return (default 10, max 20)."),
    }, ["query"]),
  },
  "syms.context": {
    description: "One-call code context: whole-token symbol search (case-insensitive, OR semantics) returning entry points, callers/callees and code blocks. Paths, typos and prose do not match; use file.grep for those. Use instead of N grep/read round-trips when exploring unfamiliar code.",
    parameters: obj({
      query: str("Symbol name or keywords (e.g. 'validateToken'). Whole tokens only: no substrings, typos or file paths."),
      maxNodes: num("Max entry-point symbols, 1-60 (default 20). Related callers/callees may add more nodes."),
      includeCode: bool("Include code blocks (default true)."),
      maxCodeBlocks: num("Max code blocks rendered (default 5). Entries past the budget list without code."),
      maxCodeLines: num("Max lines per code block (default 120)."),
    }, ["query"]),
  },
  "mcp.call": {
    description: "Call a tool exposed by a connected MCP server.",
    parameters: obj({
      server: str("MCP server name."),
      tool: str("Tool name on that server."),
      args: { type: "object", description: "Arguments for the tool.", additionalProperties: true },
    }, ["server", "tool"]),
  },
  "mcp.create": {
    description: "Define and register a new MCP server during the session. For stdio servers, provide command + args. For HTTP/SSE servers, provide url.",
    parameters: obj({
      name: str("Unique name for the new server."),
      enabled: bool("Start the server immediately. Defaults to true."),
      transport: {
        type: "object",
        description: "Transport definition.",
        properties: {
          type: enumStr(["stdio", "http"], "Transport type."),
          command: str("stdio: command to spawn."),
          args: { type: "array", items: { type: "string" }, description: "stdio: command arguments." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "stdio: extra env vars." },
          url: str("http: SSE endpoint URL."),
          headers: { type: "object", additionalProperties: { type: "string" }, description: "http: extra headers." },
        },
        required: ["type"],
      },
    }, ["name", "transport"]),
  },
  "mcp.remove": {
    description: "Remove a previously registered MCP server and stop its process.",
    parameters: obj({
      name: str("Name of the server to remove."),
    }, ["name"]),
  },
  "mcp.toggle": {
    description: "Enable or disable a registered MCP server without removing it.",
    parameters: obj({
      name: str("Name of the server."),
      enabled: bool("True to enable, false to disable."),
    }, ["name", "enabled"]),
  },
  "mcp.resources/list": {
    description: "List resources exposed by a connected MCP server.",
    parameters: obj({
      server: str("MCP server name."),
    }, ["server"]),
  },
  "mcp.resources/read": {
    description: "Read a resource URI from a connected MCP server.",
    parameters: obj({
      server: str("MCP server name."),
      uri: str("Resource URI."),
    }, ["server", "uri"]),
  },
  "mcp.prompts/list": {
    description: "List prompt templates exposed by a connected MCP server.",
    parameters: obj({
      server: str("MCP server name."),
    }, ["server"]),
  },
  "mcp.prompts/get": {
    description: "Fetch a prompt template from a connected MCP server, optionally with arguments.",
    parameters: obj({
      server: str("MCP server name."),
      name: str("Prompt template name."),
      args: { type: "object", description: "Optional template arguments.", additionalProperties: true },
    }, ["server", "name"]),
  },
  "session.exportTrace": {
    description: "Export the session execution timeline as markdown and JSON. Shows all model calls, tool invocations, handoffs, compactions, approvals, and subagent spawns with timing and usage data. The complete trace is archived for context.retrieve; pass path to also write it to a workspace-relative file.",
    parameters: obj({
      path: str("Optional workspace-relative file path to write the full trace to (e.g. 'trace.md'). Subject to the usual file-write approval."),
    }),
  },
  "checkpoint.revert": {
    description: "Revert files modified during a turn. Args: { index } (1=most recent) or { turnId } (exact UUID). Use checkpoint.list first to find available turns.",
    parameters: obj({
      index: num("1-based index of the checkpoint to revert to (1 is most recent). Use this OR turnId - not both."),
      turnId: str("Exact turn UUID from checkpoint.list. Use this OR index - not both."),
    }),
  },
  "checkpoint.list": {
    description: "List checkpoint snapshots for the current workspace, most recent first. Index 1 is the newest turn and matches the indices used by checkpoint.revert/compare. Output is capped - pass limit to widen or since (ISO date) to filter by time.",
    parameters: obj({
      limit: num("Max checkpoints to return (default 25, max 200). The most recent N are returned."),
      since: str("Only include checkpoints at or after this ISO timestamp (e.g. 2026-08-31 or 2026-08-31T12:00:00Z)."),
    }),
  },
  "checkpoint.compare": {
    description: "Compare two checkpoints and show which files changed between them. Args: { indexA, indexB } (1-based indices from checkpoint.list) or { turnIdA, turnIdB } (exact UUIDs).",
    parameters: obj({
      indexA: num("1-based index of the first checkpoint."),
      indexB: num("1-based index of the second checkpoint."),
      turnIdA: str("Exact turn UUID of the first checkpoint."),
      turnIdB: str("Exact turn UUID of the second checkpoint."),
    }),
  },
  "subagent.spawn": {
    description: "Spawn one or more subagents on a (typically cheaper) tier to do delegated grunt work. Use 'batch' to launch parallel subagents.",
    parameters: obj({
      name: str("Short subagent name (ignored if batch is set)."),
      instructions: str("What the subagent should do (ignored if batch is set)."),
      tier: enumStr(["free", "light", "default", "heavy"], "Optional tier to run on."),
      modelId: str("Optional explicit model id."),
      rules: obj({
        blockedCommands: { type: "array", items: { type: "string" }, description: "Commands the subagent may not run without parent approval." },
        requireApproval: bool("If true, ALL shell commands require parent approval."),
      }),
      batch: {
        type: "array",
        description: "Launch multiple subagents in parallel. Each item has name, instructions, tier, modelId, rules.",
        items: obj({
          name: str("Short subagent name."),
          instructions: str("What the subagent should do."),
          tier: enumStr(["free", "light", "default", "heavy"], "Optional tier to run on."),
          modelId: str("Optional explicit model id."),
          rules: obj({
            blockedCommands: { type: "array", items: { type: "string" }, description: "Commands the subagent may not run without parent approval." },
            requireApproval: bool("If true, ALL shell commands require parent approval."),
          }),
        }, ["name", "instructions"]),
      },
    }, ["name", "instructions"]),
  },
  "subagent.askParent": {
    description: "Ask the parent agent a clarifying question (subagents only).",
    parameters: obj({
      question: str("The question."),
      options: { type: "array", items: { type: "string" }, description: "Optional answer choices." },
    }, ["question"]),
  },
  "handoff": {
    description: "Hand the conversation to a different model tier. USE THIS when the task exceeds your capabilities: escalate to a heavier model for hard reasoning, complex refactors, ambiguous architecture, or repeated failures; de-escalate to a lighter/cheaper model for grunt work, bulk edits, or simple follow-ups once the hard part is done. Your todo plan, conversation, and file context carry over automatically: you do NOT lose progress. You are the current tier (see Environment / model label in context); heavier = default→heavy or light→default, lighter = reverse. Prefer escalating early over failing repeatedly: if you have tried 2 approaches and are stuck, hand off with a clear reason stating what was tried, what failed, and what the next model should do first.",
    parameters: obj({
      reason: str("Why the handoff is needed: what you tried, what failed or is beyond you, and what the next model should do first."),
      direction: enumStr(["escalate", "de-escalate"], "escalate to a heavier/more capable model or de-escalate to a lighter/cheaper one."),
    }, ["reason"]),
  },
  "clarification.askUser": {
    description: "Ask the human a clarifying question with 2-4 options.",
    parameters: obj({
      question: str("The question to ask."),
      options: { type: "array", items: { type: "string" }, description: "2-4 answer choices." },
    }, ["question"]),
  },
  "mode.switch": {
      description: "Switch the active agent mode at runtime. Use to transition between plan, code, debug, and audit modes as the task evolves.",
      parameters: obj({
        slug: str("The mode slug to switch to (plan, code, debug, audit, or a user-defined mode)."),
    }, ["slug"]),
  },
  "skill": {
    description: "Load a skill's full instructions and enumerate its available scripts, references, and assets. Skills provide specialized workflows, tool integrations, and domain expertise.",
    parameters: obj({
      name: str("The skill name to load (as listed in the Available Skills section of the system prompt)."),
    }, ["name"]),
  },
  "memory": {
    description: "Workspace memory: list, add, edit or delete durable facts, or append a handoff note for future sessions.",
    parameters: obj({
      action: enumStr(["list", "add", "edit", "delete", "note"], "Action to perform (default list)."),
      index: num("Memory index for edit/delete (numbers shown by list)."),
      content: str("Content for add/edit, or note text for note."),
      category: str("Category for add: preferences, architecture, or gotchas (default preferences)."),
      limit: num("Max entries for list (default 20)."),
    }),
  },
  "hooks.list": {
    description: "List the workspace lifecycle hooks.",
    parameters: obj({}),
  },
  "hooks.create": {
    description: "Create a lifecycle hook that runs a shell command when the event fires. Persists to the workspace hooks file; applies to new sessions.",
    parameters: obj({
      event: enumStr(["session.start", "user.submit", "pre.tool", "post.tool", "pre.compact", "post.compact", "pre.handoff", "notification", "stop", "subagent.spawn", "instructions.loaded"], "Event when the hook fires."),
      command: str("Shell command to run."),
      command_windows: str("Windows-only command variant."),
      tool: str("Matcher: only fire for this tool name (pre.tool/post.tool)."),
      mode: str("Matcher: only fire in this mode."),
      tier: enumStr(["heavy", "default", "light", "free"], "Matcher: only fire for this model tier."),
      timeout: num("Timeout in seconds (default 10)."),
    }, ["event", "command"]),
  },
  "hooks.update": {
    description: "Update a lifecycle hook by index. Omitted fields keep their current values.",
    parameters: obj({
      index: num("Index from hooks.list."),
      event: enumStr(["session.start", "user.submit", "pre.tool", "post.tool", "pre.compact", "post.compact", "pre.handoff", "notification", "stop", "subagent.spawn", "instructions.loaded"], "Event when the hook fires."),
      command: str("Shell command to run."),
      command_windows: str("Windows-only command variant."),
      tool: str("Matcher: only fire for this tool name."),
      mode: str("Matcher: only fire in this mode."),
      tier: enumStr(["heavy", "default", "light", "free"], "Matcher: only fire for this model tier."),
      timeout: num("Timeout in seconds."),
    }, ["index"]),
  },
  "hooks.delete": {
    description: "Delete a lifecycle hook by index.",
    parameters: obj({ index: num("Index from hooks.list.") }, ["index"]),
  },
  "browser.hover": {
    description: "Hover over an element matching a CSS selector.",
    parameters: obj({ selector: str("CSS selector of the element to hover.") }, ["selector"]),
  },
  "browser.scroll": {
    description: "Scroll the page by pixel offset or to an element matching a CSS selector.",
    parameters: obj({
      pixels: num("Pixel offset to scroll (positive = down, negative = up). Defaults to 300."),
      selector: str("Optional CSS selector to scroll into view."),
      tabId: str(TAB_ID),
    }),
  },
  "browser.waitFor": {
    description: "Wait for a selector to appear, a URL to match, or a load state before proceeding.",
    parameters: obj({
      selector: str("CSS selector to wait for."),
      url: str("URL pattern to wait for."),
      state: str("Load state: networkidle, load, or domcontentloaded. Defaults to networkidle."),
      tabId: str(TAB_ID),
    }),
  },
  "browser.console": {
    description: "Read the browser's console log (last 50 entries, log/warn/error).",
    parameters: obj({ tabId: str(TAB_ID) }),
  },
  "browser.network": {
    description: "Read the browser's network request log (last 50 entries with method, status, URL, timing).",
    parameters: obj({ tabId: str(TAB_ID) }),
  },
  "browser.domSnapshot": {
    description: "Get a combined snapshot of the browser's current state including console messages and network requests.",
    parameters: obj({ tabId: str(TAB_ID) }),
  },
  "browser.drag": {
    description: "Drag an element onto another element.",
    parameters: obj({
      from: str("CSS selector of the element to drag."),
      to: str("CSS selector of the drop target."),
      tabId: str(TAB_ID),
    }, ["from", "to"]),
  },
  "browser.dialog": {
    description: "Set how the next browser dialog (alert/confirm/prompt) is handled.",
    parameters: obj({
      accept: bool("True to accept the dialog (default), false to dismiss it."),
      promptText: str("Text to enter when the dialog is a prompt."),
    }),
  },
  "browser.runCode": {
    description: "Run a Playwright code snippet against the page. The code receives the `page` object.",
    parameters: obj({
      code: str("JavaScript/Playwright snippet to run."),
      tabId: str(TAB_ID),
    }, ["code"]),
  },
  "browser.readPage": {
    description: "Read the plain text content of the current page.",
    parameters: obj({ tabId: str(TAB_ID) }),
  },
  "notebook.read": {
    description: "Read a Jupyter notebook (.ipynb). Without cellIndex, lists every cell (index, type, source preview, whether it has output). With cellIndex, returns that cell's full source and (for code cells) its text/image output.",
    parameters: obj({
      path: str(NB_PATH),
      cellIndex: num("Optional 0-based cell index to read in full."),
    }, ["path"]),
  },
  "notebook.editCell": {
    description: "Replace the source of a cell in a Jupyter notebook by index.",
    parameters: obj({
      path: str(NB_PATH),
      cellIndex: num("0-based index of the cell to edit."),
      source: str("New source text for the cell."),
    }, ["path", "cellIndex", "source"]),
  },
  "notebook.addCell": {
    description: "Insert a new cell into a Jupyter notebook at the given index. Existing cells shift down.",
    parameters: obj({
      path: str(NB_PATH),
      index: num("0-based index to insert the new cell at."),
      cellType: enumStr(["code", "markdown", "raw"], "Type of the new cell."),
      source: str("Source text for the new cell."),
    }, ["path", "index", "cellType", "source"]),
  },
  "notebook.deleteCell": {
    description: "Delete a cell from a Jupyter notebook by index.",
    parameters: obj({
      path: str(NB_PATH),
      cellIndex: num("0-based index of the cell to delete."),
    }, ["path", "cellIndex"]),
  },
  "notebook.execute": {
    description: "Execute a code cell using the workspace's active Jupyter kernel and return its text/image output.",
    parameters: obj({
      path: str(NB_PATH),
      cellIndex: num("0-based index of the code cell to execute."),
    }, ["path", "cellIndex"]),
  },
  "context.retrieve": {
    description: "Restore the full original content of a compressed tool output. Use the id shown in the compressed output marker when you need details that were omitted.",
    parameters: obj({
      id: str("The retrieval id shown in a compressed tool output marker."),
    }, ["id"]),
  },
  "tool.search": {
    description: "Search for tools by keyword when the loaded tools do not cover the task. Matching tools are returned with their full schemas and loaded for subsequent calls in this session.",
    parameters: obj({
      query: str("Keywords describing the capability needed (e.g. 'browser tabs', 'notebook cells')."),
    }, ["query"]),
  },
};
export function buildToolSpecs(
  enabled: Iterable<string>,
  mcpTools?: { server: string; name: string; description?: string; inputSchema?: Record<string, unknown> }[],
  opts?: { maxIndividualMcpTools?: number },
): { specs: ToolSpec[]; mcpReverse: Map<string, { server: string; tool: string }> } {
  const specs: ToolSpec[] = [];
  const mcpReverse: Map<string, { server: string; tool: string }> = new Map();
  for (const name of enabled) {
    const def = TOOL_PARAM_SPECS[name];
    if (!def) continue;
    specs.push({ name, description: def.description, parameters: def.parameters });
  }
  const mcpEnabled = new Set(enabled);
  const tools = mcpTools ?? [];
  const maxIndividual = opts?.maxIndividualMcpTools ?? 40;
  if (tools.length > 0 && tools.length <= maxIndividual) {
    const seen = new Set<string>();
    for (const t of tools) {
      let specName = mcpToolSpecName(t.server, t.name);
      if (!VALID_SPEC_NAME.test(specName)) continue;
      if (seen.has(specName)) {
        const suffix = createHash("sha256").update(`${t.server} ${t.name}`).digest("hex").slice(0, 6);
        specName = `${specName}_${suffix}`;
        if (!VALID_SPEC_NAME.test(specName) || seen.has(specName)) continue;
      }
      seen.add(specName);
      if (mcpEnabled.has("mcp.call") || mcpEnabled.has(specName)) {
        mcpReverse.set(specName, { server: t.server, tool: t.name });
        specs.push({
          name: specName,
          description: `[MCP ${t.server}] ${t.description ?? t.name}`,
          parameters: t.inputSchema ?? { type: "object", properties: {}, additionalProperties: true },
        });
      }
    }
  }
  return { specs, mcpReverse };
}
const MCP_TOOL_SEP = "__";
const VALID_SPEC_NAME = /^[a-zA-Z0-9_-]+$/;
function safeSpecPart(part: string): string {
  const clean = part.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return clean || "unnamed";
}
export function mcpToolSpecName(server: string, tool: string): string {
  return `mcp${MCP_TOOL_SEP}${safeSpecPart(server)}${MCP_TOOL_SEP}${safeSpecPart(tool)}`;
}
export function isMcpToolSpec(name: string): boolean {
  return name.startsWith("mcp__") && name.indexOf("__", 5) > 5;
}
export function parseMcpToolSpec(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice(5);
  const idx = rest.indexOf("__");
  if (idx <= 0) return undefined;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}