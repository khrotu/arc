import * as path from "node:path";
import * as vscode from "vscode";
import { resolveTerminal } from "@arc/host";
const OUTPUT_LIMIT = 1024 * 1024;
const INTEGRATION_WAIT_MS = 15_000;
const EXECUTION_TIMEOUT_MS = 600_000;
type ShellKind = "bash" | "powershell" | "cmd";
interface ArcTerminalState {
  terminal: vscode.Terminal;
  terminalId: string | undefined;
  shellPath: string | undefined;
  kind: ShellKind;
  cwd: string;
}
let state: ArcTerminalState | undefined;
let queue: Promise<unknown> = Promise.resolve();
let termGen = 0;
function stripTerminalAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
    .replace(/\u0007/g, "");
}
function shellKindFor(executable: string | undefined): ShellKind {
  const base = path.basename(executable ?? vscode.env.shell ?? "").toLowerCase();
  if (base.startsWith("pwsh") || base.startsWith("powershell")) return "powershell";
  if (base === "cmd.exe") return "cmd";
  return "bash";
}
function quoteFor(kind: ShellKind, p: string): string {
  const sanitized = p.replace(/[\r\n\0]/g, "");
  if (kind === "powershell") return `'${sanitized.replace(/'/g, "''")}'`;
  if (kind === "cmd") return `"${sanitized.replace(/"/g, '""').replace(/[%^&|<>]/g, "")}"`;
  return `'${sanitized.replace(/'/g, "'\\''")}'`;
}
function wslPath(cwd: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(cwd);
  if (!m) return cwd.replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}
function cdPrefix(state: ArcTerminalState, cwd: string): string {
  const target = state.terminalId === "wsl" ? wslPath(cwd) : cwd;
  if (state.terminalId === "nushell") return `cd ${quoteFor("powershell", target)}; `;
  if (state.kind === "cmd") return `cd /d ${quoteFor("cmd", target)} && `;
  if (state.kind === "powershell") return `Set-Location -LiteralPath ${quoteFor("powershell", target)}; `;
  return `cd ${quoteFor("bash", target)} && `;
}
function sameCwd(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function acquireTerminal(context: vscode.ExtensionContext, cwd: string): Promise<ArcTerminalState> {
  const selected = resolveTerminal(vscode.workspace.getConfiguration().get<string>("arc.shell.terminal", "default") ?? "default");
  const wanted = selected?.executable;
  if (state && state.terminal.exitStatus === undefined && state.shellPath === wanted) return state;
  if (state) {
    try { state.terminal.dispose(); } catch { }
    state = undefined;
  }
  termGen++;
  const options: vscode.TerminalOptions = {
    name: "Arc",
    iconPath: vscode.Uri.joinPath(context.extensionUri, "assets", "arc-logo-mono.png"),
    isTransient: true,
    cwd: vscode.Uri.file(cwd),
  };
  if (wanted) options.shellPath = wanted;
  const terminal = vscode.window.createTerminal(options);
  state = { terminal, terminalId: selected?.id, shellPath: wanted, kind: selected?.kind ?? shellKindFor(wanted), cwd };
  return state;
}
function waitForIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
  return new Promise((resolve) => {
    let settled = false;
    const d1 = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === terminal) finish(terminal.shellIntegration);
    });
    const d2 = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) finish(undefined);
    });
    const iv = setInterval(() => {
      if (terminal.shellIntegration) finish(terminal.shellIntegration);
    }, 250);
    const timer = setTimeout(() => finish(terminal.shellIntegration), INTEGRATION_WAIT_MS);
    function finish(value: vscode.TerminalShellIntegration | undefined): void {
      if (settled) return;
      settled = true;
      d1.dispose();
      d2.dispose();
      clearInterval(iv);
      clearTimeout(timer);
      resolve(value);
    }
  });
}
async function runOnce(context: vscode.ExtensionContext, command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  let st = await acquireTerminal(context, cwd);
  const gen = termGen;
  st.terminal.show(true);
  let integration = await waitForIntegration(st.terminal);
  if (gen !== termGen || st !== state) {
    st = await acquireTerminal(context, cwd);
    st.terminal.show(true);
    integration = await waitForIntegration(st.terminal);
  }
  if (!integration) {
    st.terminal.sendText(command, true);
    return { ok: true, output: "(command sent to the Arc terminal; shell integration is unavailable so output and exit status were not captured)" };
  }
  const line = (sameCwd(st.cwd, cwd) ? "" : cdPrefix(st, cwd)) + command;
  st.cwd = cwd;
  const execution = integration.executeCommand(line);
  let out = "";
  const drained = (async () => {
    try {
      for await (const chunk of execution.read()) {
        out = (out + chunk).slice(-OUTPUT_LIMIT);
      }
    } catch { }
  })();
  const endListener: { current?: { dispose(): void } } = {};
  const ended = new Promise<number | undefined>((resolve) => {
    const dEnd = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.execution === execution) {
        dEnd.dispose();
        resolve(e.exitCode);
      }
    });
    endListener.current = dEnd;
  });
  const exit = await Promise.race([ended, delay(EXECUTION_TIMEOUT_MS).then(() => "timeout" as const)]);
  if (exit === "timeout") {
    try {
      endListener.current?.dispose();
    } catch {}
    st.terminal.sendText("\u0003", false);
    await Promise.race([drained, delay(500)]);
    return { ok: false, output: `${stripTerminalAnsi(out).trimEnd()}\n[timed out after ${EXECUTION_TIMEOUT_MS / 1000}s] sent Ctrl+C; the command may still be running in the Arc terminal` };
  }
  await Promise.race([drained, delay(1000)]);
  const text = stripTerminalAnsi(out).trimEnd() || "(no output)";
  if (exit === undefined) return { ok: true, output: `${text}\n[exit code not reported by shell integration]` };
  if (exit !== 0) return { ok: false, output: `${text}\n[exit code: ${exit}]` };
  return { ok: true, output: text };
}
export async function runInArcTerminal(context: vscode.ExtensionContext, command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  const job = queue.then(() => runOnce(context, command, cwd));
  queue = job.catch(() => { });
  return job;
}
export function disposeArcTerminal(): void {
  queue = Promise.resolve();
  termGen++;
  if (state) {
    try { state.terminal.dispose(); } catch { }
    state = undefined;
  }
}