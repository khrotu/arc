import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getArcDir, getWorkspaceArcDir } from "../arc-dir.js";
import { minimalEnvironment, PROCESS_OUTPUT_LIMIT, runShellCommand } from "../util/process.js";
import { globToRegExpSource } from "../util/glob.js";
import type { SandboxProfile } from "../sandbox/sandbox.js";
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ""); }
export type HookEvent =
  | "session.start"
  | "user.submit"
  | "pre.tool"
  | "post.tool"
  | "pre.compact"
  | "post.compact"
  | "pre.handoff"
  | "notification"
  | "stop"
  | "subagent.spawn"
  | "instructions.loaded";
export interface HookMatcher {
  tool?: string;
  mode?: string;
  modelTier?: string;
}
export interface HookEntry {
  event: HookEvent;
  command: string;
  command_windows?: string;
  timeout_sec?: number;
  matchers?: HookMatcher;
}
export interface HookConfig {
  hooks?: HookEntry[];
  preWrite?: PreWriteHook[];
  postEdit?: PostEditHook[];
}
export interface PreWriteHook {
  type: "secret-scan" | "custom";
  pattern?: string;
  message?: string;
  command?: string;
}
export interface PostEditHook {
  type: "command";
  command: string;
  glob?: string;
  label: string;
}
export interface HookResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
export interface HookEventContext {
  event: HookEvent;
  tool?: string;
  args?: Record<string, unknown>;
  workspaceRoot: string;
  mode?: string;
  modelTier?: string;
  userMessage?: string;
  extra?: Record<string, unknown>;
  sandboxProfile?: SandboxProfile;
}
export interface HookDecision {
  decision: "allow" | "deny" | "ask" | "block";
  modifiedArgs?: Record<string, unknown>;
  message?: string;
  contextMessage?: string;
}
let cachedConfig: HookConfig | undefined;
let cachedWorkspaceRoot: string | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;
async function loadHookConfig(workspaceRoot?: string): Promise<HookConfig> {
  if (workspaceRoot === cachedWorkspaceRoot && cachedConfig && Date.now() - cachedAt < CACHE_TTL_MS) return cachedConfig;
  const globalPath = path.join(getArcDir(), "hooks.json");
  const workspacePath = workspaceRoot ? path.join(getWorkspaceArcDir(workspaceRoot), "hooks.json") : null;
  const global: HookConfig = await loadJson(globalPath);
  const workspace: HookConfig = workspaceRoot ? await loadJson(workspacePath!) : {};
  cachedConfig = {
    hooks: [...(global.hooks ?? []), ...(workspace.hooks ?? [])],
    preWrite: [...(global.preWrite ?? []), ...(workspace.preWrite ?? [])],
    postEdit: [...(global.postEdit ?? []), ...(workspace.postEdit ?? [])],
  };
  cachedWorkspaceRoot = workspaceRoot;
  cachedAt = Date.now();
  return cachedConfig;
}
async function loadJson(p: string): Promise<HookConfig> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function matchHook(hook: HookEntry, ctx: HookEventContext): boolean {
  if (hook.event !== ctx.event) return false;
  const m = hook.matchers;
  if (!m) return true;
  if (m.tool && m.tool !== ctx.tool) return false;
  if (m.mode && m.mode !== ctx.mode) return false;
  if (m.modelTier && m.modelTier !== ctx.modelTier) return false;
  return true;
}
export async function runHooks(ctx: HookEventContext): Promise<HookDecision[]> {
  const cfg = await loadHookConfig(ctx.workspaceRoot);
  const decisions: HookDecision[] = [];
  for (const hook of cfg.hooks ?? []) {
    if (!matchHook(hook, ctx)) continue;
    const cmd = process.platform === "win32" && hook.command_windows ? hook.command_windows : hook.command;
    if (!cmd) continue;
    try {
      const result = await runShellCommand(cmd, {
        cwd: ctx.workspaceRoot,
        timeoutMs: (hook.timeout_sec ?? 10) * 1000,
        maxOutputBytes: PROCESS_OUTPUT_LIMIT,
        sandboxProfile: ctx.sandboxProfile,
        workspaceRoot: ctx.workspaceRoot,
        env: minimalEnvironment({ ARC_HOOK: JSON.stringify(ctx) }),
      });
      if (!result.ok) throw new Error(result.stderr || "hook failed");
      const stdout = result.stdout;
      const trimmed = stripAnsi(stdout).trim();
      if (!trimmed) continue;
      try {
        const d = JSON.parse(trimmed) as HookDecision;
        if (d.decision === "deny" || d.decision === "block") {
          decisions.push(d);
          return decisions;
        }
        if (d.decision === "ask" || (d.decision === "allow" && d.modifiedArgs) || d.contextMessage) decisions.push(d);
      } catch {
        decisions.push({ decision: "deny", message: `Hook ${hook.event} returned invalid JSON: ${trimmed.slice(0, 200)}` });
        return decisions;
      }
    } catch (error) {
      if (ctx.event === "pre.tool") decisions.push({ decision: "deny", message: `Pre-tool hook failed closed: ${(error as Error).message}` });
    }
  }
  return decisions;
}
export const SECRET_PATTERNS = [
  { pattern: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE\s+KEY-----/i, label: "private key" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key" },
  { pattern: /(?:sk|secret|password|token|apikey|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i, label: "hardcoded secret" },
  { pattern: /ghp_[0-9a-zA-Z]{36}/, label: "GitHub personal access token" },
  { pattern: /github_pat_[0-9a-zA-Z_]{36,}/, label: "GitHub fine-grained token" },
  { pattern: /sk-[a-zA-Z0-9]{32,}/, label: "OpenAI API key" },
  { pattern: /\bsk-proj-[a-zA-Z0-9_-]{20,}\b/, label: "OpenAI project API key" },
  { pattern: /sk-ant-[a-zA-Z0-9]{32,}/, label: "Anthropic API key" },
];
export async function runPreWriteHooks(filePath: string, content: string, workspaceRoot?: string, sandboxProfile?: SandboxProfile): Promise<HookResult> {
  const cfg = await loadHookConfig(workspaceRoot);
  const errors: string[] = [];
  const warnings: string[] = [];
  const hooks = cfg.preWrite ?? [];
  for (const candidate of SECRET_PATTERNS) {
    if (candidate.pattern.test(content)) errors.push(`Secret scan blocked a potential ${candidate.label} in ${filePath}`);
    candidate.pattern.lastIndex = 0;
  }
  for (const hook of hooks) {
    if (hook.type === "secret-scan" || (!hook.type && !hook.command)) {
      const patterns = hook.pattern
        ? [{ pattern: new RegExp(hook.pattern, "gm"), label: "custom pattern" }]
        : SECRET_PATTERNS;
      for (const p of patterns) {
        const matches = content.match(p.pattern);
        if (matches && matches.length > 0) {
          const msg = hook.message ?? `Secret scan blocked a potential ${p.label} in ${filePath}`;
          errors.push(msg);
        }
      }
    }
    if (hook.type === "custom" && hook.command) {
      try {
        const result = await runShellCommand(hook.command, {
          cwd: workspaceRoot ?? process.cwd(),
          timeoutMs: 10_000,
          maxOutputBytes: PROCESS_OUTPUT_LIMIT,
          sandboxProfile,
          workspaceRoot,
          env: minimalEnvironment({ ARC_FILE: filePath }),
          input: content,
        });
        const out = stripAnsi(result.stdout).trim();
        if (!result.ok) throw new Error(result.stderr || "pre-write hook failed");
        if (out) warnings.push(`Pre-write hook "${hook.command}": ${out.slice(0, 500)}`);
      } catch (e) {
        errors.push(`Pre-write hook "${hook.command}" failed: ${(e as Error).message}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
export async function runPostEditHooks(filePath: string, root: string, sandboxProfile?: SandboxProfile): Promise<HookResult> {
  const cfg = await loadHookConfig(root);
  const errors: string[] = [];
  const warnings: string[] = [];
  const hooks = cfg.postEdit ?? [];
  for (const hook of hooks) {
    if (hook.type !== "command" || !hook.command) continue;
    if (hook.glob) {
      const rel = path.relative(root, filePath).replace(/\\/g, "/");
      const globRe = new RegExp("^" + globToRegExpSource(hook.glob) + "$");
      if (!globRe.test(rel)) continue;
    }
    try {
      const cwd = path.dirname(filePath);
      const result = await runShellCommand(hook.command, { cwd, timeoutMs: 30_000, maxOutputBytes: PROCESS_OUTPUT_LIMIT, sandboxProfile, workspaceRoot: root, env: minimalEnvironment({ ARC_FILE: filePath }) });
      const out = stripAnsi(result.stdout).trim();
      const err = stripAnsi(result.stderr).trim();
      if (!result.ok && !err) throw new Error("post-edit hook failed");
      if (out) warnings.push(`[${hook.label}] ${out.slice(0, 500)}`);
      if (err) warnings.push(`[${hook.label}] ${err.slice(0, 500)}`);
    } catch (e) {
      warnings.push(`Post-edit hook "${hook.label}" failed: ${(e as Error).message}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}