import { describe, it, expect } from "vitest";
import * as os from "node:os";
import { tools, decodeInputEscapes, type ToolContext } from "../src/agent/tools";
function ctx(): ToolContext {
  return { root: os.tmpdir(), workspacePath: os.tmpdir() } as unknown as ToolContext;
}
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}
describe("decodeInputEscapes", () => {
  it("decodes control-byte escapes", () => {
    expect(decodeInputEscapes("\\u0003")).toBe("\x03");
    expect(decodeInputEscapes("\\x03")).toBe("\x03");
    expect(decodeInputEscapes("\\x1b[A")).toBe("\x1b[A");
    expect(decodeInputEscapes("a\\nb")).toBe("a\nb");
    expect(decodeInputEscapes("a\\tb\\\\c")).toBe("a\tb\\c");
  });
  it("leaves unknown escapes untouched", () => {
    expect(decodeInputEscapes("\\q")).toBe("\\q");
    expect(decodeInputEscapes("plain")).toBe("plain");
  });
});
describe("shell.write control bytes", () => {
  it("delivers a Ctrl+C byte sent via inputEscaped", async () => {
    const node = JSON.stringify(process.execPath);
    const start = await tools["shell.backgroundRun"].fn({ command: `${node} -e "process.stdin.on('data',function(d){console.log('GOT:'+JSON.stringify(d.toString()))})"` }, ctx());
    expect(start.ok).toBe(true);
    const id = /\(id: (\d+)\)/.exec(start.output)?.[1] ?? "";
    expect(id).not.toBe("");
    try {
      const wrote = await tools["shell.write"].fn({ id, inputEscaped: "\\u0003" }, ctx());
      expect(wrote.ok).toBe(true);
      expect(wrote.output).toContain("2 bytes");
      const seen = await waitFor(async () => {
        const check = await tools["shell.check"].fn({ id }, ctx());
        return check.output.includes("\\u0003");
      }, 8000);
      expect(seen).toBe(true);
    } finally {
      await tools["shell.kill"].fn({ id }, ctx());
    }
  }, 20000);
  it("shell.kill terminates a running process", async () => {
    const node = JSON.stringify(process.execPath);
    const start = await tools["shell.backgroundRun"].fn({ command: `${node} -e "setInterval(function(){},1000)"` }, ctx());
    expect(start.ok).toBe(true);
    const id = /\(id: (\d+)\)/.exec(start.output)?.[1] ?? "";
    expect(id).not.toBe("");
    const killed = await tools["shell.kill"].fn({ id }, ctx());
    expect(killed.ok).toBe(true);
    expect(killed.output).toContain("Killed background process");
    const check = await tools["shell.check"].fn({ id }, ctx());
    expect(check.ok).toBe(false);
  }, 20000);
});