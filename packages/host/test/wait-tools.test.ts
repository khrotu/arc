import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { tools } from "../src/agent/tools";
const ctx = {
  root: process.cwd(),
  workspacePath: process.cwd(),
  sandboxProfile: undefined,
  proxyShell: undefined,
  proxyUrl: undefined,
  requestApproval: async () => true,
} as any;
describe("shell wait flags", () => {
  it("shell.check with waitForExit waits for a background process exit", async () => {
    const started = await tools["shell.backgroundRun"].fn({ command: "node -e \"setTimeout(()=>{}, 150)\"" }, ctx);
    expect(started.ok).toBe(true);
    const id = String(started.output.match(/\(id: (\d+)\)/)?.[1]);
    const r = await tools["shell.check"].fn({ id, waitForExit: true, timeout: 10 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("exited");
  });
  it("shell.check rejects an unknown id", async () => {
    const r = await tools["shell.check"].fn({ id: "nope" }, ctx);
    expect(r.ok).toBe(false);
  });
  it("shell.run with untilSuccess succeeds when the command succeeds", async () => {
    const r = await tools["shell.run"].fn({ command: "node -e \"process.exit(0)\"", untilSuccess: true, interval: 0.25, timeout: 10 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("succeeded");
  });
  it("shell.run with untilSuccess times out when the command keeps failing", async () => {
    const r = await tools["shell.run"].fn({ command: "node -e \"process.exit(1)\"", untilSuccess: true, interval: 0.25, timeout: 1 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("still failing");
  });
  it("shell.run with untilSuccess requires approval", async () => {
    let asked = false;
    const denied = {
      ...ctx,
      requestApproval: async () => { asked = true; return false; },
    };
    const r = await tools["shell.run"].fn({ command: "echo hi", untilSuccess: true }, denied);
    expect(asked).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("denied");
  });
  it("shell wait aborts on signal", async () => {
    const ac = new AbortController();
    const abortedCtx = { ...ctx, signal: ac.signal };
    const p = tools["shell.run"].fn({ command: "node -e \"process.exit(1)\"", untilSuccess: true, interval: 0.25, timeout: 30 }, abortedCtx);
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.output).toContain("interrupted");
  });
  it("context.retrieve returns stored content and errors on unknown ids", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arc-retrieve-"));
    const { saveBlob } = await import("../src/compress/store");
    const content = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ i })) });
    const id = await saveBlob(tmp, "shell.run", content);
    const hit = await tools["context.retrieve"].fn({ id }, { ...ctx, root: tmp });
    expect(hit.ok).toBe(true);
    expect(hit.output).toBe(content);
    const miss = await tools["context.retrieve"].fn({ id: "ffffffff" }, { ...ctx, root: tmp });
    expect(miss.ok).toBe(false);
    const empty = await tools["context.retrieve"].fn({}, { ...ctx, root: tmp });
    expect(empty.ok).toBe(false);
  });
});