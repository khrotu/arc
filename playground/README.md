# Arc Agent Playground

A self-contained workspace for the Arc agent to read, explore, and exercise every built-in tool.

> Path convention: every tool `path` argument is relative to the agent workspace
> root. If a file write lands somewhere unexpected, probe the actual root first
> (e.g. `shell.run` a directory listing) — file, git, and shell tools all
> resolve from the same root, so a mismatch means the root is not what you
> assumed, not that tools use different bases.
>
> Environment-sensitive rows: `web.search` needs reachable search backends (a
> no-results answer covers the error path); `git.push` / `git.pr` need a
> configured remote and `gh` auth; several rows below (notebook, git, test,
> exportTrace, some browser tabs) sit in the default `arc.tools.disabled`
> list — enable them before covering those rows.

## Structure

```
.arc/         Arc configuration directory
  mcp.json    Reference MCP config (context7). MCP servers are NOT loaded
              from the repo; hydrate ~/.arc/workspaces/<hash>/mcp.json with
              it, or register the server in-session via mcp.create
  skills/     Skill definitions (skill.read, skill.use)
    demo-skill.md  Conventions for working in the playground
  rules/      Rule definitions (rule.read, rule.list)
    test-rule.md   No destructive commands policy
src/          TypeScript source files with intentional issues for LSP tools
  index.ts    Entry point - has a type mismatch and unused import (lsp.problems)
  config.json Configuration to read and modify (file.read, file.edit)
  utils.ts    Helper with a "REPLACE_ME" sentinel in slugify (file.edit test)
  style.css   CSS with a duplicated rule (lsp.problemsFor on style files)
web/          Static HTML page for browser tools
  index.html       Page for browser.navigate / browser.readDom / browser.click / browser.screenshot
  script.js        JS wired to the HTML (browser.evaluate)
scripts/      Shell commands
  demo.ps1    PowerShell script to run (shell.run)
  slow.ps1    Long-running script for timeout parameter testing
  interactive.ps1  Interactive script waiting on stdin (shell.backgroundRun, shell.check, shell.write)
  build.ps1   Simulated build script for runAfter parameter testing
  lint.ps1    Simulated lint check for customRun chaining
  check.ps1   Simulated test run for customRun chaining
data/         Text and structured data
  sample.json  Nested JSON to read and traverse
  todo.txt     Plain text task checklist
  urls.txt     URLs for webfetch and web.search queries
test/         Test files
  example.test.ts    Vitest test suite (test.run); has a REPLACE_ME test that fails until fixed
  checkpoint-compare-a.md  Initial state fixture for checkpoint.compare
  checkpoint-compare-b.md  Modified state fixture for checkpoint.compare
notebook-demo.ipynb  Jupyter notebook for notebook.read/editCell/addCell/deleteCell/execute
```

## Tool Coverage Matrix

### File Tools

| Tool | Action |
| ------ | -------- |
| file.read | Read `data/sample.json`, `data/todo.txt`, `src/config.json`; test offset/limit |
| file.edit | Replace `REPLACE_ME` in `src/utils.ts`; test runAfter with `scripts/build.ps1` |
| file.write | Write `data/output.txt`, `data/generated.txt`; test runAfter |
| file.grep | Grep for `REPLACE_ME`, `export function`, `import`; test include pattern |
| file.glob | Glob `**/*.ts`, `src/**/*`, `scripts/*.ps1`, `**/*.md` |
| file.semanticSearch | Search for "conventions", "destructive commands", "REPLACE_ME sentinel" |

### Shell Tools

| Tool | Action |
| ------ | -------- |
| shell.run | Run `demo.ps1`; test timeout with `slow.ps1` (3s adopts into background with partial output vs -1 runs to completion) |
| shell.backgroundRun | Background `slow.ps1`, `interactive.ps1` |
| shell.check | Poll background process output and exit status |
| shell.write | Send stdin to `interactive.ps1` (a trailing newline is appended if missing, for line-buffered readers) |
| shell.customRun | Create named pipeline 'full_check' (lint + build + check) |
| shell.editCustomRun | Edit pipeline: add demo.ps1, rename to 'pipeline' (renaming also renames the id); test error on nonexistent id |
| shell.runCustomRun | Run the 'pipeline' custom run by id or display name |

### LSP Tools

| Tool | Action |
| ------ | -------- |
| lsp.problems | Check workspace-wide diagnostics. Mirrors the Problems tab exactly: TypeScript diagnostics only exist for files currently open in the editor, so expect results only after opening the files (`src/index.ts` then shows its type mismatch; the unused import needs `noUnusedLocals` to surface) |
| lsp.problemsFor | Check `src/index.ts` and `src/style.css` individually (same open-file caveat as above) |

### Web Tools

| Tool | Action |
| ------ | -------- |
| web.fetch | Fetch `https://example.com`, `httpbin.org/html`, `httpbin.org/json`; test 404 + DNS errors |
| web.search | Search "Arc agentic coding assistant", "TypeScript type narrowing" |

### Browser Tools

| Tool | Action |
| ------ | -------- |
| browser.navigate | Navigate to `web/index.html` |
| browser.readDom | Read accessibility tree of loaded page |
| browser.readPage | Read page text content |
| browser.click | Click the form buttons |
| browser.type | Type into form inputs |
| browser.screenshot | Capture the page |
| browser.evaluate | Run JS in page context |
| browser.console | Read browser console messages |
| browser.network | Read network request log |
| browser.domSnapshot | Get full page snapshot |
| browser.drag | Drag from one selector to another |
| browser.dialog | Handle browser dialogs (alert, confirm, prompt) |
| browser.runCode | Run a constrained page-automation snippet (goto/click/fill/evaluate/...) |
| browser.hover | Hover over a selector |
| browser.scroll | Scroll to a selector or by pixels |
| browser.waitFor | Wait for selector, URL, or state |
| browser.newTab / switchTab / closeTab / listTabs | Tab management |
| browser.intercept / unintercept | Network request interception |
| browser.close | Close browser |

### MCP Tools

| Tool | Action |
| ------ | -------- |
| mcp.call | Call `resolve-library-id` or `query-docs` on the context7 server (tool names are `{server}/{registered-tool}`, not `context7/resolve`) |
| mcp.create | Register a new MCP server |
| mcp.remove | Remove an MCP server |
| mcp.toggle | Enable/disable an MCP server |
| mcp.resources/list | List resources on a server (context7 exposes none — the empty list is the expected result) |
| mcp.resources/read | Read resource by URI (expect not-found on context7; that covers the error path) |
| mcp.prompts/list | List prompts on a server (context7 exposes none — the empty list is the expected result) |
| mcp.prompts/get | Get prompt by name (expect not-found on context7; that covers the error path) |

### Subagent Tools

| Tool | Action |
| ------ | -------- |
| subagent.spawn | Single, batch (parallel), and rule-constrained subagents |
| subagent.askParent | Subagent asks parent for clarification |

### Checkpoint Tools

| Tool | Action |
| ------ | -------- |
| checkpoint.revert | Revert file edits to checkpoint state |
| checkpoint.list | List workspace checkpoints, most recent first (index 1 = newest; matches revert/compare) |
| checkpoint.compare | Compare two checkpoints by index or turnId |

### Mode / Skill / Memory / Rule Tools

| Tool | Action |
| ------ | -------- |
| mode.switch | Switch between plan/code/audit/debug modes |
| skill.read | Read skill by `name` (e.g. `demo-skill`), not by file path |
| skill.use | Load skill into agent context |
| memory.add | Add memory entry with exact keys `category` + `content` |
| memory.note | Leave a session note for future sessions in this workspace |
| memory.list | List all memory entries |
| memory.edit | Edit memory by index |
| memory.delete | Delete memory by index |
| rule.list | List `.arc/rules/` entries |
| rule.read | Read rule by `name` (e.g. `test-rule`), not by file path |
| rule.create | Create a new rule (requires `name` + `content` + `glob` + `description`) |

### Git Tools

| Tool | Action |
| ------ | -------- |
| git.changedFiles | List files changed since last commit |
| git.diffUnstaged | Read unstaged diff |
| git.diffStaged | Read staged diff |
| git.branchDiff | Diff current branch vs base |
| git.commitMessage | Generate commit message from diff |
| git.stage | Stage a file with a workspace-relative path (the file.edit demo creates changes to stage) |
| git.commit | Commit staged changes (approval-gated) |
| git.push | Push to a remote (approval-gated; pass `branch` alone to use the default remote, needs a configured remote; `gh` auth needed for `git.pr`) |
| git.branch | List / create / switch / delete branches |
| git.pr | Create or view a PR via the gh CLI |

### Wait Tools

| Tool | Action |
| ------ | -------- |
| wait.for | Fixed delay between chained commands |
| wait.until | Wait until a wall-clock time |
| wait.forProcess | Wait for a background process to exit (pair with shell.backgroundRun on slow.ps1) |
| wait.forCommand | Wait until a command succeeds (pair with scripts/check.ps1) |

### Hooks Tools

| Tool | Action |
| ------ | -------- |
| hooks.list | List hooks defined in the workspace hooks.json |
| hooks.create | Create a hook (e.g. log on task completion) |
| hooks.update | Update an existing hook |
| hooks.delete | Delete a hook |

### Notebook Tools

> Disabled by default (`arc.tools.disabled`): enable them before covering these rows.

| Tool | Action |
| ------ | -------- |
| notebook.read | List cells / read specific cell by index |
| notebook.editCell | Edit cell source (fix REPLACE_ME in cell 1) |
| notebook.addCell | Add new code cell |
| notebook.deleteCell | Delete cell by index |
| notebook.execute | Execute cell and return output |

### Other Tools

| Tool | Action |
| ------ | -------- |
| todo.write | Set multi-step plans |
| context.retrieve | Restore an oversized tool output that was compressed into a retrieval id |
| test.run | Run `test/example.test.ts` (vitest) |
| handoff | Escalate to a heavier model tier |
| clarification.askUser | Ask whether to keep/delete a file |
| session.exportTrace | Export the session trace as markdown + JSON; pass `path` to also write it to a file, otherwise re-read the full trace via the returned `context.retrieve` id |
