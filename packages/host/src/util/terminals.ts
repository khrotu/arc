import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { findOnPath, type ShellInvocation, type ShellKind } from "./process.js";
export interface TerminalDescriptor {
  id: string;
  name: string;
  executable: string;
  args: string[];
  kind: ShellKind;
}
export function terminalInvocation(terminal: TerminalDescriptor, command: string): ShellInvocation {
  return { executable: terminal.executable, args: [...terminal.args, command], kind: terminal.kind };
}
const PS_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
const SH_LC = ["-lc"];
const SH_C = ["-c"];
function exists(p: string | undefined): boolean {
  if (!p) return false;
  try { return fs.existsSync(p); } catch { return false; }
}
let wslProbed = false;
let wslHasDistro = false;
function probeWsl(wslExe: string): boolean {
  if (wslProbed) return wslHasDistro;
  wslProbed = true;
  try {
    const r = spawnSync(wslExe, ["--list", "--quiet"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
    wslHasDistro = r.status === 0 && !!r.stdout && r.stdout.replace(/\0/g, "").trim().length > 0;
  } catch { wslHasDistro = false; }
  return wslHasDistro;
}
let cache: TerminalDescriptor[] | undefined;
export function detectTerminals(): TerminalDescriptor[] {
  if (cache) return cache;
  const out: TerminalDescriptor[] = [];
  const seenExecutables = new Set<string>();
  const seenIds = new Set<string>();
  const push = (d: TerminalDescriptor | undefined) => {
    if (!d || seenIds.has(d.id) || seenExecutables.has(d.executable.toLowerCase())) return;
    seenExecutables.add(d.executable.toLowerCase());
    seenIds.add(d.id);
    out.push(d);
  };
  if (process.platform === "win32") {
    const winDir = process.env.SystemRoot ?? "C:\\Windows";
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const lad = process.env.LOCALAPPDATA;
    const pwsh = findOnPath("pwsh.exe")
      ?? [path.join(pf, "PowerShell", "7", "pwsh.exe"), path.join(pf86, "PowerShell", "7", "pwsh.exe"), lad ? path.join(lad, "Programs", "PowerShell", "7", "pwsh.exe") : ""].find(exists);
    if (pwsh) push({ id: "pwsh", name: "PowerShell 7", executable: pwsh, args: PS_ARGS, kind: "powershell" });
    const powershell = path.join(winDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (exists(powershell)) push({ id: "powershell", name: "PowerShell 5.1", executable: powershell, args: PS_ARGS, kind: "powershell" });
    const cmd = path.join(winDir, "System32", "cmd.exe");
    if (exists(cmd)) push({ id: "cmd", name: "Command Prompt", executable: cmd, args: ["/d", "/s", "/c"], kind: "cmd" });
    const gitBash = [
      path.join(pf, "Git", "bin", "bash.exe"),
      path.join(pf86, "Git", "bin", "bash.exe"),
      lad ? path.join(lad, "Programs", "Git", "bin", "bash.exe") : "",
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "scoop", "apps", "git", "current", "bin", "bash.exe") : "",
    ].find(exists);
    if (gitBash) push({ id: "git-bash", name: "Git Bash", executable: gitBash, args: SH_LC, kind: "bash" });
    const wsl = path.join(winDir, "System32", "wsl.exe");
    if (exists(wsl) && probeWsl(wsl)) push({ id: "wsl", name: "WSL", executable: wsl, args: ["--", "bash", "-lc"], kind: "bash" });
    for (const cygwinBase of ["C:\\cygwin64", "C:\\cygwin"]) {
      const bash = path.join(cygwinBase, "bin", "bash.exe");
      if (exists(bash)) push({ id: "cygwin", name: "Cygwin", executable: bash, args: SH_LC, kind: "bash" });
    }
    const pathBash = findOnPath("bash.exe");
    if (pathBash) push({ id: "msys-bash", name: "Bash (MSYS2)", executable: pathBash, args: SH_LC, kind: "bash" });
    const nu = findOnPath("nu.exe");
    if (nu) push({ id: "nushell", name: "Nushell", executable: nu, args: SH_C, kind: "bash" });
  } else {
    const shell: { id: string; name: string; exe: string; args: string[] }[] = [
      { id: "bash", name: "Bash", exe: "bash", args: SH_LC },
      { id: "zsh", name: "Zsh", exe: "zsh", args: SH_LC },
      { id: "fish", name: "Fish", exe: "fish", args: SH_C },
      { id: "nushell", name: "Nushell", exe: "nu", args: SH_C },
      { id: "pwsh", name: "PowerShell 7", exe: "pwsh", args: PS_ARGS },
      { id: "xonsh", name: "Xonsh", exe: "xonsh", args: SH_C },
      { id: "elvish", name: "Elvish", exe: "elvish", args: SH_C },
      { id: "ksh", name: "Ksh", exe: "ksh", args: SH_C },
      { id: "tcsh", name: "Tcsh", exe: "tcsh", args: SH_C },
      { id: "dash", name: "Dash", exe: "dash", args: SH_C },
      { id: "sh", name: "Sh", exe: "sh", args: SH_C },
    ];
    const userShell = (process.env.SHELL ?? "").trim();
    if (userShell) {
      const known = shell.find((s) => s.exe === path.basename(userShell));
      if (known && exists(userShell)) push({ id: known.id, name: known.name, executable: userShell, args: known.args, kind: "bash" });
    }
    for (const s of shell) {
      const found = findOnPath(s.exe) ?? ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map((dir) => path.join(dir, s.exe)).find(exists);
      if (found) push({ id: s.id, name: s.name, executable: found, args: s.args, kind: "bash" });
    }
    try {
      const lines = fs.readFileSync("/etc/shells", "utf-8").split("\n");
      for (const line of lines) {
        const p = line.trim();
        if (!p || p.startsWith("#") || !exists(p)) continue;
        const base = path.basename(p);
        const known = shell.find((s) => s.exe === base);
        const id = known ? known.id : base === "nu" ? "nushell" : base;
        push({ id, name: known ? known.name : base, executable: p, args: known ? known.args : SH_C, kind: "bash" });
      }
    } catch { }
  }
  cache = out;
  return out;
}
export function resolveTerminal(id: string | undefined): TerminalDescriptor | undefined {
  if (!id || id === "default") return undefined;
  return detectTerminals().find((t) => t.id === id);
}