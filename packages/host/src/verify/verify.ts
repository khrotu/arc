import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorkspaceArcDir } from "../arc-dir.js";
import { PROCESS_OUTPUT_LIMIT, runShellCommand } from "../util/process.js";
import type { SandboxProfile } from "../sandbox/sandbox.js";
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ""); }
export interface VerifyCommand { name: string; command: string; glob?: string }
export interface VerifyConfig { commands: VerifyCommand[]; maxRetries: number }
export interface VerifyCommandResult { name: string; ok: boolean; output: string }
export interface VerifyRunResult { ok: boolean; results: VerifyCommandResult[] }
export function parseVerifyToml(raw: string): VerifyConfig {
  const commands: VerifyCommand[] = [];
  let maxRetries = 3;
  let current: Partial<VerifyCommand> | undefined;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[commands]]") {
      if (current?.name && current.command) commands.push(current as VerifyCommand);
      current = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = parseTomlScalar(line.slice(eq + 1).trim());
    if (current) {
      if (key === "name") current.name = String(value);
      else if (key === "command") current.command = String(value);
      else if (key === "glob") current.glob = String(value);
    } else if (key === "maxRetries") {
      const n = Number(value);
      maxRetries = Number.isFinite(n) ? Math.max(0, Math.min(10, Math.floor(n))) : 3;
    }
  }
  if (current?.name && current.command) commands.push(current as VerifyCommand);
  return { commands, maxRetries };
}
function parseTomlScalar(raw: string): unknown {
  const decommented = stripInlineComment(raw).trim();
  if (decommented.startsWith('"') && decommented.endsWith('"') && decommented.length >= 2) return decommented.slice(1, -1);
  if (decommented.startsWith("'") && decommented.endsWith("'") && decommented.length >= 2) return decommented.slice(1, -1);
  if (decommented === "true") return true;
  if (decommented === "false") return false;
  if (/^-?\d+$/.test(decommented)) return Number(decommented);
  return decommented;
}
function stripInlineComment(raw: string): string {
  let inStr: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = undefined;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "#") return raw.slice(0, i);
  }
  return raw;
}
export async function loadVerifyConfig(workspaceRoot: string): Promise<VerifyConfig | undefined> {
  const filePath = path.join(getWorkspaceArcDir(workspaceRoot), "verify.toml");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return parseVerifyToml(raw);
  } catch {
    return undefined;
  }
}
export function matchesVerifyGlob(rel: string, glob: string): boolean {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "?") {
      re += "[^/]";
    } else if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re).test(rel);
}
export async function runVerification(workspaceRoot: string, config: VerifyConfig, changedFiles: string[], sandboxProfile?: SandboxProfile): Promise<VerifyRunResult> {
  const results: VerifyCommandResult[] = [];
  for (const cmd of config.commands) {
    const rels = changedFiles.map((f) => f.replace(/\\/g, "/"));
    if (cmd.glob && rels.length && !rels.some((f) => matchesVerifyGlob(f, cmd.glob!))) continue;
    try {
      const result = await runShellCommand(cmd.command, { cwd: workspaceRoot, timeoutMs: 120_000, maxOutputBytes: PROCESS_OUTPUT_LIMIT, sandboxProfile, workspaceRoot });
      const output = (stripAnsi(result.stdout) + (result.stderr ? `\n${stripAnsi(result.stderr)}` : "")).trim();
      results.push({ name: cmd.name, ok: result.ok, output: output.slice(0, 2000) });
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const output = (stripAnsi(err.stdout ?? "") + (err.stderr ? `\n${stripAnsi(err.stderr)}` : "") || err.message || "verification failed").toString();
      results.push({ name: cmd.name, ok: false, output: output.slice(0, 2000) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}