import * as fs from "node:fs";
import * as path from "node:path";
export interface WorkspacePathDecision {
  requested: string;
  resolved: string;
  canonical: string;
  canonicalRoot: string;
  external: boolean;
  blockedReason?: string;
}
function comparable(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(comparable(root), comparable(candidate));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
function canonicalizeMissing(candidate: string): string {
  const missing: string[] = [];
  let current = candidate;
  while (true) {
    try {
      const base = fs.realpathSync.native(current);
      return path.join(base, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return candidate;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
export function classifyWorkspacePath(workspaceRoot: string, requested: string): WorkspacePathDecision {
  if (process.platform === "win32") {
    const networkOrDevice = /^(?:\\\\|\\\?\\|\\\.\\)/.test(requested);
    const driveRelative = /^[a-zA-Z]:[^\\/]/.test(requested);
    const extraColon = requested.slice(2).includes(":");
    const reservedDevice = requested.split(/[\\/]/).some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?=[ .]|$)/i.test(segment.replace(/[ .]+$/, "")));
    if (networkOrDevice || driveRelative || extraColon || reservedDevice) {
      const resolved = path.resolve(workspaceRoot, requested);
      return {
        requested,
        resolved,
        canonical: resolved,
        canonicalRoot: canonicalizeMissing(path.resolve(workspaceRoot)),
        external: true,
        blockedReason: "Windows network, device, drive-relative, and alternate-data-stream paths are not allowed.",
      };
    }
  }
  const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(workspaceRoot, requested);
  const canonicalRoot = canonicalizeMissing(path.resolve(workspaceRoot));
  const canonical = canonicalizeMissing(resolved);
  return { requested, resolved, canonical, canonicalRoot, external: !isWithin(canonicalRoot, canonical) };
}
export function resolveAuthorizedPath(workspaceRoot: string, requested: string, allowExternal = false): string {
  if (!requested || requested.includes("\0")) throw new Error("A valid file path is required.");
  const decision = classifyWorkspacePath(workspaceRoot, requested);
  if (decision.blockedReason) throw new Error(decision.blockedReason);
  if (decision.external && !allowExternal) throw new Error(`Path escapes the workspace: ${requested}`);
  return decision.canonical;
}