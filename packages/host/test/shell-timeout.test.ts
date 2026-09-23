import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { runProcess, terminateProcessTree } from "../src/util/process";
import { tools, killActiveProcesses, listBackgroundProcesses, parseTimeoutSec } from "../src/agent/tools";
import type { ToolContext } from "../src/agent/tools";
import type { ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
afterAll(() => { killActiveProcesses(); });
function shellAvailable(): boolean {
  if (process.platform !== "win32") return true;
  try {
    return spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "$true"], { timeout: 20_000 }).status === 0;
  } catch {
    return false;
  }
}
const hasShell = shellAvailable();
describe("runProcess timeout adoption", () => {
  it("kills the process on timeout when no adopt hook is given", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-sh-"));
    const result = await runProcess(process.execPath, ["-e", "console.log('partial-work-done'); setInterval(function(){}, 1000);"], { cwd: tmp, timeoutMs: 900 });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Process timed out after 900ms");
    expect(result.stdout).toContain("partial-work-done");
  });
  it("hands the still-running process to the adopt hook instead of killing it", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-sh-"));
    let adopted: ChildProcess | undefined;
    let adoptedStdout = "";
    const result = await runProcess(process.execPath, ["-e", "console.log('partial-work-done'); setInterval(function(){}, 1000);"], {
      cwd: tmp,
      timeoutMs: 900,
      timeoutAdopt: (proc, stdout) => { adopted = proc; adoptedStdout = stdout; return true; },
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Process timed out after 900ms");
    expect(result.stdout).toContain("partial-work-done");
    expect(adopted).toBeTruthy();
    expect(adoptedStdout).toContain("partial-work-done");
    await new Promise((r) => setTimeout(r, 300));
    expect(adopted!.exitCode).toBeNull();
    expect(adopted!.killed).toBe(false);
    terminateProcessTree(adopted!);
    await new Promise<void>((resolve) => {
      if (adopted!.exitCode !== null || adopted!.signalCode) return resolve();
      adopted!.once("exit", () => resolve());
      setTimeout(resolve, 5000);
    });
    expect(adopted!.exitCode ?? adopted!.signalCode).not.toBeNull();
  });
});
describe("parseTimeoutSec", () => {
  it("accepts numbers, numeric strings, and suffixed strings without ever returning NaN", () => {
    expect(parseTimeoutSec(3)).toBe(3);
    expect(parseTimeoutSec("3")).toBe(3);
    expect(parseTimeoutSec("3s")).toBe(3);
    expect(parseTimeoutSec("3 seconds")).toBe(3);
    expect(parseTimeoutSec("1500ms")).toBe(1.5);
    expect(parseTimeoutSec("2m")).toBe(120);
    expect(parseTimeoutSec(-1)).toBe(-1);
    expect(parseTimeoutSec(0)).toBe(0);
    expect(parseTimeoutSec(undefined)).toBe(-1);
    expect(parseTimeoutSec("")).toBe(-1);
    expect(parseTimeoutSec("soon")).toBe(-1);
    expect(parseTimeoutSec(Number.NaN)).toBe(-1);
    for (const v of [3, "3", "3s", undefined, "soon", Number.NaN]) {
      expect(Number.isNaN(parseTimeoutSec(v))).toBe(false);
    }
  });
});
describe("shell.run timeout moves the process to the background", () => {
  it.skipIf(!hasShell)("returns a background id and the process stays pollable", { timeout: 30_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-sh-"));
    const scriptPath = path.join(tmp, "sleeper.js");
    await fs.writeFile(scriptPath, "console.log('partial-work-done'); setInterval(function(){}, 1000);\n");
    const ctx = { root: tmp, workspacePath: tmp } as unknown as ToolContext;
    const run = await tools["shell.run"].fn({ command: `node "${scriptPath}"`, timeout: 5 }, ctx);
    expect(run.ok).toBe(false);
    expect(run.output).toContain("partial-work-done");
    expect(run.output).toMatch(/\[timed out after 5s\] Still running in the background \(id: \d+\)/);
    const id = run.output.match(/background \(id: (\d+)\)/)![1];
    const check = await tools["shell.check"].fn({ id }, ctx);
    expect(check.ok).toBe(true);
    expect(check.output).toContain("[running]");
    expect(check.output).toContain("partial-work-done");
    expect(listBackgroundProcesses().some((p) => p.id === id && !p.exited)).toBe(true);
  });
  it.skipIf(!hasShell)("engages the timeout for suffixed string timeouts", { timeout: 30_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-sh-"));
    const scriptPath = path.join(tmp, "sleeper.js");
    await fs.writeFile(scriptPath, "console.log('partial-work-done'); setInterval(function(){}, 1000);\n");
    const ctx = { root: tmp, workspacePath: tmp } as unknown as ToolContext;
    const run = await tools["shell.run"].fn({ command: `node "${scriptPath}"`, timeout: "1s" }, ctx);
    expect(run.ok).toBe(false);
    expect(run.output).toMatch(/\[timed out after 1s\] Still running in the background \(id: \d+\)/);
  });
});
describe("shell.write delivers lines to background stdin", () => {
  it.skipIf(!hasShell)("appends a trailing newline so Read-Host style readers consume input", { timeout: 30_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-sh-"));
    const scriptPath = path.join(tmp, "asker.js");
    await fs.writeFile(
      scriptPath,
      "const rl = require('readline').createInterface({ input: process.stdin });\n" +
      "rl.on('line', (l) => { console.log('got:' + l); process.exit(0); });\n",
    );
    const ctx = { root: tmp, workspacePath: tmp } as unknown as ToolContext;
    const started = await tools["shell.backgroundRun"].fn({ command: `node "${scriptPath}"` }, ctx);
    expect(started.ok).toBe(true);
    const id = started.output.match(/\(id: (\d+)\)/)![1];
    const sent = await tools["shell.write"].fn({ id, input: "hello" }, ctx);
    expect(sent.ok).toBe(true);
    let seen = "";
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const check = await tools["shell.check"].fn({ id }, ctx);
      seen = check.output;
      if (seen.includes("got:hello")) break;
    }
    expect(seen).toContain("got:hello");
  });
});