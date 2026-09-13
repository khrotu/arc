import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workspaceHash } from "../arc-dir.js";
import type { SandboxProfile } from "./sandbox.js";
const WIN32 = process.platform === "win32";
export function powershellPath(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
export function windowsSandboxAvailable(): boolean {
  return WIN32 && fs.existsSync(powershellPath());
}
function sandboxRoot(): string {
  return path.join(os.homedir(), ".arc", "sandbox", "win");
}
export function scratchDirFor(root: string): string {
  return path.join(sandboxRoot(), "tmp", workspaceHash(root));
}
const CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace WinSandbox
{
    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct STARTUPINFO
        {
            public int cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct TOKEN_MANDATORY_LABEL
        {
            public IntPtr Label;
            public uint Attributes;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool DuplicateTokenEx(IntPtr token, uint desiredAccess, IntPtr tokenAttributes, int impersonationLevel, int tokenType, out IntPtr newToken);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool CreateRestrictedToken(IntPtr baseToken, uint flags, int disableSidCount, IntPtr disableSids, int deletePrivilegeCount, IntPtr deletePrivileges, int restrictSidCount, IntPtr restrictSids, out IntPtr newToken);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern uint GetLengthSid(IntPtr sid);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool SetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessAsUserW(IntPtr token, string applicationName, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref int info, int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        private static IntPtr MakeLowIlToken()
        {
            IntPtr tok;
            if (!OpenProcessToken(GetCurrentProcess(), 0x008F, out tok)) throw new Exception("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
            IntPtr restricted;
            if (!CreateRestrictedToken(tok, 0x1, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted)) throw new Exception("CreateRestrictedToken failed: " + Marshal.GetLastWin32Error());
            CloseHandle(tok);
            IntPtr ilSid;
            if (!ConvertStringSidToSid("S-1-16-4096", out ilSid)) throw new Exception("Integrity SID conversion failed: " + Marshal.GetLastWin32Error());
            TOKEN_MANDATORY_LABEL label = new TOKEN_MANDATORY_LABEL();
            label.Label = ilSid;
            label.Attributes = 0x20;
            IntPtr pLabel = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)));
            Marshal.StructureToPtr(label, pLabel, false);
            if (!SetTokenInformation(restricted, 25, pLabel, Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)))) throw new Exception("SetTokenInformation(TokenIntegrityLevel) failed: " + Marshal.GetLastWin32Error());
            return restricted;
        }
        private static IntPtr MakeFilteredToken()
        {
            IntPtr tok;
            if (!OpenProcessToken(GetCurrentProcess(), 0x008F, out tok)) throw new Exception("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
            IntPtr restricted;
            if (!CreateRestrictedToken(tok, 0x1, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted)) throw new Exception("CreateRestrictedToken failed: " + Marshal.GetLastWin32Error());
            CloseHandle(tok);
            return restricted;
        }
        private static void AppendQuoted(StringBuilder sb, string s)
        {
            sb.Append('"');
            int backslashes = 0;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '\\\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    sb.Append('\\\\', backslashes + 1);
                    backslashes = 0;
                    sb.Append('"');
                    continue;
                }
                sb.Append('\\\\', backslashes);
                backslashes = 0;
                sb.Append(c);
            }
            sb.Append('\\\\', backslashes * 2);
            sb.Append('"');
        }
        public static int Run(string exe, string[] childArgs, bool lowIl)
        {
            IntPtr token = lowIl ? MakeLowIlToken() : MakeFilteredToken();
            IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
            if (job != IntPtr.Zero)
            {
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = 0x2000;
                SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
                int ui = 0x2 | 0x4 | 0x8 | 0x20 | 0x40;
                SetInformationJobObject(job, 11, ref ui, 4);
            }
            StringBuilder cl = new StringBuilder();
            AppendQuoted(cl, exe);
            foreach (string a in childArgs) { cl.Append(' '); AppendQuoted(cl, a); }
            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            PROCESS_INFORMATION pi;
            bool ok = CreateProcessAsUserW(token, null, cl.ToString(), IntPtr.Zero, IntPtr.Zero, true, 0x00000200, IntPtr.Zero, null, ref si, out pi);
            if (!ok)
            {
                int err = Marshal.GetLastWin32Error();
                Console.Error.WriteLine("arc-sandbox: CreateProcessAsUser failed (error " + err + ")");
                return 4;
            }
            if (job != IntPtr.Zero) AssignProcessToJobObject(job, pi.hProcess);
            WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
            uint code;
            GetExitCodeProcess(pi.hProcess, out code);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            CloseHandle(token);
            if (job != IntPtr.Zero) CloseHandle(job);
            return (int)code;
        }
    }
}
`;
function ensureLauncherFiles(): { script: string } {
  const dir = sandboxRoot();
  fs.mkdirSync(dir, { recursive: true });
  const csPath = path.join(dir, "WinSandbox.cs");
  const dllPath = path.join(dir, "WinSandbox.dll");
  const script = path.join(dir, "launcher.ps1");
  if (!fs.existsSync(dllPath) || !fs.existsSync(csPath) || fs.readFileSync(csPath, "utf-8") !== CSHARP) {
    fs.writeFileSync(csPath, CSHARP, "utf-8");
    execFileSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${csPath.replace(/'/g, "''")}')) -OutputAssembly '${dllPath.replace(/'/g, "''")}' -OutputType Library`], { timeout: 60_000, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  }
  const launcher = `param(\n  [Parameter(Mandatory=$true)][string]$Exe,\n  [Parameter(Mandatory=$true)][string]$ChildArgsB64,\n  [int]$LowIl = 1\n)\n$dll = Join-Path $PSScriptRoot "WinSandbox.dll"\nAdd-Type -Path $dll\n$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ChildArgsB64))\n$ChildArgs = [string[]](ConvertFrom-Json -InputObject $decoded)\n$code = [WinSandbox.Native]::Run($Exe, $ChildArgs, [bool]$LowIl)\nexit $code\n`;
  if (!fs.existsSync(script) || fs.readFileSync(script, "utf-8") !== launcher) {
    fs.writeFileSync(script, launcher, "utf-8");
  }
  return { script };
}
const labeledIntegrity = new Set<string>();
function setIntegrityLabel(target: string): void {
  const key = target.toLowerCase();
  if (labeledIntegrity.has(key)) return;
  execFileSync("icacls", [target, "/setintegritylevel", "(OI)(CI)L", "/T"], { timeout: 300_000, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  labeledIntegrity.add(key);
}
const PATHEXT = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
function resolveWindowsExe(executable: string, root: string): string {
  const hasSep = executable.includes("/") || executable.includes("\\");
  const hasExt = /\.[a-zA-Z0-9]+$/.test(executable);
  const exts = hasExt ? [""] : PATHEXT;
  const pathEnv = (process.env.PATH ?? process.env.Path ?? "").split(";").filter(Boolean);
  const dirs = hasSep ? [root, process.cwd()] : [...pathEnv];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, executable + e);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return executable;
}
export function wrapWindowsSandbox(profile: SandboxProfile, root: string, executable: string, args: string[]): { executable: string; args: string[] } {
  if (!windowsSandboxAvailable()) throw new Error(`Sandbox profile '${profile}' requires Windows PowerShell, which was not found.`);
  let exe = executable;
  let childArgs = args;
  if (WIN32) {
    const resolved = resolveWindowsExe(executable, root);
    const lower = resolved.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      const inner = [resolved, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(" ");
      exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      childArgs = ["/d", "/s", "/c", inner];
    } else {
      exe = resolved;
    }
  }
  const { script } = ensureLauncherFiles();
  const lowIl = profile !== "system";
  const scratch = scratchDirFor(root);
  if (profile !== "system") {
    fs.mkdirSync(scratch, { recursive: true });
    setIntegrityLabel(scratch);
    if (profile === "workspace") setIntegrityLabel(root);
  } else {
    fs.mkdirSync(scratch, { recursive: true });
  }
  const argsB64 = Buffer.from(JSON.stringify(childArgs), "utf-8").toString("base64");
  return {
    executable: powershellPath(),
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Exe", exe, "-ChildArgsB64", argsB64, "-LowIl", lowIl ? "1" : "0"],
  };
}