import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileEditor } from "../edit/editor.js";
import { getWorkspaceArcDir } from "../arc-dir.js";
import { runPreWriteHooks, runPostEditHooks } from "../hooks/hooks.js";
import { minimalEnvironment, PROCESS_OUTPUT_LIMIT, proxyEnvironment, runShellCommand, shellCommand, spawnBounded, terminateProcessTree } from "../util/process.js";
import { readBodyLimited, safeFetch } from "../security/network.js";
import { makeProxyDispatcher } from "../util/proxy.js";
import { parseNotebook, serializeNotebook, listCells, readCell, editCellSource, addCell, deleteCell } from "../notebook/notebook.js";
import { normalizeWebSearchBackend, searchWithApiBackend, WEB_SEARCH_BACKEND_LABELS } from "../websearch/websearch.js";
import type { SandboxProfile } from "../sandbox/sandbox.js";
import type { DiffHunk } from "../protocol/process.js";
import { loadArcIgnore } from "../util/arcignore.js";
import { globToRegExpSource } from "../util/glob.js";
function toRel(root: string, p: string): string {
  const rel = path.relative(root, path.resolve(root, p)).replace(/\\/g, "/");
  return rel.startsWith("..") ? p.replace(/\\/g, "/") : rel;
}
async function isArcIgnored(root: string, p: string): Promise<boolean> {
  try {
    const ignore = await loadArcIgnore(root);
    return ignore.isIgnored(toRel(root, p));
  } catch {
    return false;
  }
}
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
type BrowserAdapter = import("../browser/browser.js").BrowserAdapter;
type BrowserSource = BrowserAdapter | (() => Promise<BrowserAdapter>);
async function resolveBrowser(src: BrowserSource | undefined): Promise<BrowserAdapter | undefined> {
  if (!src) return undefined;
  return typeof src === "function" ? await src() : src;
}
function withBrowser(ctx: ToolContext, call: (b: BrowserAdapter) => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  return (async () => {
    const b = await resolveBrowser(ctx.browser);
    if (!b) return { ok: false, output: "Browser not available." };
    return call(b);
  })();
}
interface BgProcess { proc: ChildProcess; command: string; stdout: string; stderr: string; exited: boolean; exitCode: number | undefined; }
const bgProcesses = new Map<string, BgProcess>();
let bgIds = 0;
const activeProcesses = new Set<ChildProcess>();
export function decodeInputEscapes(s: string): string {
  return s.replace(/\\(\\|"|n|r|t|b|f|v|0|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|')/g, (_m, e: string) => {
    switch (e) {
      case "\\": return "\\";
      case '"': return '"';
      case "'": return "'";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "0": return "\0";
      default: return String.fromCharCode(parseInt(e.slice(1), 16));
    }
  });
}
export function listBackgroundProcesses(): { id: string; command: string; exited: boolean }[] {
  const out: { id: string; command: string; exited: boolean }[] = [];
  for (const [id, bg] of bgProcesses) {
    if (!bg.exited) out.push({ id, command: bg.command, exited: bg.exited });
  }
  return out;
}
export function killActiveProcesses(): { count: number; pids: number[] } {
  const pids: number[] = [];
  let count = 0;
  const seen = new Set<ChildProcess>();
  for (const bg of bgProcesses.values()) {
    if (seen.has(bg.proc)) continue;
    seen.add(bg.proc);
    bg.exited = true;
    if (bg.proc.pid && !bg.proc.killed) {
      pids.push(bg.proc.pid);
      terminateProcessTree(bg.proc);
      count++;
    }
  }
  for (const proc of activeProcesses) {
    if (seen.has(proc)) continue;
    seen.add(proc);
    if (proc.pid && !proc.killed) {
      pids.push(proc.pid);
      terminateProcessTree(proc);
      count++;
    }
  }
  bgProcesses.clear();
  activeProcesses.clear();
  return { count, pids };
}
async function streamDiffHunks(
  hunks: import("../protocol/process.js").DiffHunk[],
  filePath: string,
  onDiff: (hunks: import("../protocol/process.js").DiffHunk[], filePath: string) => void,
): Promise<void> {
  for (let i = 0; i < hunks.length; i++) {
    onDiff(hunks.slice(0, i + 1), filePath);
    await new Promise((r) => setTimeout(r, 40));
  }
}
function adoptBackgroundProcess(proc: ChildProcess, command: string, stdout: string, stderr: string, onChunk?: (stream: "stdout" | "stderr", text: string) => void): string {
  const bg: BgProcess = { proc, command, stdout: stripAnsi(stdout).slice(-PROCESS_OUTPUT_LIMIT), stderr: stripAnsi(stderr).slice(-PROCESS_OUTPUT_LIMIT), exited: false, exitCode: undefined };
  const id = String(bgIds++);
  bgProcesses.set(id, bg);
  proc.stdout?.on("data", (d: Buffer) => {
    const s = stripAnsi(d.toString());
    bg.stdout = (bg.stdout + s).slice(-PROCESS_OUTPUT_LIMIT);
    onChunk?.("stdout", s);
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const s = stripAnsi(d.toString());
    bg.stderr = (bg.stderr + s).slice(-PROCESS_OUTPUT_LIMIT);
    onChunk?.("stderr", s);
  });
  proc.on("exit", (code) => {
    bg.exited = true;
    bg.exitCode = code ?? undefined;
    activeProcesses.delete(proc);
    const t = setTimeout(() => { bgProcesses.delete(id); }, 60_000);
    if (typeof (t as unknown as { unref?: () => void }).unref === "function") (t as unknown as { unref: () => void }).unref();
  });
  proc.on("error", (err) => {
    bg.exited = true;
    bg.stderr += `\n[spawn error] ${err.message}`;
    activeProcesses.delete(proc);
    const t = setTimeout(() => { bgProcesses.delete(id); }, 60_000);
    if (typeof (t as unknown as { unref?: () => void }).unref === "function") (t as unknown as { unref: () => void }).unref();
  });
  return id;
}
const HOOK_EVENTS = ["session.start", "user.submit", "pre.tool", "post.tool", "pre.compact", "post.compact", "pre.handoff", "notification", "stop", "subagent.spawn", "instructions.loaded"];
type HookFile = { cfg: Record<string, unknown>; hooks: Record<string, unknown>[]; p: string };
async function readHooksFile(root: string): Promise<HookFile> {
  const p = path.join(getWorkspaceArcDir(root), "hooks.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(await fs.readFile(p, "utf-8")) as Record<string, unknown>; } catch { }
  const hooks = Array.isArray(cfg.hooks) ? (cfg.hooks as Record<string, unknown>[]) : [];
  return { cfg, hooks, p };
}
async function writeHooksFile(file: HookFile): Promise<void> {
  file.cfg.hooks = file.hooks;
  await fs.mkdir(path.dirname(file.p), { recursive: true });
  await fs.writeFile(file.p, JSON.stringify(file.cfg, null, 2), "utf-8");
}
function describeHook(h: Record<string, unknown>, i: number): string {
  const m = h.matchers as Record<string, string> | undefined;
  const matchers = [m?.tool, m?.mode, m?.modelTier].filter(Boolean).join(", ");
  return `${i}: [${h.event}]${matchers ? ` (matcher: ${matchers})` : ""} ${String(h.command)}${h.timeout_sec ? ` (timeout: ${h.timeout_sec}s)` : ""}`;
}
function normalizeHook(args: Record<string, unknown>, base?: Record<string, unknown>): { hook?: Record<string, unknown>; error?: string } {
  const event = String(args.event ?? base?.event ?? "").trim();
  if (!HOOK_EVENTS.includes(event)) return { error: `Unknown event '${event}'. Valid: ${HOOK_EVENTS.join(", ")}` };
  const command = String(args.command ?? base?.command ?? "").trim();
  if (!command) return { error: "command is required." };
  const hook: Record<string, unknown> = { event, command };
  const commandWindows = String(args.command_windows ?? base?.command_windows ?? "").trim();
  if (commandWindows) hook.command_windows = commandWindows;
  const baseMatchers = base?.matchers as Record<string, string> | undefined;
  const tool = String(args.tool ?? baseMatchers?.tool ?? "").trim();
  const mode = String(args.mode ?? baseMatchers?.mode ?? "").trim();
  const tier = String(args.tier ?? baseMatchers?.modelTier ?? "").trim();
  const matchers: Record<string, string> = {};
  if (tool) matchers.tool = tool;
  if (mode) matchers.mode = mode;
  if (tier) {
    if (!["heavy", "default", "light", "free"].includes(tier)) return { error: "tier must be one of: heavy, default, light, free." };
    matchers.modelTier = tier;
  }
  if (Object.keys(matchers).length) hook.matchers = matchers;
  const timeout = args.timeout ?? base?.timeout_sec;
  if (timeout !== undefined && timeout !== "") {
    const n = Number(timeout);
    if (!Number.isFinite(n) || n <= 0) return { error: "timeout must be a positive number of seconds." };
    hook.timeout_sec = n;
  }
  return { hook };
}
export function parseTimeoutSec(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes)?$/i);
    if (m) {
      const n = Number(m[1]);
      const unit = (m[2] ?? "s").toLowerCase();
      if (unit === "ms") return n / 1000;
      if (unit.startsWith("m")) return n * 60;
      return n;
    }
  }
  return -1;
}
function hailMary(ctx: ToolContext): boolean {
  return ctx.sessionApprovals?.autoApproveMode === "all";
}
async function runAfterCmd(cmd: string | undefined, cwd: string, ctx: ToolContext): Promise<{ command: string; output: string } | undefined> {
  if (!cmd) return undefined;
  const approved = hailMary(ctx) ? true : await ctx.requestApproval?.(`Run post-write command?\n\n${cmd}`, { command: cmd });
  if (!approved) return { command: cmd, output: "[runAfter denied by user]" };
  const proxyEnv = proxyEnvironment(ctx.proxyShell || ctx.proxyUrl);
  const result = await runShellCommand(cmd, {
    cwd,
    env: minimalEnvironment(proxyEnv),
    timeoutMs: 120_000,
    maxOutputBytes: PROCESS_OUTPUT_LIMIT,
    sandboxProfile: ctx.sandboxProfile,
    workspaceRoot: ctx.workspacePath,
  });
  const output = (stripAnsi(result.stdout) + (result.stderr ? `\n[stderr]\n${stripAnsi(result.stderr)}` : "")).slice(0, 2000) || "(no output)";
  return { command: cmd, output: result.ok ? output : `[runAfter failed] ${output}` };
}
async function enforcePreWrite(filePath: string, content: string, ctx: ToolContext): Promise<void> {
  const scan = await runPreWriteHooks(filePath, content, ctx.root, ctx.sandboxProfile);
  if (scan.ok) return;
  const approved = await ctx.requestApproval?.(`Potential secret detected before writing ${filePath}:\n\n${scan.errors.join("\n")}\n\nWrite this file once anyway?`);
  if (!approved) throw new Error(scan.errors.join("\n"));
}
import type { ApprovalsConfig, SessionApprovals, ApproveShellMeta } from "../approvals/index.js";
import type { SkillRegistry } from "../skills/index.js";
import type { FileContextTracker } from "../context/context.js";
export interface ToolContext {
  root: string;
  approvalsConfig: ApprovalsConfig;
  sessionApprovals: SessionApprovals;
  requestApproval?: (description: string, meta?: ApproveShellMeta) => Promise<boolean>;
  addSessionCommand?: (command: string) => void;
  skillRegistry?: SkillRegistry;
  sandboxProfile?: SandboxProfile;
  shellSurface?: "arc-handled" | "integrated";
  runInVsCodeTerminal?: (command: string, cwd: string) => Promise<{ ok: boolean; output: string }>;
  problems?: () => Promise<import("../lsp/lsp.js").DiagnosticLite[]>;
  problemsFor?: (file: string) => Promise<import("../lsp/lsp.js").DiagnosticLite[]>;
  summaryForFiles?: (files: string[]) => Promise<{ hasErrors: boolean; hasWarnings: boolean; text: string }>;
  grep?: (pattern: string, include?: string) => Promise<{ file: string; line: number; column: number; text: string }[]>;
  glob?: (pattern: string) => Promise<string[]>;
  browser?: import("../browser/browser.js").BrowserAdapter | (() => Promise<import("../browser/browser.js").BrowserAdapter>);
  mcp?: import("../mcp/mcp.js").McpAggregator;
  workspacePath: string;
  onChunk?: (stream: "stdout" | "stderr", text: string) => void;
  onDiff?: (diffHunks: import("../protocol/process.js").DiffHunk[], filePath: string) => void;
  proxyUrl?: string;
  proxyProvider?: string;
  proxyWeb?: string;
  proxyShell?: string;
  webSearchBackend?: string;
  webSearchApiKey?: string;
  describeImage?: (dataUrl: string) => Promise<string | undefined>;
  fileContextTracker?: FileContextTracker;
  executeNotebookCell?: (path: string, cellIndex: number) => Promise<{ ok: boolean; output: string; images?: string[] }>;
  allowExternalPath?: boolean;
  teamMemoryStores?: string[];
  signal?: AbortSignal;
}
export interface ToolResult {
  ok: boolean;
  output: string;
  touchedFiles?: string[];
  todoState?: { items: { id: string; text: string; state: "pending" | "in_progress" | "done" }[] };
  clarification?: { id: string; answer: string };
  diffHunks?: DiffHunk[];
  filePath?: string;
  runAfter?: { command: string; output: string };
  images?: { type: string; image_url: { url: string } }[];
}
export type ToolFn = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
function normalizeTodoState(raw: unknown): "pending" | "in_progress" | "done" {
  return raw === "in_progress" || raw === "done" ? raw : "pending";
}
export function checkWriteGlob(filePath: string, glob: string, root?: string): { allowed: boolean } {
  try {
    if (!glob.trim() || glob.includes("\0")) return { allowed: false };
    let normalized = filePath.replace(/\\/g, "/");
    if (root) {
      const abs = path.resolve(root, filePath);
      const rel = path.relative(path.resolve(root), abs);
      if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { allowed: false };
      normalized = rel.replace(/\\/g, "/");
    }
    const portable = glob.replace(/\\(?![*?[\]{}!\\])/g, "/");
    const re = new RegExp(`^${globToRegExpSource(portable)}$`, "i");
    return { allowed: re.test(normalized) };
  } catch {
    return { allowed: false };
  }
}
async function startBackgroundProcess(cmd: string, cwd: string, ctx: ToolContext): Promise<ToolResult> {
  try {
    const proxyEnv = proxyEnvironment(ctx.proxyShell || ctx.proxyUrl);
    const shell = await shellCommand(cmd);
    const proc = spawnBounded(shell.executable, shell.args, { cwd, env: minimalEnvironment(proxyEnv), sandboxProfile: ctx.sandboxProfile, workspaceRoot: ctx.workspacePath });
    activeProcesses.add(proc);
    const bg: BgProcess = { proc, command: cmd, stdout: "", stderr: "", exited: false, exitCode: undefined };
    const id = String(bgIds++);
    bgProcesses.set(id, bg);
    const onChunk = ctx.onChunk;
    proc.stdout?.on("data", (d: Buffer) => {
      const s = stripAnsi(d.toString());
      bg.stdout = (bg.stdout + s).slice(-PROCESS_OUTPUT_LIMIT);
      onChunk?.("stdout", s);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const s = stripAnsi(d.toString());
      bg.stderr = (bg.stderr + s).slice(-PROCESS_OUTPUT_LIMIT);
      onChunk?.("stderr", s);
    });
    const expire = () => {
      const t = setTimeout(() => { bgProcesses.delete(id); }, 60_000);
      if (typeof (t as unknown as { unref?: () => void }).unref === "function") (t as unknown as { unref: () => void }).unref();
    };
    proc.on("exit", (code) => { bg.exited = true; bg.exitCode = code ?? undefined; activeProcesses.delete(proc); expire(); });
    proc.on("error", (err) => { bg.exited = true; bg.stderr += `\n[spawn error] ${err.message}`; activeProcesses.delete(proc); expire(); });
    return { ok: true, output: `Background process started (id: ${id}). Use shell.check to poll output.` };
  } catch (e: unknown) {
    return { ok: false, output: `Failed to start background process: ${(e as Error).message}` };
  }
}
function waitTimeoutMs(raw: unknown, fallbackMs: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return Math.min(n * 1000, MAX_WAIT_MS);
}
export const tools: Record<string, { description?: string; fn: ToolFn }> = {
  "file.read": {
    fn: async (args, ctx) => {
      if (typeof args.path !== "string") return { ok: false, output: "file.read requires a string `path` argument." };
      if (await isArcIgnored(ctx.root, String(args.path))) {
        return { ok: false, output: `Refused: '${args.path}' is ignored by .arcignore.` };
      }
      const ed = new FileEditor(ctx.root, !!ctx.allowExternalPath);
      const filePath = String(args.path);
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic"]);
      const MIME: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
        webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", heic: "image/heic",
      };
      if (IMAGE_EXTS.has(ext)) {
        try {
          const full = ed.resolve(filePath);
          const stat = await fs.stat(full).catch(() => undefined);
          if (stat && stat.size > 8 * 1024 * 1024) {
            return { ok: false, output: `Refused: image '${filePath}' is ${(stat.size / 1048576).toFixed(1)}MB (>8MB).` };
          }
          const buf = await fs.readFile(full);
          const base64 = buf.toString("base64");
          const mime = MIME[ext] ?? "image/png";
          const dataUrl = `data:${mime};base64,${base64}`;
          const sizeLabel = buf.length < 1024 ? `${buf.length}B` : `${(buf.length / 1024).toFixed(1)}KB`;
          if (ctx.describeImage) {
            const description = await ctx.describeImage(base64).catch(() => undefined);
            if (description) {
              return { ok: true, output: `Read image: ${filePath.split(/[/\\]/).pop()} (${mime}, ${sizeLabel})\n${description}`, filePath, touchedFiles: [filePath] };
            }
          }
          return {
            ok: true,
            output: `Read image: ${filePath.split(/[/\\]/).pop()} (${mime}, ${sizeLabel})`,
            filePath,
            touchedFiles: [filePath],
            images: [{ type: "image_url", image_url: { url: dataUrl } }],
          };
        } catch (e) {
          return { ok: false, output: `Failed to read image: ${(e as Error).message}` };
        }
      }
      const offset = args.offset ? Number(args.offset) : undefined;
      const limit = args.limit ? Number(args.limit) : undefined;
      if (typeof args.path !== "string") return { ok: false, output: "file.read requires a string `path` argument." };
      const body = await ed.read(args.path, { offset, limit });
      return { ok: true, output: body, filePath: args.path, touchedFiles: [args.path] };
    },
  },
  "file.edit": {
    fn: async (args, ctx) => {
      if (typeof args.path !== "string") return { ok: false, output: "file.edit requires a string `path` argument." };
      if (await isArcIgnored(ctx.root, String(args.path))) {
        return { ok: false, output: `Refused: '${args.path}' is ignored by .arcignore.` };
      }
      if (typeof args.search !== "string") return { ok: false, output: "file.edit requires a string `search` argument." };
      if ((args.replace === undefined || args.replace === "") && !/<<<<<<< SEARCH\s*(?:\r\n|\r|\n)/.test(args.search)) {
        return { ok: false, output: "file.edit requires a non-empty `replace` argument for plain-text search. To delete a block, pass an explicit SEARCH/REPLACE block with an empty REPLACE section." };
      }
      const ed = new FileEditor(ctx.root, !!ctx.allowExternalPath);
      const filePath = args.path;
      const replace = String(args.replace);
      const r = await ed.apply(filePath, args.search, replace, {
        replaceAll: !!args.replaceAll,
        validate: async (content) => {
          await enforcePreWrite(filePath, content, ctx);
        },
      });
      const ra = r.ok ? await runAfterCmd(args.runAfter ? String(args.runAfter) : undefined, ctx.workspacePath, ctx) : undefined;
      if (r.ok) {
        runPostEditHooks(filePath, ctx.root, ctx.sandboxProfile).catch(() => {});
      }
      const hunks = r.ok ? r.diff.map((c) => ({ added: c.added ?? false, removed: c.removed ?? false, value: c.value, ...(c.oldStart !== undefined ? { oldStart: c.oldStart } : {}), ...(c.newStart !== undefined ? { newStart: c.newStart } : {}), ...(typeof c.count === "number" ? { count: c.count } : {}) })) : [];
      if (r.ok && hunks.length && ctx.onDiff) {
        await streamDiffHunks(hunks, filePath, ctx.onDiff);
      }
      return {
        ok: r.ok,
        output: r.ok ? `Edited ${filePath} (${r.strategy}, ${r.matches} match${r.matches === 1 ? "" : "es"})` : `Error: ${r.error}`,
        touchedFiles: r.ok ? [filePath] : [],
        diffHunks: hunks,
        filePath: filePath,
        runAfter: ra,
      };
    },
  },
  "file.write": {
    fn: async (args, ctx) => {
      if (typeof args.path !== "string") return { ok: false, output: "file.write requires a string `path` argument." };
      if (typeof args.content !== "string") return { ok: false, output: "file.write requires a string `content` argument." };
      if (await isArcIgnored(ctx.root, String(args.path))) {
        return { ok: false, output: `Refused: '${args.path}' is ignored by .arcignore.` };
      }
      const ed = new FileEditor(ctx.root, !!ctx.allowExternalPath);
      const filePath = args.path;
      const content = args.content;
      const r = await ed.apply(filePath, "", content, {
        validate: async (next) => {
          await enforcePreWrite(filePath, next, ctx);
        },
      });
      const ra = r.ok ? await runAfterCmd(args.runAfter ? String(args.runAfter) : undefined, ctx.workspacePath, ctx) : undefined;
      if (r.ok) {
        runPostEditHooks(filePath, ctx.root, ctx.sandboxProfile).catch(() => {});
      }
      const hunks = r.ok ? r.diff.map((c) => ({ added: c.added ?? false, removed: c.removed ?? false, value: c.value, ...(c.oldStart !== undefined ? { oldStart: c.oldStart } : {}), ...(c.newStart !== undefined ? { newStart: c.newStart } : {}), ...(typeof c.count === "number" ? { count: c.count } : {}) })) : [];
      if (r.ok && hunks.length && ctx.onDiff) {
        await streamDiffHunks(hunks, filePath, ctx.onDiff);
      }
      return {
        ok: r.ok,
        output: r.ok ? `Wrote ${filePath}` : `Error: ${r.error ?? "write failed"}`,
        touchedFiles: r.ok ? [filePath] : [],
        diffHunks: hunks,
        filePath: filePath,
        runAfter: ra,
      };
    },
  },
  "file.grep": {
    fn: async (args, ctx) => {
      if (!ctx.grep) return { ok: false, output: "Grep not available in this environment." };
      const pattern = String(args.pattern ?? "");
      const include = args.include ? String(args.include) : undefined;
      if (!pattern) return { ok: false, output: "No pattern provided." };
      if (pattern.length > 256 || /\\[1-9]|\([^)]*[+*{][^)]*\)[+*{]|(?:\.\*|\.\+|\[[^\]]*\][+*])[+*{]/.test(pattern)) {
        return { ok: false, output: "Regex rejected because it is too large or contains unsafe nested repetition/backreferences." };
      }
      const results = await ctx.grep(pattern, include);
      const ignore = await loadArcIgnore(ctx.root).catch(() => null);
      const filtered = ignore ? results.filter((r) => !ignore.isIgnored(r.file)) : results;
      if (filtered.length === 0) return { ok: true, output: `No matches for /${pattern}/` };
      const out = filtered.map((r) => `${r.file}:${r.line}:${r.column}: ${r.text}`).join("\n");
      return { ok: true, output: out };
    },
  },
  "file.glob": {
    fn: async (args, ctx) => {
      if (!ctx.glob) return { ok: false, output: "Glob not available in this environment." };
      const pattern = String(args.pattern ?? "");
      if (!pattern) return { ok: false, output: "No pattern provided." };
      const files = await ctx.glob(pattern);
      const ignore = await loadArcIgnore(ctx.root).catch(() => null);
      const filtered = ignore ? files.filter((f) => !ignore.isIgnored(f)) : files;
      if (filtered.length === 0) return { ok: true, output: `No files matching ${pattern}` };
      return { ok: true, output: filtered.join("\n") };
    },
  },
  "shell.run": {
    fn: async (args, ctx) => {
      const cmd = String(args.command);
      const cwd = (args.cwd ? String(args.cwd) : ctx.root) || ctx.root;
      if (args.untilSuccess) {
        if (!cmd) return { ok: false, output: "shell.run requires a `command`." };
        const approved = hailMary(ctx) ? true : await ctx.requestApproval?.(`Run condition-wait command (repeats until success or timeout)?\n\n${cmd}`, { command: cmd });
        if (!approved) return { ok: false, output: "shell.run condition wait denied by user." };
        const intervalRaw = Number(args.interval ?? 1);
        const intervalMs = Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.max(250, Math.round(intervalRaw * 1000)) : 1000;
        const timeoutMs = args.timeout !== undefined ? Math.max(waitTimeoutMs(args.timeout, 600_000), intervalMs) : 600_000;
        const deadline = Date.now() + timeoutMs;
        let attempts = 0;
        let lastOutput = "";
        while (true) {
          if (ctx.signal?.aborted) return { ok: false, output: `Condition wait interrupted after ${attempts} attempt(s).` };
          attempts++;
          const result = await runShellCommand(cmd, {
            cwd,
            env: minimalEnvironment(proxyEnvironment(ctx.proxyShell || ctx.proxyUrl)),
            timeoutMs: Math.max(intervalMs * 2, 3000),
            maxOutputBytes: 64 * 1024,
            sandboxProfile: ctx.sandboxProfile,
            workspaceRoot: ctx.workspacePath,
          });
          lastOutput = (stripAnsi(result.stdout) + (result.stderr ? `\n[stderr]\n${stripAnsi(result.stderr)}` : "")).trim().slice(-2000);
          if (result.ok) {
            return { ok: true, output: `Command succeeded on attempt ${attempts}.\n${lastOutput || "(no output)"}` };
          }
          if (Date.now() >= deadline) {
            return { ok: false, output: `Command still failing after ${attempts} attempt(s) over ${timeoutMs / 1000}s.\n${lastOutput || "(no output)"}` };
          }
          await sleepAbortable(intervalMs, ctx.signal);
        }
      }
      const surface = ctx.shellSurface ?? "arc-handled";
      if (surface === "integrated") {
        if (!ctx.runInVsCodeTerminal) return { ok: false, output: "Shell surface 'integrated' is not available in this environment (requires the Arc VS Code extension)." };
        return await ctx.runInVsCodeTerminal(cmd, cwd);
      }
      const timeoutSec = parseTimeoutSec(args.timeout);
      const onChunk = ctx.onChunk;
      const proxyEnv = proxyEnvironment(ctx.proxyShell || ctx.proxyUrl);
      let spawned: ChildProcess | undefined;
      let adoptedId: string | undefined;
      const result = await runShellCommand(cmd, {
        cwd,
        env: minimalEnvironment(proxyEnv),
        timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : undefined,
        maxOutputBytes: PROCESS_OUTPUT_LIMIT,
        sandboxProfile: ctx.sandboxProfile,
        workspaceRoot: ctx.workspacePath,
        onChunk: (stream, text) => onChunk?.(stream, stripAnsi(text)),
        onSpawn: (proc) => { spawned = proc; activeProcesses.add(proc); },
        timeoutAdopt: timeoutSec > 0 ? (proc, out, err) => {
          adoptedId = adoptBackgroundProcess(proc, cmd, out, err, onChunk);
          return true;
        } : undefined,
      });
      if (spawned && adoptedId === undefined) activeProcesses.delete(spawned);
      if (adoptedId !== undefined) {
        const output = stripAnsi(result.stdout)
          + (result.stderr ? `\n[stderr]\n${stripAnsi(result.stderr)}` : "")
          + `\n[timed out after ${timeoutSec}s] Still running in the background (id: ${adoptedId}). Partial output above; do not restart the command. Poll with shell.check (id: ${adoptedId}), send stdin with shell.write, or wait for exit with shell.check (id: ${adoptedId}, waitForExit: true).`;
        return { ok: false, output };
      }
      const output = stripAnsi(result.stdout) + (result.stderr ? `\n[stderr]\n${stripAnsi(result.stderr)}` : "") + (result.truncated ? "\n[output limit exceeded]" : "");
      return { ok: result.ok, output };
    },
  },
  "shell.backgroundRun": {
    fn: async (args, ctx) => {
      const cmd = String(args.command);
      const cwd = (args.cwd ? String(args.cwd) : ctx.root) || ctx.root;
      return startBackgroundProcess(cmd, cwd, ctx);
    },
  },
  "shell.check": {
    fn: async (args, ctx) => {
      const id = String(args.id ?? "");
      const bg = bgProcesses.get(id);
      if (!bg) return { ok: false, output: `No background process with id '${id}'.` };
      if (args.waitForExit) {
        const timeoutMs = args.timeout !== undefined ? waitTimeoutMs(args.timeout, MAX_WAIT_MS) : MAX_WAIT_MS;
        const deadline = Date.now() + timeoutMs;
        while (!bg.exited) {
          if (ctx.signal?.aborted) return { ok: false, output: "shell.check interrupted." };
          if (Date.now() >= deadline) {
            const out = bg.stdout + (bg.stderr ? `\n[stderr]\n${bg.stderr}` : "");
            return { ok: false, output: `Process ${id} still running after ${timeoutMs / 1000}s.\n${out}` };
          }
          await sleepAbortable(500, ctx.signal);
        }
      }
      const status = bg.exited ? `exited (code ${bg.exitCode ?? "unknown"})` : "running";
      const out = (bg.stdout + (bg.stderr ? `\n[stderr]\n${bg.stderr}` : ""));
      return { ok: true, output: `[${status}]\n${out}` };
    },
  },
  "shell.write": {
    fn: async (args) => {
      const id = String(args.id ?? "");
      const input = typeof args.inputEscaped === "string" && args.inputEscaped.length > 0 ? decodeInputEscapes(args.inputEscaped) : String(args.input ?? "");
      const bg = bgProcesses.get(id);
      if (!bg) return { ok: false, output: `No background process with id '${id}'.` };
      if (bg.exited) return { ok: false, output: `Process ${id} has already exited.` };
      const text = input.endsWith("\n") ? input : `${input}\n`;
      try {
        const flushed = bg.proc.stdin?.write(text) ?? false;
        if (!flushed) return { ok: false, output: `Process ${id} is not accepting stdin.` };
        const bytes = Buffer.byteLength(text, "utf8");
        return { ok: true, output: `Sent ${bytes} byte${bytes === 1 ? "" : "s"} to process ${id}.` };
      } catch (e: unknown) {
        return { ok: false, output: `Failed to write to process ${id}: ${(e as Error).message}` };
      }
    },
  },
  "shell.kill": {
    fn: async (args) => {
      const id = String(args.id ?? "");
      const bg = bgProcesses.get(id);
      if (!bg) return { ok: false, output: `No background process with id '${id}'.` };
      if (bg.exited) {
        bgProcesses.delete(id);
        return { ok: true, output: `Process ${id} had already exited.` };
      }
      bg.exited = true;
      try {
        terminateProcessTree(bg.proc);
      } catch (e: unknown) {
        return { ok: false, output: `Failed to kill process ${id}: ${(e as Error).message}` };
      }
      bgProcesses.delete(id);
      return { ok: true, output: `Killed background process ${id} (${bg.command}).` };
    },
  },
  "lsp": {
    fn: async (args, ctx) => {
      if (!ctx.problems) return { ok: false, output: "LSP problems not available in this environment." };
      const p = args.path ? String(args.path) : "";
      if (p && !ctx.problemsFor) return { ok: false, output: "LSP problems for a single file are not available." };
      const list = p ? await ctx.problemsFor!(p) : await ctx.problems();
      if (list.length === 0) return { ok: true, output: p ? `No problems in ${p}.` : "No problems in the workspace." };
      return { ok: true, output: list.map((d) => `[${d.severity}] ${d.file}:${d.line}:${d.column}  ${d.message}${d.source && !p ? `  (${d.source})` : ""}`).join("\n") };
    },
  },
  "todo.write": {
    fn: async (args) => {
      const raw = Array.isArray(args.items) ? (args.items as { id: unknown; text: unknown; state: unknown }[]) : [];
      const items = raw.filter((it) => it && typeof it === "object").map((it) => ({ id: String(it.id ?? ""), text: String(it.text ?? ""), state: normalizeTodoState(it.state) }));
      return { ok: true, output: `Todo list updated (${items.length} items).`, todoState: { items } };
    },
  },
  "browser.navigate": { description: "Navigate the browser. Args: { url, tabId? }", fn: (a, ctx) => withBrowser(ctx, (b) => b.navigate(String(a.url), a.tabId ? String(a.tabId) : undefined)) },
  "browser.click": { description: "Click a selector. Args: { selector, tabId? }", fn: (a, ctx) => withBrowser(ctx, (b) => b.click(String(a.selector), a.tabId ? String(a.tabId) : undefined)) },
  "browser.type": { description: "Type into a selector. Args: { selector, text, tabId? }", fn: (a, ctx) => withBrowser(ctx, (b) => b.type(String(a.selector), String(a.text), a.tabId ? String(a.tabId) : undefined)) },
  "browser.screenshot": { description: "Take a screenshot. Args: { path?, fullPage?, type?, tabId? }", fn: (a, ctx) => withBrowser(ctx, (b) => b.screenshot(a.path ? String(a.path) : undefined, !!a.fullPage, (a.type === "jpeg" ? "jpeg" : "png"), a.tabId ? String(a.tabId) : undefined)) },
  "browser.evaluate": { description: "Run JS in the page. Args: { script, tabId? }", fn: (a, ctx) => withBrowser(ctx, (b) => b.evaluate(String(a.script), a.tabId ? String(a.tabId) : undefined)) },
  "browser.readDom": { description: "Read the page's accessibility tree. Args: { tabId? }", fn: (a, ctx) => withBrowser(ctx, (b) => b.readDom(a.tabId ? String(a.tabId) : undefined)) },
  "browser.close": { description: "Close the browser. Args: {}", fn: (_a, ctx) => withBrowser(ctx, async (b) => { await b.close(); return { ok: true, output: "Browser closed." }; }) },
  "browser.tab": {
    fn: async (args, ctx) => {
      const action = String(args.action ?? "list");
      if (action === "new") return withBrowser(ctx, (b) => b.newTab(args.url ? String(args.url) : undefined));
      if (action === "switch") {
        if (!args.tabId) return { ok: false, output: "browser.tab switch requires a `tabId`." };
        return withBrowser(ctx, (b) => b.switchTab(String(args.tabId)));
      }
      if (action === "close") {
        if (!args.tabId) return { ok: false, output: "browser.tab close requires a `tabId`." };
        return withBrowser(ctx, (b) => b.closeTab(String(args.tabId)));
      }
      if (action !== "list") return { ok: false, output: "browser.tab requires an `action` of list, new, switch, or close." };
      return withBrowser(ctx, (b) => b.listTabs());
    },
  },
  "browser.intercept": { description: "Intercept requests matching a URL glob pattern. Args: { pattern, status?, body?, contentType?, block? }", fn: (a, ctx) => withBrowser(ctx, (b) => { const pattern = String(a.pattern ?? ""); if (!pattern) return { ok: false, output: "No pattern provided." }; return b.intercept(pattern, { status: a.status ? Number(a.status) : undefined, body: a.body ? String(a.body) : undefined, contentType: a.contentType ? String(a.contentType) : undefined, block: !!a.block }); }) },
  "browser.unintercept": { description: "Stop intercepting a previously registered pattern. Args: { pattern }", fn: (a, ctx) => withBrowser(ctx, (b) => b.unintercept(String(a.pattern ?? ""))) },
  "web.fetch": {
    fn: async (args, ctx) => {
      try {
        const url = String(args.url);
        const webProxy = ctx.proxyWeb || ctx.proxyUrl;
        const res = await safeFetch(url, {
          signal: AbortSignal.timeout(15000),
          ...(webProxy ? { dispatcher: makeProxyDispatcher(webProxy) } : {}),
        } as RequestInit);
        if (!res.ok) return { ok: false, output: `HTTP ${res.status}: ${res.statusText}` };
        const text = await readBodyLimited(res);
        return { ok: true, output: text };
      } catch (e: unknown) {
        return { ok: false, output: `Fetch failed: ${(e as Error).message}` };
      }
    },
  },
  "web.search": {
    fn: async (args, ctx) => {
      try {
        const rawQuery = String(args.query ?? "").trim();
        if (!rawQuery) return { ok: false, output: "No query provided." };
        const n = Number(args.count);
        const count = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 20) : 10;
        const dispatcher = ctx.proxyWeb || ctx.proxyUrl ? makeProxyDispatcher(ctx.proxyWeb || ctx.proxyUrl!) : undefined;
        const backend = normalizeWebSearchBackend(ctx.webSearchBackend);
        if (backend !== "builtin") {
          const apiKey = (ctx.webSearchApiKey ?? "").trim();
          if (!apiKey) {
            const meta = WEB_SEARCH_BACKEND_LABELS[backend];
            return { ok: false, output: `No API key configured for ${meta.label}. Add one in Arc settings under Tools > Web search, or switch the backend back to Built-in.` };
          }
          try {
            const apiResults = await searchWithApiBackend(backend, rawQuery, count, { apiKey, signal: ctx.signal, dispatcher });
            if (apiResults.length > 0) {
              return { ok: true, output: apiResults.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`).join("\n\n") };
            }
          } catch {
            const fallback = await searchWeb(rawQuery, count, dispatcher, ctx.signal);
            if (fallback.length > 0) {
              return { ok: true, output: fallback.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`).join("\n\n") };
            }
            return { ok: false, output: `Search failed: ${WEB_SEARCH_BACKEND_LABELS[backend].label} returned an error and the built-in fallback found nothing. Check the API key in Arc settings under Tools > Web search, or retry shortly.` };
          }
        }
        const results = await searchWeb(rawQuery, count, dispatcher, ctx.signal);
        const out = results.length > 0
          ? results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`).join("\n\n")
          : "No results found (search backends may be rate-limiting). Try a more specific query or retry shortly.";
        return { ok: true, output: out };
      } catch (e: unknown) {
        return { ok: false, output: `Search failed: ${(e as Error).message}` };
      }
    },
  },
  "syms.context": {
    fn: async (args, ctx) => {
      const query = String(args.query ?? "").trim().slice(0, 2000);
      if (!query) return { ok: false, output: "No query provided." };
      const rawNodes = Number(args.maxNodes);
      if (args.maxNodes !== undefined && (!Number.isFinite(rawNodes) || Math.floor(rawNodes) < 1)) {
        return { ok: false, output: "maxNodes must be an integer between 1 and 60." };
      }
      const maxNodes = args.maxNodes === undefined ? 20 : Math.min(Math.floor(rawNodes), 60);
      const positiveInt = (v: unknown, def: number, cap: number): number => {
        const x = Number(v);
        return Number.isFinite(x) && Math.floor(x) >= 1 ? Math.min(Math.floor(x), cap) : def;
      };
      const maxCodeBlocks = positiveInt(args.maxCodeBlocks, 5, 50);
      const maxCodeLines = positiveInt(args.maxCodeLines, 120, 1000);
      const includeCode = args.includeCode === undefined ? true : !!args.includeCode;
      try {
        const { scanWorkspaceSymbols } = await import("../syms/scan.js");
        const { buildCodeContext, formatCodeContext } = await import("../syms/context.js");
        const { CODE_EXTENSIONS } = await import("../syms/extract.js");
        const { resolveAuthorizedPath } = await import("../security/path-policy.js");
        const { readFile } = await import("node:fs/promises");
        const { symbols, filesScanned } = await scanWorkspaceSymbols(ctx.root, { maxFiles: Math.max(500, maxNodes * 25) });
        if (symbols.length === 0) return { ok: true, output: `No code symbols indexed (${filesScanned} files scanned).` };
        const shape = buildCodeContext(query, symbols, () => undefined, { maxNodes, includeCode: false, maxCodeBlocks, maxCodeLines });
        const texts = new Map<string, string>();
        let budgeted = 0;
        const queue = shape.filesTouched.slice(0, 60);
        const readOne = async (rel: string): Promise<void> => {
          if (budgeted >= 2 * 1024 * 1024) return;
          let full: string;
          try {
            full = resolveAuthorizedPath(ctx.root, rel, !!ctx.allowExternalPath);
          } catch {
            return;
          }
          try {
            const buf = await readFile(full);
            if (buf.length > 1024 * 1024 || buf.includes(0)) return;
            budgeted += buf.length;
            texts.set(rel, buf.toString("utf-8"));
          } catch {}
        };
        for (let i = 0; i < queue.length; i += 32) {
          await Promise.all(queue.slice(i, i + 32).map(readOne));
        }
        const cctx = includeCode
          ? buildCodeContext(query, symbols, (f) => texts.get(f), { maxNodes, includeCode: true, maxCodeBlocks, maxCodeLines })
          : shape;
        const scope = [...CODE_EXTENSIONS].sort().join(" ");
        let output = `${formatCodeContext(cctx)}\n\n(${filesScanned} files scanned, ${symbols.length} symbols; scope: ${scope})`;
        if (output.length > 24_000) {
          output = output.slice(0, 24_000);
          if ((output.match(/```/g) ?? []).length % 2 === 1) output += "\n```";
          output += `\n...(truncated, ${filesScanned} files scanned, ${symbols.length} symbols)`;
        }
        const touched = [...new Set([...cctx.blocks.map((b) => b.file), ...cctx.entryPoints.map((e) => e.file)])].slice(0, 20);
        return { ok: true, output, touchedFiles: touched };
      } catch (e: unknown) {
        return { ok: false, output: `Code context failed: ${(e as Error).message}` };
      }
    },
  },
  "mcp.call": {
    fn: async (a, ctx) => {
      if (!ctx.mcp) return { ok: false, output: "MCP not available." };
      const r = await ctx.mcp.call(String(a.server), String(a.tool), (a.args as Record<string, unknown>) ?? {});
      return { ok: r.ok, output: typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2) };
    },
  },
  "mcp.create": {
    fn: async (a, ctx) => {
      if (!ctx.mcp) return { ok: false, output: "MCP not available." };
      const name = String(a.name ?? "").trim();
      if (!name) return { ok: false, output: "Server name is required." };
      const transport = a.transport as { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> } | undefined;
      if (!transport || !transport.type) return { ok: false, output: "transport.type is required ('stdio' or 'http')." };
      let normalized: import("../mcp/client.js").McpTransport;
      if (transport.type === "stdio") {
        const cmd = String(transport.command ?? "").trim();
        if (!cmd) return { ok: false, output: "stdio transport requires 'command'." };
        normalized = { type: "stdio", command: cmd, args: Array.isArray(transport.args) ? transport.args.map(String) : undefined, env: transport.env };
      } else if (transport.type === "http") {
        const url = String(transport.url ?? "").trim();
        if (!url) return { ok: false, output: "http transport requires 'url'." };
        normalized = { type: "http", url, headers: transport.headers };
      } else {
        return { ok: false, output: `Unknown transport type '${transport.type}'.` };
      }
      const enabled = a.enabled === undefined ? true : !!a.enabled;
      try {
        await ctx.mcp.addServer({ name, enabled, transport: normalized });
        const srv = ctx.mcp.listServers().find((s) => s.name === name);
        const toolList = (srv?.tools ?? []).map((t) => `${t.name}${t.description ? ` - ${t.description}` : ""}`).join("\n");
        return {
          ok: true,
          output: `Registered MCP server '${name}' (${normalized.type}). Tools:\n${toolList || "(none discovered yet)"}`,
        };
      } catch (e) {
        return { ok: false, output: `Failed to register server: ${(e as Error).message}` };
      }
    },
  },
  "mcp.remove": {
    fn: async (a, ctx) => {
      if (!ctx.mcp) return { ok: false, output: "MCP not available." };
      const name = String(a.name ?? "");
      await ctx.mcp.removeServer(name);
      return { ok: true, output: `Removed MCP server '${name}'.` };
    },
  },
  "mcp.toggle": {
    fn: async (a, ctx) => {
      if (!ctx.mcp) return { ok: false, output: "MCP not available." };
      const name = String(a.name ?? "");
      const enabled = !!a.enabled;
      await ctx.mcp.enableServer(name, enabled);
      return { ok: true, output: `MCP server '${name}' ${enabled ? "enabled" : "disabled"}.` };
    },
  },
  "mcp.resources/list": {
    fn: async (a, ctx) => {
      if (!ctx.mcp) return { ok: false, output: "MCP not available." };
      const server = String(a.server ?? "");
      const list = ctx.mcp.listResources().filter((r) => r.server === server);
      if (list.length === 0) return { ok: true, output: `No resources on server '${server}'.` };
      return { ok: true, output: list.map((r) => `${r.uri}${r.name ? ` - ${r.name}` : ""}${r.mimeType ? ` (${r.mimeType})` : ""}`).join("\n") };
    },
  },
  "mcp.resources/read": {
    fn: async (a, ctx) => {
      if (!ctx.mcp) return { ok: false, output: "MCP not available." };
      const r = await ctx.mcp.readResource(String(a.server), String(a.uri));
      return { ok: r.ok, output: typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2) ?? String(r.output) };
    },
  },
  "mcp.prompts/list": {
    fn: async (a, ctx) => {
      if (!ctx.mcp) return { ok: false, output: "MCP not available." };
      const server = String(a.server ?? "");
      const list = ctx.mcp.listPrompts().filter((p) => p.server === server);
      if (list.length === 0) return { ok: true, output: `No prompts on server '${server}'.` };
      return { ok: true, output: list.map((p) => `${p.name}${p.description ? ` - ${p.description}` : ""}`).join("\n") };
    },
  },
  "mcp.prompts/get": {
    fn: async (a, ctx) => {
      if (!ctx.mcp) return { ok: false, output: "MCP not available." };
      const r = await ctx.mcp.getPrompt(String(a.server), String(a.name), (a.args as Record<string, unknown>) ?? undefined);
      return { ok: r.ok, output: typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2) ?? String(r.output) };
    },
  },
  "hooks.list": {
    fn: async (_args, ctx) => {
      const f = await readHooksFile(ctx.workspacePath);
      if (!f.hooks.length) return { ok: true, output: "No hooks configured in the workspace hooks file." };
      return { ok: true, output: f.hooks.map((h, i) => describeHook(h, i)).join("\n") };
    },
  },
  "hooks.create": {
    fn: async (args, ctx) => {
      const check = normalizeHook(args);
      if (check.error) return { ok: false, output: check.error };
      const f = await readHooksFile(ctx.workspacePath);
      f.hooks.push(check.hook!);
      await writeHooksFile(f);
      return { ok: true, output: `Hook created (index ${f.hooks.length - 1}). It applies to new sessions.` };
    },
  },
  "hooks.update": {
    fn: async (args, ctx) => {
      const f = await readHooksFile(ctx.workspacePath);
      const index = Number(args.index);
      if (!Number.isInteger(index) || index < 0 || index >= f.hooks.length) return { ok: false, output: `Invalid index ${args.index}. Use hooks.list to see valid entries.` };
      const check = normalizeHook(args, f.hooks[index]);
      if (check.error) return { ok: false, output: check.error };
      f.hooks[index] = check.hook!;
      await writeHooksFile(f);
      return { ok: true, output: `Hook ${index} updated. It applies to new sessions.` };
    },
  },
  "hooks.delete": {
    fn: async (args, ctx) => {
      const f = await readHooksFile(ctx.workspacePath);
      const index = Number(args.index);
      if (!Number.isInteger(index) || index < 0 || index >= f.hooks.length) return { ok: false, output: `Invalid index ${args.index}. Use hooks.list to see valid entries.` };
      const [removed] = f.hooks.splice(index, 1);
      await writeHooksFile(f);
      return { ok: true, output: `Deleted hook ${index} (${String((removed as { event?: string }).event ?? "unknown")}).` };
    },
  },
  "browser.hover": {
    fn: (args, ctx) => withBrowser(ctx, (b) => b.hover(String(args.selector ?? ""), args.tabId ? String(args.tabId) : undefined)),
  },
  "browser.scroll": {
    fn: (args, ctx) => withBrowser(ctx, (b) => b.scroll(args.pixels ? Number(args.pixels) : undefined, args.selector ? String(args.selector) : undefined, args.tabId ? String(args.tabId) : undefined)),
  },
  "browser.waitFor": {
    fn: (args, ctx) => withBrowser(ctx, (b) => b.waitFor(
      args.selector ? String(args.selector) : undefined,
      args.url ? String(args.url) : undefined,
      args.state ? String(args.state) as "networkidle" | "load" | "domcontentloaded" : undefined,
      args.tabId ? String(args.tabId) : undefined,
    )),
  },
  "browser.console": {
    fn: (args, ctx) => withBrowser(ctx, (b) => {
      const logs = b.consoleLog(args.tabId ? String(args.tabId) : undefined);
      return { ok: true, output: logs.length ? logs.join("\n") : "(no console output)" };
    }),
  },
  "browser.network": {
    fn: (args, ctx) => withBrowser(ctx, (b) => {
      const logs = b.networkLog(args.tabId ? String(args.tabId) : undefined);
      return { ok: true, output: logs.length ? logs.join("\n") : "(no network requests)" };
    }),
  },
  "browser.domSnapshot": {
    fn: (args, ctx) => withBrowser(ctx, (b) => ({ ok: true, output: b.domSnapshot(args.tabId ? String(args.tabId) : undefined) || "(empty snapshot)" })),
  },
  "browser.drag": {
    fn: (a, ctx) => withBrowser(ctx, (b) => b.drag(String(a.from), String(a.to), a.tabId ? String(a.tabId) : undefined)),
  },
  "browser.dialog": {
    fn: (a, ctx) => withBrowser(ctx, (b) => b.dialog(a.accept !== false, a.promptText ? String(a.promptText) : undefined)),
  },
  "browser.runCode": {
    fn: (a, ctx) => withBrowser(ctx, (b) => b.runCode(String(a.code), a.tabId ? String(a.tabId) : undefined)),
  },
  "browser.readPage": {
    fn: (a, ctx) => withBrowser(ctx, (b) => b.readPage(a.tabId ? String(a.tabId) : undefined)),
  },
  "notebook.read": {
    fn: async (args, ctx) => {
      const filePath = String(args.path);
      const ed = new FileEditor(ctx.root, !!ctx.allowExternalPath);
      let raw: string;
      try {
        raw = await ed.read(filePath);
      } catch (e: unknown) {
        return { ok: false, output: `Failed to read ${filePath}: ${(e as Error).message}` };
      }
      let doc;
      try {
        doc = parseNotebook(raw);
      } catch (e: unknown) {
        return { ok: false, output: (e as Error).message };
      }
      const cellIndex = args.cellIndex !== undefined ? Number(args.cellIndex) : undefined;
      if (cellIndex === undefined) {
        const cells = listCells(doc);
        if (!cells.length) return { ok: true, output: "(empty notebook)" };
        const out = cells.map((c) => `[${c.index}] (${c.cellType}${c.hasOutput ? ", has output" : ""}) ${c.preview.replace(/\n/g, " ")}`).join("\n");
        return { ok: true, output: out };
      }
      try {
        const cell = readCell(doc, cellIndex);
        const outputText = cell.output
          ? `\n\n--- Output ---\n${cell.output.text || "(no text output)"}${cell.output.images.length ? `\n(${cell.output.images.length} image output(s); use notebook.execute to regenerate them)` : ""}`
          : "";
        return { ok: true, output: `[${cell.index}] (${cell.cellType})\n${cell.source}${outputText}` };
      } catch (e: unknown) {
        return { ok: false, output: (e as Error).message };
      }
    },
  },
  "notebook.editCell": {
    fn: async (args, ctx) => {
      const filePath = String(args.path);
      const cellIndex = Number(args.cellIndex);
      const source = String(args.source ?? "");
      const ed = new FileEditor(ctx.root, !!ctx.allowExternalPath);
      let raw: string;
      try {
        raw = await ed.read(filePath);
      } catch (e: unknown) {
        return { ok: false, output: `Failed to read ${filePath}: ${(e as Error).message}` };
      }
      let doc;
      try {
        doc = parseNotebook(raw);
      } catch (e: unknown) {
        return { ok: false, output: (e as Error).message };
      }
      let updated;
      try {
        updated = editCellSource(doc, cellIndex, source);
      } catch (e: unknown) {
        return { ok: false, output: (e as Error).message };
      }
      const full = ed.resolve(filePath);
      const serialized = serializeNotebook(updated);
      try { await enforcePreWrite(filePath, serialized, ctx); } catch (error) { return { ok: false, output: (error as Error).message }; }
      await fs.writeFile(full, serialized, "utf-8");
      void runPostEditHooks(filePath, ctx.root, ctx.sandboxProfile);
      return { ok: true, output: `Updated cell ${cellIndex} in ${filePath}`, touchedFiles: [filePath], filePath };
    },
  },
  "notebook.addCell": {
    fn: async (args, ctx) => {
      const filePath = String(args.path);
      const index = Number(args.index);
      const cellType = String(args.cellType ?? "code") as "code" | "markdown" | "raw";
      const source = String(args.source ?? "");
      const ed = new FileEditor(ctx.root, !!ctx.allowExternalPath);
      let raw: string;
      try {
        raw = await ed.read(filePath);
      } catch (e: unknown) {
        return { ok: false, output: `Failed to read ${filePath}: ${(e as Error).message}` };
      }
      let doc;
      try {
        doc = parseNotebook(raw);
      } catch (e: unknown) {
        return { ok: false, output: (e as Error).message };
      }
      const updated = addCell(doc, index, cellType, source);
      const full = ed.resolve(filePath);
      const serialized = serializeNotebook(updated);
      try { await enforcePreWrite(filePath, serialized, ctx); } catch (error) { return { ok: false, output: (error as Error).message }; }
      await fs.writeFile(full, serialized, "utf-8");
      void runPostEditHooks(filePath, ctx.root, ctx.sandboxProfile);
      return { ok: true, output: `Inserted a new ${cellType} cell at index ${index} in ${filePath}`, touchedFiles: [filePath], filePath };
    },
  },
  "notebook.deleteCell": {
    fn: async (args, ctx) => {
      const filePath = String(args.path);
      const cellIndex = Number(args.cellIndex);
      const ed = new FileEditor(ctx.root, !!ctx.allowExternalPath);
      let raw: string;
      try {
        raw = await ed.read(filePath);
      } catch (e: unknown) {
        return { ok: false, output: `Failed to read ${filePath}: ${(e as Error).message}` };
      }
      let doc;
      try {
        doc = parseNotebook(raw);
      } catch (e: unknown) {
        return { ok: false, output: (e as Error).message };
      }
      let updated;
      try {
        updated = deleteCell(doc, cellIndex);
      } catch (e: unknown) {
        return { ok: false, output: (e as Error).message };
      }
      const full = ed.resolve(filePath);
      const serialized = serializeNotebook(updated);
      try { await enforcePreWrite(filePath, serialized, ctx); } catch (error) { return { ok: false, output: (error as Error).message }; }
      await fs.writeFile(full, serialized, "utf-8");
      void runPostEditHooks(filePath, ctx.root, ctx.sandboxProfile);
      return { ok: true, output: `Deleted cell ${cellIndex} from ${filePath}`, touchedFiles: [filePath], filePath };
    },
  },
  "notebook.execute": {
    fn: async (args, ctx) => {
      if (!ctx.executeNotebookCell) return { ok: false, output: "Notebook execution is not available in this environment." };
      const filePath = String(args.path);
      const cellIndex = Number(args.cellIndex);
      const r = await ctx.executeNotebookCell(filePath, cellIndex);
      return { ok: r.ok, output: r.output, touchedFiles: r.ok ? [filePath] : [], filePath };
    },
  },
  "context.retrieve": {
    fn: async (args, ctx) => {
      const { loadBlob } = await import("../compress/store.js");
      const id = String(args.id ?? "").trim();
      if (!id) return { ok: false, output: "context.retrieve requires an `id`." };
      const now = Date.now();
      const budget = retrieveBudgets.get(ctx.root);
      if (!budget || now - budget.since > 3_600_000) {
        retrieveBudgets.set(ctx.root, { count: 0, bytes: 0, since: now });
        if (retrieveBudgets.size > 200) retrieveBudgets.delete(retrieveBudgets.keys().next().value as string);
      }
      const b = retrieveBudgets.get(ctx.root)!;
      if (b.count >= 20 || b.bytes >= 4 * 1024 * 1024) {
        return { ok: false, output: "context.retrieve budget exhausted for this workspace (20 retrieves or 4MB per hour). Re-read the files directly instead." };
      }
      const blob = await loadBlob(ctx.root, id);
      if (blob === undefined) return { ok: false, output: `No stored context found for id '${id}'.` };
      b.count++;
      b.bytes += blob.totalBytes;
      const capped = blob.content.length > 128 * 1024 ? `${blob.content.slice(0, 128 * 1024)}\n...(truncated ${blob.content.length - 128 * 1024} chars; re-read the file for the rest)` : blob.content;
      const suffix = blob.truncated ? `\n...(stored output truncated: showing first ${blob.content.length} of ${blob.totalBytes} bytes)` : "";
      return { ok: true, output: `${capped}${suffix}` };
    },
  },
};
const retrieveBudgets = new Map<string, { count: number; bytes: number; since: number }>();
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<"timeout" | "abort"> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve("abort"); return; }
    const onAbort = () => { clearTimeout(timer); resolve("abort"); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve("timeout"); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
interface SearchResult { title: string; snippet: string; url: string; }
const STEALTH_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Priority": "u=0, i",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Sec-GPC": "1",
  "Upgrade-Insecure-Requests": "1",
};
const CAPTCHA_MARKERS = ["anomaly-modal", "not a robot", "g-recaptcha", "challenge-form", "not a bot", "cf-challenge", "turnstile"];
const SEARCH_SOURCE_TIMEOUT_MS = 10_000;
function searchSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function searchRetryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter.trim());
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 5000);
  }
  return Math.min(800 * 2 ** attempt, 5000) + Math.floor(Math.random() * 300);
}
function searchSignal(outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SEARCH_SOURCE_TIMEOUT_MS);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}
async function fetchSearchSource(url: string, init: RequestInit, proxyDispatcher: unknown, outerSignal?: AbortSignal): Promise<Response> {
  let lastErr: unknown;
  let retryAfter: string | null = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    if (attempt > 0) await searchSleep(searchRetryDelayMs(attempt - 1, retryAfter));
    try {
      const res = await fetch(url, {
        ...init,
        signal: searchSignal(outerSignal),
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      } as RequestInit);
      if (res.ok) return res;
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        retryAfter = res.headers?.get?.("retry-after") ?? null;
        await res.body?.cancel().catch(() => undefined);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      if ((e as Error)?.name === "AbortError" && outerSignal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("search request failed");
}
type SearchSource = (query: string, max: number, proxyDispatcher: unknown, outerSignal?: AbortSignal) => Promise<SearchResult[]>;
async function searchWeb(query: string, max: number, proxyDispatcher: unknown, outerSignal?: AbortSignal): Promise<SearchResult[]> {
  const sources: SearchSource[] = [ddgSearchHtml, ddgMainSearch, yahooSearch, hnSearch, wikiSearch];
  for (const src of sources) {
    let results: SearchResult[] = [];
    try {
      results = await src(query, max, proxyDispatcher, outerSignal);
    } catch {
      results = [];
    }
    if (results.length > 0) return dedupeSearchResults(results).slice(0, max);
  }
  return [];
}
async function ddgSearchHtml(query: string, max: number, proxyDispatcher: unknown, outerSignal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({ q: query });
    const res = await fetchSearchSource(`https://html.duckduckgo.com/html/?${params.toString()}`, {
      headers: STEALTH_HEADERS,
    }, proxyDispatcher, outerSignal);
    if (!res.ok) return [];
    const html = await readBodyLimited(res);
    if (hasCaptcha(html)) return [];
    return parseHtmlResults(html, max);
  } catch {
    return [];
  }
}
async function ddgMainSearch(query: string, max: number, proxyDispatcher: unknown, outerSignal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({ q: query });
    const res = await fetchSearchSource(`https://duckduckgo.com/html/?${params.toString()}`, {
      headers: STEALTH_HEADERS,
    }, proxyDispatcher, outerSignal);
    if (!res.ok) return [];
    const html = await readBodyLimited(res);
    if (hasCaptcha(html)) return [];
    return parseHtmlResults(html, max);
  } catch {
    return [];
  }
}
async function yahooSearch(query: string, max: number, proxyDispatcher: unknown, outerSignal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({ p: query, n: String(Math.min(Math.max(max, 1), 20)) });
    const res = await fetchSearchSource(`https://search.yahoo.com/search?${params.toString()}`, {
      headers: STEALTH_HEADERS,
    }, proxyDispatcher, outerSignal);
    if (!res.ok) return [];
    const html = await readBodyLimited(res);
    return parseYahooResults(html, max);
  } catch {
    return [];
  }
}
async function hnSearch(query: string, max: number, proxyDispatcher: unknown, outerSignal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({ query, tags: "story" });
    const res = await fetchSearchSource(`https://hn.algolia.com/api/v1/search?${params.toString()}`, {
      headers: { ...STEALTH_HEADERS, Accept: "application/json" },
    }, proxyDispatcher, outerSignal);
    if (!res.ok) return [];
    const text = await readBodyLimited(res);
    return parseHnResults(JSON.parse(text), max);
  } catch {
    return [];
  }
}
async function wikiSearch(query: string, max: number, proxyDispatcher: unknown, outerSignal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({ action: "opensearch", search: query, limit: String(max), namespace: "0", format: "json" });
    const res = await fetchSearchSource(`https://en.wikipedia.org/w/api.php?${params.toString()}`, {
      headers: { ...STEALTH_HEADERS, Accept: "application/json" },
    }, proxyDispatcher, outerSignal);
    if (!res.ok) return [];
    const text = await readBodyLimited(res);
    return parseWikiResults(JSON.parse(text), max);
  } catch {
    return [];
  }
}
function hasCaptcha(html: string): boolean {
  return CAPTCHA_MARKERS.some((m) => html.toLowerCase().includes(m));
}
function extractUddgUrl(raw: string): string {
  const m = /uddg=([^"&]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]) : raw;
}
export function decodeHtml(s: string): string {
  const input = s.length > 500_000 ? s.slice(0, 500_000) : s;
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_m, d: string) => {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch {
        return "";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}
function searchHref(attrs: string): string | undefined {
  const m = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
  return m ? m[1] : undefined;
}
function isUsableResultUrl(url: string): boolean {
  return /^https?:\/\/[^/]+\.[^/]+/i.test(url);
}
const MAX_PARSE_HTML_CHARS = 2_000_000;
function boundParseHtml(html: string): string {
  return html.length > MAX_PARSE_HTML_CHARS ? html.slice(0, MAX_PARSE_HTML_CHARS) : html;
}
export function parseHtmlResults(html: string, max: number): SearchResult[] {
  html = boundParseHtml(html);
  if (hasCaptcha(html)) return [];
  const links: { href: string; title: string }[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && links.length < max) {
    const attrs = m[1] ?? "";
    if (!/result__a/i.test(attrs)) continue;
    const rawHref = searchHref(attrs);
    if (!rawHref) continue;
    const url = extractUddgUrl(rawHref);
    if (!isUsableResultUrl(url)) continue;
    const title = decodeHtml(m[2] ?? "");
    if (title) links.push({ href: url, title });
  }
  if (links.length === 0) return [];
  const snippets: string[] = [];
  const snippetRe = /<a\b[^>]*class\s*=\s*["']?result__snippet["']?[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = snippetRe.exec(html)) !== null) snippets.push(decodeHtml(m[1] ?? ""));
  return dedupeSearchResults(links.map((l, i) => ({ title: l.title, snippet: i < snippets.length ? snippets[i] : "", url: l.href })));
}
function extractYahooTarget(href: string): string | undefined {
  const m = /\/RU=([^/]+)\//.exec(href);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}
export function parseYahooResults(html: string, max: number): SearchResult[] {
  html = boundParseHtml(html);
  const links: { href: string; title: string }[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && links.length < max) {
    const rawHref = searchHref(m[1] ?? "");
    if (!rawHref || !rawHref.includes("/RU=")) continue;
    const url = extractYahooTarget(rawHref);
    if (!url || !isUsableResultUrl(url)) continue;
    const inner = m[2] ?? "";
    const h3 = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(inner);
    const title = decodeHtml(h3 ? h3[1] ?? "" : inner);
    if (title) links.push({ href: url, title });
  }
  if (links.length === 0) return [];
  const snippets: string[] = [];
  const snippetRe = /<div\b[^>]*class="compText[^"]*"[^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = snippetRe.exec(html)) !== null) snippets.push(decodeHtml(m[1] ?? ""));
  return dedupeSearchResults(links.map((l, i) => ({ title: l.title, snippet: i < snippets.length ? snippets[i] : "", url: l.href })));
}
export function parseHnResults(json: unknown, max: number): SearchResult[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const hits = (json as Record<string, unknown>).hits;
  if (!Array.isArray(hits)) return [];
  const results: SearchResult[] = [];
  for (const item of hits) {
    if (results.length >= max) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const hit = item as Record<string, unknown>;
    const title = typeof hit.title === "string" && hit.title.trim()
      ? hit.title.trim()
      : typeof hit.story_title === "string" && hit.story_title.trim()
        ? (hit.story_title as string).trim()
        : "";
    const url = typeof hit.url === "string" && isUsableResultUrl(hit.url)
      ? hit.url
      : typeof hit.objectID === "string" || typeof hit.objectID === "number"
        ? `https://news.ycombinator.com/item?id=${hit.objectID}`
        : "";
    if (!title || !url) continue;
    const storyText = typeof hit.story_text === "string" ? hit.story_text.trim().replace(/\s+/g, " ") : "";
    const byline = typeof hit.author === "string" && hit.author
      ? `${typeof hit.points === "number" ? `${hit.points} points by ` : "by "}${hit.author}`
      : "";
    const snippet = storyText ? storyText.slice(0, 300) : byline;
    results.push({ title, snippet, url });
  }
  return dedupeSearchResults(results);
}
export function parseWikiResults(json: unknown, max: number): SearchResult[] {
  if (!Array.isArray(json) || json.length < 4) return [];
  const titles = Array.isArray(json[1]) ? (json[1] as unknown[]) : [];
  const descs = Array.isArray(json[2]) ? (json[2] as unknown[]) : [];
  const urls = Array.isArray(json[3]) ? (json[3] as unknown[]) : [];
  const results: SearchResult[] = [];
  for (let i = 0; i < Math.min(titles.length, urls.length, max); i++) {
    const title = typeof titles[i] === "string" ? (titles[i] as string) : "";
    const url = typeof urls[i] === "string" ? (urls[i] as string) : "";
    const snippet = typeof descs[i] === "string" ? (descs[i] as string) : "";
    if (title && isUsableResultUrl(url)) results.push({ title, snippet, url });
  }
  return dedupeSearchResults(results);
}
export function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = normalizeSearchUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
function normalizeSearchUrl(u: string): string {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, "")}${p.search}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}