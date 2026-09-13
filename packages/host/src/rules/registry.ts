import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { getArcDir, getLocalWorkspaceArcDir, getWorkspaceArcDir } from "../arc-dir.js";
import type { RuleEntry } from "./types.js";
export interface RuleDiff {
  added: string[];
  removed: string[];
  changed: string[];
}
export class RuleRegistry {
  private rules = new Map<string, RuleEntry>();
  private workspaceRoot: string;
  private watchers: fsSync.FSWatcher[] = [];
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(workspaceRoot?: string, private includeRepositoryFiles = true) {
    this.workspaceRoot = workspaceRoot ?? "";
  }
  async load(): Promise<void> {
    this.rules.clear();
    await this.loadFromDir(getArcDir(), "global");
    if (this.workspaceRoot) {
      await this.loadFromDir(getWorkspaceArcDir(this.workspaceRoot), "workspace");
      if (this.includeRepositoryFiles) await this.loadFromDir(getLocalWorkspaceArcDir(this.workspaceRoot), "workspace");
      if (this.includeRepositoryFiles) await this.loadCrossToolRules();
    }
  }
  private async loadCrossToolRules(): Promise<void> {
    const candidates: { file: string; name: string }[] = [
      { file: ".cursorrules", name: ".cursorrules" },
      { file: ".windsurfrules", name: ".windsurfrules" },
      { file: ".clinerules", name: ".clinerules" },
      { file: "copilot-instructions.md", name: "copilot-instructions" },
      { file: ".github/copilot-instructions.md", name: "github-copilot-instructions" },
      { file: ".github/instructions/copilot-instructions.md", name: "github-copilot-instructions" },
    ];
    for (const { file, name } of candidates) {
      try {
        const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf-8");
        const parsed = parseRule(name, raw, "workspace");
        if (parsed) this.rules.set(`cross-tool:${name}`, parsed);
} catch {  }
    }
  }
  private async loadFromDir(baseDir: string, scope: "workspace" | "global"): Promise<void> {
    const rulesDir = path.join(baseDir, "rules");
    let entries: string[];
    try { entries = await fs.readdir(rulesDir); } catch { return; }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      try {
        const raw = await fs.readFile(path.join(rulesDir, entry), "utf-8");
        const parsed = parseRule(entry.replace(/\.md$/, ""), raw, scope);
        if (parsed) this.rules.set(parsed.name, parsed);
      } catch {}
    }
  }
  get(name: string): RuleEntry | undefined { return this.rules.get(name); }
  list(): RuleEntry[] { return [...this.rules.values()]; }
  async create(name: string, glob: string, description: string, body: string, scope: "workspace" | "global" = "workspace"): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new Error("Rule name must be a safe 1-64 character slug.");
    for (const [label, value] of [["glob", glob], ["description", description]] as const) {
      if (/[\r\n]/.test(value) || value.includes("---")) throw new Error(`Rule ${label} must be a single line without frontmatter delimiters.`);
    }
    const dir = path.join(scope === "global" ? getArcDir() : getWorkspaceArcDir(this.workspaceRoot), "rules");
    await fs.mkdir(dir, { recursive: true });
    const content = `---\nname: ${name}\nglob: ${glob}\ndescription: ${description}\n---\n\n${body}`;
    await fs.writeFile(path.join(dir, `${name}.md`), content, "utf-8");
    this.rules.set(name, { name, glob, description, body, scope });
  }
  watch(onChange?: (diff: RuleDiff) => void, debounceMs = 300): () => void {
    const dirs = [
      this.workspaceRoot ? path.join(getWorkspaceArcDir(this.workspaceRoot), "rules") : undefined,
      this.workspaceRoot && this.includeRepositoryFiles ? path.join(getLocalWorkspaceArcDir(this.workspaceRoot), "rules") : undefined,
      path.join(getArcDir(), "rules"),
    ].filter((d): d is string => !!d);
    const reload = async () => {
      const before = new Map(this.rules);
      try {
        await this.load();
      } catch {
        this.rules = before;
        return;
      }
      const diff = diffRules(before, this.rules);
      if (diff.added.length || diff.removed.length || diff.changed.length) onChange?.(diff);
    };
    const schedule = () => {
      clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => { reload().catch(() => {}); }, debounceMs);
    };
    for (const dir of dirs) {
      try {
        const localRoot = this.workspaceRoot ? getLocalWorkspaceArcDir(this.workspaceRoot) : "";
        const isLocal = !!localRoot && (dir === localRoot || dir.startsWith(localRoot + path.sep));
        if (isLocal && !fsSync.existsSync(dir)) continue;
        if (!isLocal) fsSync.mkdirSync(dir, { recursive: true });
        const w = fsSync.watch(dir, { recursive: true }, () => schedule());
        this.watchers.push(w);
      } catch {
      }
    }
    return () => this.stopWatching();
  }
  stopWatching(): void {
    for (const w of this.watchers) { try { w.close(); } catch {} }
    this.watchers = [];
    clearTimeout(this.watchTimer);
  }
}
function diffRules(before: Map<string, RuleEntry>, after: Map<string, RuleEntry>): RuleDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, rule] of after) {
    const prev = before.get(name);
    if (!prev) added.push(name);
    else if (prev.body !== rule.body || prev.glob !== rule.glob || prev.description !== rule.description) changed.push(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) removed.push(name);
  }
  return { added, removed, changed };
}
function parseRule(name: string, raw: string, scope: "workspace" | "global"): RuleEntry | undefined {
  const fm = extractYaml(raw);
  const body = bodyAfterYaml(raw);
  const description = (fm.description as string) || raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
  if (!fm.name && !description) return undefined;
  return {
    name: (fm.name as string) || name,
    glob: fm.glob as string | undefined,
    description,
    body: body || raw,
    scope,
  };
}
function extractYaml(raw: string): Record<string, unknown> {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === "---") { end = i; break; } }
  if (end === -1) return {};
  const result: Record<string, unknown> = {};
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}
function bodyAfterYaml(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return raw;
  let end = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === "---") { end = i; break; } }
  return end === -1 ? raw : lines.slice(end + 1).join("\n").trim();
}
export type { RuleEntry } from "./types.js";