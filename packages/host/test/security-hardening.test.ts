import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileEditor } from "../src/edit/editor";
import { classifyWorkspacePath } from "../src/security/path-policy";
import { DEFAULT_APPROVALS, initSession, resolveApproval } from "../src/approvals";
import { runPreWriteHooks } from "../src/hooks/hooks";
import { checkWriteGlob } from "../src/agent/tools";
import { assertSafeUrl } from "../src/security/network";
import { minimalEnvironment } from "../src/util/process";
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});
describe("security hardening", () => {
  it("classifies traversal and symlink targets outside the workspace", async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "arc-path-"));
    cleanup.push(work);
    const root = path.join(work, "workspace");
    const outside = path.join(work, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf-8");
    await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(classifyWorkspacePath(root, "../outside/secret.txt").external).toBe(true);
    expect(classifyWorkspacePath(root, "linked/secret.txt").external).toBe(true);
    await expect(new FileEditor(root).read("linked/secret.txt")).rejects.toThrow("escapes the workspace");
    await expect(new FileEditor(root, true).read("linked/secret.txt")).resolves.toBe("secret");
  });
  it.runIf(process.platform === "win32")("blocks Windows network, device, and alternate-stream paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "arc-win-path-"));
    cleanup.push(root);
    await expect(new FileEditor(root, true).read("\\\\attacker\\share\\secret.txt")).rejects.toThrow("not allowed");
    await expect(new FileEditor(root, true).read("file.txt::$DATA")).rejects.toThrow("not allowed");
  });
  it("auto-approve policy matrix: off always asks, safelist/allowlist/hail mary unlock their tiers", () => {
    const root = path.join(os.tmpdir(), "arc-approval-root");
    const outside = path.join(os.tmpdir(), "outside.txt");
    const mk = (mode: "off" | "safe" | "allowlist" | "all") => { const s = initSession(); s.autoApproveMode = mode; return s; };
    expect(resolveApproval(DEFAULT_APPROVALS, mk("off"), "read", { toolName: "file.read", filePath: "src/a.ts", workspaceRoot: root })).toBe("ask");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("off"), "shell.safe")).toBe("ask");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("safe"), "read", { toolName: "file.read", filePath: "src/a.ts", workspaceRoot: root })).toBe("auto");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("safe"), "shell.safe", { toolName: "shell.run", command: "git status", workspaceRoot: root })).toBe("auto");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("safe"), "browser")).toBe("auto");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("safe"), "code.execute")).toBe("ask");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("safe"), "subagent")).toBe("ask");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("safe"), "mcp.configure")).toBe("ask");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("allowlist"), "read.external", { toolName: "file.read", filePath: outside, workspaceRoot: root })).toBe("auto");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("allowlist"), "shell.other", { toolName: "shell.run", command: "git commit -m x", workspaceRoot: root })).toBe("auto");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("allowlist"), "code.execute")).toBe("ask");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("allowlist"), "mcp.configure")).toBe("ask");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("all"), "code.execute")).toBe("auto");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("all"), "mcp.configure")).toBe("auto");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("all"), "subagent")).toBe("auto");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("all"), "write.local-protected", { toolName: "file.edit", filePath: path.join(root, ".vscode", "settings.json"), workspaceRoot: root })).toBe("auto");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("allowlist"), "write.local-protected", { toolName: "file.edit", filePath: path.join(root, ".vscode", "settings.json"), workspaceRoot: root })).toBe("ask");
    expect(resolveApproval(DEFAULT_APPROVALS, mk("all"), "none")).toBe("auto");
  });
  it("blocks built-in secret patterns without hook configuration", async () => {
    const result = await runPreWriteHooks("config.ts", 'const token = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";');
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("OpenAI project API key");
  });
  it("fails closed for malformed write globs", () => {
    expect(checkWriteGlob("src/a.ts", "[").allowed).toBe(false);
    expect(checkWriteGlob("src/a.ts", "src/**/*.ts").allowed).toBe(true);
    expect(checkWriteGlob("secrets/a.ts", "src/**/*.ts").allowed).toBe(false);
  });
  it("blocks private-network fetch targets unless loopback was explicitly trusted", async () => {
    await expect(assertSafeUrl("http://127.0.0.1:8080/private")).rejects.toThrow();
    await expect(assertSafeUrl("http://127.0.0.1:8080/local", { allowPrivate: true, allowHttpLoopback: true })).resolves.toBeInstanceOf(URL);
  });
  it("does not copy ambient credentials into child environments", () => {
    process.env.ARC_TEST_SECRET = "do-not-copy";
    try {
      const env = minimalEnvironment();
      expect(env.ARC_TEST_SECRET).toBeUndefined();
      expect(env.PATH).toBeTruthy();
    } finally {
      delete process.env.ARC_TEST_SECRET;
    }
  });
});