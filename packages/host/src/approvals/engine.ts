import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getWorkspaceArcDir } from "../arc-dir.js";
import { classifyWorkspacePath } from "../security/path-policy.js";
import type { ApprovalsConfig, ApprovalPreset, SessionApprovals, AutoApproveLevel } from "./types.js";
import { PRESETS } from "./types.js";
export function resolvePreset(preset: ApprovalPreset): ApprovalsConfig {
  return PRESETS[preset] ?? PRESETS.dev;
}
const LEVEL_ORDER: Record<AutoApproveLevel, number> = { safe: 0, allowlist: 1, all: 2 };
const POLICY: Record<string, AutoApproveLevel | null> = {
  "read": "safe",
  "read.external": "allowlist",
  "write.local": "allowlist",
  "write.local-protected": "all",
  "write.external": "allowlist",
  "shell.safe": "safe",
  "shell.other": "allowlist",
  "browser": "safe",
  "mcp": "safe",
  "web.fetch": "safe",
  "code.execute": null,
  "subagent": null,
  "mcp.configure": null,
  "none": null,
};
const TOOL_OVERRIDES: Record<string, AutoApproveLevel | null> = {
  "browser.evaluate|browser": "allowlist",
  "browser.runCode|code.execute": "allowlist",
  "shell.customRun|shell.other": "safe",
  "shell.editCustomRun|shell.other": "safe",
  "shell.runCustomRun|shell.other": "safe",
  "mcp.toggle|mcp.configure": "safe",
  "mcp.create|mcp.configure": "allowlist",
  "mcp.remove|mcp.configure": "allowlist",
  "git.stage|shell.other": "safe",
  "git.commit|shell.other": "safe",
  "git.push|shell.other": "allowlist",
  "git.branch|shell.other": "allowlist",
  "git.pr|shell.other": "allowlist",
  "checkpoint.revert|none": "allowlist",
  "rule.create|write.external": "safe",
  "file.edit|write.local-protected": "all",
};
export function policyLevelFor(toolName: string, category: string): AutoApproveLevel | null {
  const key = `${toolName}|${category}`;
  if (key in TOOL_OVERRIDES) return TOOL_OVERRIDES[key];
  return POLICY[category] ?? null;
}
export function resolveApproval(
  config: ApprovalsConfig,
  session: SessionApprovals,
  category: string,
  extra?: { toolName?: string; filePath?: string; workspaceRoot?: string; command?: string; mcpServer?: string },
): "auto" | "ask" {
  const effectiveConfig = config.preset ? resolvePreset(config.preset) : config;
  const taskConfig = session.taskOverride ?? effectiveConfig;
  if (session.autoApproveMode === "off") return "ask";
  if (session.autoApproveMode === "all") return "auto";
  const toolName = extra?.toolName ?? "";
  let policyCategory = category;
  if (category === "read" && extra?.filePath && extra.workspaceRoot && classifyWorkspacePath(extra.workspaceRoot, extra.filePath).external) policyCategory = "read.external";
  if (category === "write.local" || category === "write.external") {
    const actual = classifyWritePath(extra?.filePath, extra?.workspaceRoot);
    policyCategory = actual;
    if (extra?.filePath && extra?.workspaceRoot && isProtectedConfigPath(extra.workspaceRoot, extra.filePath)) policyCategory = "write.local-protected";
  }
  if (category === "shell.safe" || category === "shell.other") {
    policyCategory = extra?.command && isSessionAllowed(session, extra.command) ? "shell.safe" : category;
  }
  const policy = policyLevelFor(toolName, policyCategory);
  if (policy !== null && LEVEL_ORDER[policy] <= LEVEL_ORDER[session.autoApproveMode]) return "auto";
  if (category === "mcp" && extra?.mcpServer) {
    const perServer = taskConfig.mcp.perServer[extra.mcpServer];
    if (perServer) return perServer;
    return taskConfig.mcp.default;
  }
  if (category === "read" && extra?.filePath && extra.workspaceRoot) {
    const actual = classifyWorkspacePath(extra.workspaceRoot, extra.filePath).external ? "read.external" : "read";
    return taskConfig[actual] ?? "ask";
  }
  if (category === "write.local" || category === "write.external") {
    if (extra?.filePath && extra?.workspaceRoot && isProtectedConfigPath(extra.workspaceRoot, extra.filePath)) return "ask";
    const actual = classifyWritePath(extra?.filePath, extra?.workspaceRoot);
    return taskConfig[actual] ?? "ask";
  }
  if (category === "shell.safe" || category === "shell.other") {
    if (extra?.command && isSessionAllowed(session, extra.command)) return "auto";
    return taskConfig[category] ?? "ask";
  }
  const configured = (taskConfig as unknown as Record<string, unknown>)[category];
  return configured === "auto" ? "auto" : "ask";
}
function classifyWritePath(filePath: string | undefined, workspaceRoot: string | undefined): "write.local" | "write.external" {
  if (!filePath || !workspaceRoot) return "write.external";
  return classifyWorkspacePath(workspaceRoot, filePath).external ? "write.external" : "write.local";
}
const PROTECTED_CONFIG_DIRS = [".arc", ".vscode", ".cursor", ".claude"];
const PROTECTED_CONFIG_FILES = [".arcignore", ".arcmodes", ".arcrules", ".arcrules.md", "AGENTS.md", "CLAUDE.md"];
function isProtectedConfigPath(workspaceRoot: string, filePath: string): boolean {
  const rel = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split("/");
  if (PROTECTED_CONFIG_DIRS.includes(parts[0])) return true;
  const base = parts[parts.length - 1];
  if (PROTECTED_CONFIG_FILES.includes(base)) return true;
  if (base.startsWith(".arcrules.")) return true;
  if (base.endsWith(".code-workspace")) return true;
  return false;
}
function isSessionAllowed(session: SessionApprovals, command: string): boolean {
  const trimmed = command.trim();
  for (const prefix of session.sessionCommandAllowlist) {
    if (trimmed === prefix || trimmed.startsWith(prefix + " ")) return true;
  }
  for (const mem of session.commandPrefixMemory) {
    if (trimmed === mem.prefix || trimmed.startsWith(mem.prefix + " ")) return true;
  }
  return false;
}
export function initSession(): SessionApprovals {
  return {
    autoApproveMode: "off",
    sessionCommandAllowlist: [],
    commandPrefixMemory: [],
  };
}
export async function loadApprovalsMemory(workspaceRoot: string): Promise<{ prefix: string; createdAt: string }[]> {
  try {
    const p = path.join(getWorkspaceArcDir(workspaceRoot), "approvals.json");
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}
export async function saveApprovalPrefix(workspaceRoot: string, prefix: string): Promise<void> {
  const existing = await loadApprovalsMemory(workspaceRoot);
  if (existing.some((e) => e.prefix === prefix)) return;
  existing.push({ prefix, createdAt: new Date().toISOString() });
  const dir = getWorkspaceArcDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "approvals.json"), JSON.stringify(existing, null, 2), "utf-8");
}