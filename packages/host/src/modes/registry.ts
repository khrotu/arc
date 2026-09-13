import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getArcDir, getWorkspaceArcDir } from "../arc-dir.js";
import { DEFAULT_MODES } from "./defaults.js";
import type { Mode, ModeSource } from "./types.js";
export type { Mode, ModeSource } from "./types.js";
export class ModeRegistry {
  private modes = new Map<string, Mode>();
  private sourceMap = new Map<string, ModeSource>();
  private workspaceRoot: string;
  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot ?? "";
    for (const m of DEFAULT_MODES) {
      this.modes.set(m.slug, { ...m });
      this.sourceMap.set(m.slug, "builtin");
    }
  }
  async load(): Promise<void> {
    await this.loadFromDir(path.join(getArcDir(), "modes"), "global");
    if (this.workspaceRoot) {
      await this.loadFromDir(
        path.join(getWorkspaceArcDir(this.workspaceRoot), "modes"),
        "workspace",
      );
    }
  }
  private async loadFromDir(dir: string, source: ModeSource): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".toml")) continue;
      const slug = entry.replace(/\.toml$/, "");
      const filePath = path.join(dir, entry);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed = parseSimpleToml(raw);
        if (!parsed.slug && !slug) continue;
        const resolvedSlug = (parsed.slug as string) || slug;
        const base = DEFAULT_MODES.find((m) => m.slug === resolvedSlug);
        const mode = this.buildOverride(base, parsed, resolvedSlug, source);
        if (mode) {
          this.modes.set(resolvedSlug, mode);
          this.sourceMap.set(resolvedSlug, source);
        }
      } catch {
      }
    }
  }
  private buildOverride(
    base: Mode | undefined,
    parsed: Record<string, unknown>,
    slug: string,
    source: ModeSource,
  ): Mode | undefined {
    const roleDefinition = (parsed.roleDefinition as string) ?? base?.roleDefinition;
    const description = (parsed.description as string) ?? base?.description ?? "";
    const whenToUse = (parsed.whenToUse as string) ?? base?.whenToUse ?? "";
    let allowedTools = Array.isArray(parsed.allowedTools)
      ? (parsed.allowedTools as string[])
      : base?.allowedTools ?? [];
    if (source === "workspace" && base && Array.isArray(parsed.allowedTools)) {
      const baseTools = new Set(base.allowedTools);
      allowedTools = allowedTools.filter((t) => baseTools.has(t));
    }
    const writeGlob = (parsed.writeGlob as string) ?? base?.writeGlob;
    const model = (parsed.model as string) ?? base?.model;
    if (!roleDefinition && allowedTools.length === 0) return undefined;
    if (!roleDefinition && base) {
      return { ...base, allowedTools, writeGlob: writeGlob ?? base.writeGlob, description, whenToUse, model: model ?? base.model };
    }
    return {
      slug,
      roleDefinition: roleDefinition ?? "",
      allowedTools,
      writeGlob,
      description,
      whenToUse,
      model,
    };
  }
  get(slug: string): Mode | undefined {
    return this.modes.get(slug);
  }
  list(): Mode[] {
    return [...this.modes.values()];
  }
  sourceOf(slug: string): ModeSource | undefined {
    return this.sourceMap.get(slug);
  }
  defaultSlug(): string {
    return "code";
  }
  resolveDefault(userRequestedSlug?: string): string {
    if (userRequestedSlug && this.modes.has(userRequestedSlug)) {
      return userRequestedSlug;
    }
    return this.defaultSlug();
  }
  async save(mode: Mode, scope: "workspace" | "global" = "workspace"): Promise<void> {
    if (!mode.slug.trim()) throw new Error("Mode slug is required.");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(mode.slug)) throw new Error("Mode slug must be lowercase alphanumeric with hyphens only.");
    if (!mode.roleDefinition.trim()) throw new Error("Mode prompt (roleDefinition) is required.");
    if (!mode.allowedTools.length) throw new Error("At least one allowed tool is required.");
    const dir = scope === "global" ? path.join(getArcDir(), "modes") : path.join(getWorkspaceArcDir(this.workspaceRoot), "modes");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${mode.slug}.toml`), serializeMode(mode), "utf-8");
    this.modes.set(mode.slug, mode);
    this.sourceMap.set(mode.slug, scope);
  }
  async delete(slug: string, scope: "workspace" | "global" = "workspace"): Promise<void> {
    const dir = scope === "global" ? path.join(getArcDir(), "modes") : path.join(getWorkspaceArcDir(this.workspaceRoot), "modes");
    try {
      await fs.unlink(path.join(dir, `${slug}.toml`));
    } catch {
    }
    const base = DEFAULT_MODES.find((m) => m.slug === slug);
    if (base) {
      this.modes.set(slug, { ...base });
      this.sourceMap.set(slug, "builtin");
    } else {
      this.modes.delete(slug);
      this.sourceMap.delete(slug);
    }
  }
}
function serializeMode(mode: Mode): string {
  const lines: string[] = [];
  lines.push(`slug = "${escapeToml(mode.slug)}"`);
  lines.push(`roleDefinition = "${escapeToml(mode.roleDefinition)}"`);
  lines.push(`description = "${escapeToml(mode.description)}"`);
  lines.push(`whenToUse = "${escapeToml(mode.whenToUse)}"`);
  if (mode.writeGlob) lines.push(`writeGlob = "${escapeToml(mode.writeGlob)}"`);
  if (mode.model) lines.push(`model = "${escapeToml(mode.model)}"`);
  lines.push(`allowedTools = [${mode.allowedTools.map((t) => `"${escapeToml(t)}"`).join(", ")}]`);
  return lines.join("\n") + "\n";
}
function escapeToml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
function parseSimpleToml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const valueRaw = trimmed.slice(eqIdx + 1).trim();
    const value = parseTomlValue(valueRaw);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
function unescapeBasic(s: string): string {
  return s
    .replace(/\\\\/g, "\0")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\0/g, "\\");
}
function parseTomlValue(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return unescapeBasic(raw.slice(1, -1));
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    const items: string[] = [];
    let depth = 0;
    let start = 0;
    let inString = false;
    let stringChar = "";
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (inString) {
        if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === "[" || ch === "{") { depth++; continue; }
      if (ch === "]" || ch === "}") { depth--; continue; }
      if (ch === "," && depth === 0) {
        const item = inner.slice(start, i).trim();
        if (item) items.push(stripQuotes(item));
        start = i + 1;
      }
    }
    const last = inner.slice(start).trim();
    if (last) items.push(stripQuotes(last));
    return items;
  }
  return raw;
}
function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeBasic(s.slice(1, -1));
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  return s;
}