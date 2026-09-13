import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { wrapSandbox, type SandboxProfile } from "../sandbox/sandbox.js";
import { scratchDirFor } from "../sandbox/win-sandbox.js";
export const PROCESS_OUTPUT_LIMIT = 1024 * 1024;
export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sandboxProfile?: SandboxProfile;
  workspaceRoot?: string;
  onChunk?: (stream: "stdout" | "stderr", text: string) => void;
  onSpawn?: (process: ChildProcess) => void;
  stdio?: "ignore" | ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"];
  detached?: boolean;
  input?: string | Buffer;
  timeoutAdopt?: (proc: ChildProcess, stdout: string, stderr: string) => boolean;
}
export interface ProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  truncated: boolean;
}
export type ShellKind = "bash" | "powershell" | "cmd";
export interface ShellInvocation {
  executable: string;
  args: string[];
  kind: ShellKind;
}
export function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      const p = path.join(dir, name);
      if (fs.existsSync(p) && !/[\\/]Windows([\\/]System(32|WOW64)|Apps)[\\/]/i.test(p)) return p;
    } catch { }
  }
  return undefined;
}
let winShellCache: ShellInvocation | undefined;
export function resolveWindowsShell(): ShellInvocation {
  if (winShellCache) return winShellCache;
  const winDir = process.env.SystemRoot ?? "C:\\Windows";
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const lad = process.env.LOCALAPPDATA;
  const bashCandidates = [
    findOnPath("bash.exe"),
    path.join(pf, "Git", "bin", "bash.exe"),
    path.join(pf86, "Git", "bin", "bash.exe"),
    lad ? path.join(lad, "Programs", "Git", "bin", "bash.exe") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "scoop", "apps", "git", "current", "bin", "bash.exe") : "",
  ].filter((p): p is string => !!p && fs.existsSync(p));
  if (bashCandidates[0]) {
    winShellCache = { executable: bashCandidates[0], args: ["-lc"], kind: "bash" };
    return winShellCache;
  }
  const psCandidates = [
    findOnPath("pwsh.exe"),
    path.join(winDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ].filter((p): p is string => !!p && fs.existsSync(p));
  if (psCandidates[0]) {
    winShellCache = { executable: psCandidates[0], args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"], kind: "powershell" };
    return winShellCache;
  }
  winShellCache = { executable: path.join(winDir, "System32", "cmd.exe"), args: ["/d", "/s", "/c"], kind: "cmd" };
  return winShellCache;
}
let preferredShell: ShellInvocation | undefined;
export function setPreferredShell(invocation: ShellInvocation | undefined): void {
  preferredShell = invocation;
}
export async function shellCommand(command: string): Promise<ShellInvocation> {
  if (preferredShell) return { executable: preferredShell.executable, args: [...preferredShell.args, command], kind: preferredShell.kind };
  if (process.platform === "win32") {
    const s = resolveWindowsShell();
    return { executable: s.executable, args: [...s.args, command], kind: s.kind };
  }
  return { executable: "/bin/sh", args: ["-lc", command], kind: "bash" };
}
export function proxyEnvironment(proxyUrl: string | undefined): NodeJS.ProcessEnv | undefined {
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    parsed.username = "";
    parsed.password = "";
    const safe = parsed.toString();
    return { HTTP_PROXY: safe, HTTPS_PROXY: safe, http_proxy: safe, https_proxy: safe };
  } catch {
    return undefined;
  }
}
const ENV_BLOCK = new Set(["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "RUBYLIB", "RUBYOPT", "PERL5LIB", "PERL5OPT", "JAVA_TOOL_OPTIONS", "GIT_SSH_COMMAND", "BASH_ENV", "ENV", "ZDOTDIR"]);
export function minimalEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = ["HOME", "USERPROFILE", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT", "PSModulePath", "LOCALAPPDATA", "APPDATA", "LANG"];
  const env: NodeJS.ProcessEnv = {};
  env.PATH = process.env.PATH ?? process.env.Path;
  for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || ENV_BLOCK.has(k.toUpperCase())) continue;
      env[k] = v;
    }
  }
  return env;
}
export function spawnBounded(executable: string, args: string[], opts: ProcessOptions): ChildProcess {
  const sandboxed = !!opts.sandboxProfile && opts.sandboxProfile !== "off";
  const invocation = sandboxed
    ? wrapSandbox(opts.sandboxProfile!, opts.workspaceRoot ?? opts.cwd, executable, args)
    : { executable, args };
  let env = opts.env ?? minimalEnvironment();
  if (sandboxed && process.platform === "win32") {
    const scratch = scratchDirFor(opts.workspaceRoot ?? opts.cwd);
    env = { ...env, TMP: scratch, TEMP: scratch };
  }
  return spawn(invocation.executable, invocation.args, {
    cwd: path.resolve(opts.cwd),
    env,
    windowsHide: true,
    stdio: opts.stdio ?? ["pipe", "pipe", "pipe"],
    detached: opts.detached ?? process.platform !== "win32",
    shell: false,
  });
}
export function terminateProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
    return;
  }
  try { process.kill(-proc.pid, "SIGKILL"); }
  catch { try { proc.kill("SIGKILL"); } catch {} }
}
export function runProcess(executable: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
  const max = opts.maxOutputBytes ?? PROCESS_OUTPUT_LIMIT;
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnBounded(executable, args, opts);
      opts.onSpawn?.(proc);
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: (error as Error).message, truncated: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outDec = new StringDecoder("utf-8");
    const errDec = new StringDecoder("utf-8");
    const finish = (ok: boolean, exitCode?: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdout += outDec.end();
      stderr += errDec.end();
      resolve({ ok, stdout, stderr, exitCode, truncated });
    };
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (truncated) return;
      const remaining = Math.max(0, max - bytes);
      const accepted = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0);
      bytes += accepted.length;
      const text = (stream === "stdout" ? outDec : errDec).write(accepted);
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (text) opts.onChunk?.(stream, text);
      if (accepted.length < chunk.length || bytes >= max) {
        truncated = true;
        terminateProcessTree(proc);
      }
    };
    proc.stdout?.on("data", (d: Buffer) => append("stdout", d));
    proc.stderr?.on("data", (d: Buffer) => append("stderr", d));
    proc.on("error", (error) => {
      stderr += `${stderr ? "\n" : ""}${error.message}`;
      finish(false);
    });
    proc.on("exit", (code) => finish(code === 0 && !truncated, code ?? undefined));
    proc.stdin?.end(opts.input);
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          if (opts.timeoutAdopt?.(proc, stdout, stderr)) {
            proc.stdout?.removeAllListeners("data");
            proc.stderr?.removeAllListeners("data");
          } else {
            terminateProcessTree(proc);
          }
        } catch {
          try { terminateProcessTree(proc); } catch {}
        }
        stderr += `${stderr ? "\n" : ""}Process timed out after ${opts.timeoutMs}ms`;
        finish(false);
      }, opts.timeoutMs);
    }
  });
}
export async function runShellCommand(command: string, opts: ProcessOptions): Promise<ProcessResult> {
  const invocation = await shellCommand(command);
  return runProcess(invocation.executable, invocation.args, opts);
}
let gitOverride: string | undefined;
let gitCache: string | null | undefined;
export function setGitPath(p: string | undefined): void {
  gitOverride = p ? String(p) : undefined;
  gitCache = undefined;
}
export async function resolveGit(): Promise<string | undefined> {
  if (gitOverride) return gitOverride;
  if (gitCache === undefined) gitCache = (await findGit()) ?? null;
  return gitCache ?? undefined;
}
async function findGit(): Promise<string | undefined> {
  if (await gitProbe("git")) return "git";
  if (process.platform !== "win32") return undefined;
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe") : undefined,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "cmd", "git.exe") : undefined,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Git", "cmd", "git.exe") : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "scoop", "apps", "git", "current", "cmd", "git.exe") : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && (await gitProbe(candidate))) return candidate;
  }
  return undefined;
}
async function gitProbe(executable: string): Promise<boolean> {
  try {
    const r = await runProcess(executable, ["--version"], { cwd: process.cwd(), timeoutMs: 8000, maxOutputBytes: 4096 });
    return r.ok;
  } catch {
    return false;
  }
}
export async function runGit(args: string[], opts: ProcessOptions): Promise<ProcessResult> {
  const exe = await resolveGit();
  if (!exe) return { ok: false, stdout: "", stderr: "git not found. install Git or set the git.path setting", truncated: false };
  return runProcess(exe, args, opts);
}