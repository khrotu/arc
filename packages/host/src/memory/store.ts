import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getArcDir, getWorkspaceArcDir } from "../arc-dir.js";
import type { MemoryEntry } from "./types.js";
export async function loadMemory(workspaceRoot: string, scope: "workspace" | "global" = "workspace", teamStores?: string[]): Promise<MemoryEntry[]> {
  const p = memoryPath(workspaceRoot, scope);
  let entries: MemoryEntry[] = [];
  try {
    const raw = await fs.readFile(p, "utf-8");
    entries = parseMemoryMd(raw);
  } catch {
  }
  for (const store of teamStores ?? []) {
    try {
      const raw = await fs.readFile(path.resolve(store), "utf-8");
      const extra = parseMemoryMd(raw).map((e) => ({ ...e, category: `${e.category} (team)` }));
      entries = [...entries, ...extra];
} catch {  }
  }
  return entries;
}
const memoryChains = new Map<string, Promise<unknown>>();
function chainMemory<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = memoryChains.get(key) ?? Promise.resolve();
  const task = prior.then(fn);
  const tracked = task.catch(() => undefined).finally(() => {
    if (memoryChains.get(key) === tracked) memoryChains.delete(key);
  });
  memoryChains.set(key, tracked);
  return task;
}
export async function addMemory(workspaceRoot: string, category: string, content: string, scope: "workspace" | "global" = "workspace"): Promise<MemoryEntry> {
  return chainMemory(`${workspaceRoot}::${scope}`, async () => {
    const entries = await loadMemory(workspaceRoot, scope);
    const entry: MemoryEntry = {
      category,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    entries.push(entry);
    await saveMemory(workspaceRoot, entries, scope);
    return entry;
  });
}
export async function editMemory(workspaceRoot: string, index: number, content: string, scope: "workspace" | "global" = "workspace"): Promise<boolean> {
  return chainMemory(`${workspaceRoot}::${scope}`, async () => {
    const entries = await loadMemory(workspaceRoot, scope);
    if (index < 0 || index >= entries.length) return false;
    entries[index].content = content;
    entries[index].updatedAt = new Date().toISOString();
    await saveMemory(workspaceRoot, entries, scope);
    return true;
  });
}
export async function deleteMemory(workspaceRoot: string, index: number, scope: "workspace" | "global" = "workspace"): Promise<boolean> {
  return chainMemory(`${workspaceRoot}::${scope}`, async () => {
    const entries = await loadMemory(workspaceRoot, scope);
    if (index < 0 || index >= entries.length) return false;
    entries.splice(index, 1);
    await saveMemory(workspaceRoot, entries, scope);
    return true;
  });
}
async function saveMemory(workspaceRoot: string, entries: MemoryEntry[], scope: "workspace" | "global"): Promise<void> {
  const p = memoryPath(workspaceRoot, scope);
  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true });
  const groups = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const cat = sanitizeCategory(e.category);
    const list = groups.get(cat) ?? [];
    list.push(e);
    groups.set(cat, list);
  }
  const lines: string[] = [];
  for (const [cat, list] of groups) {
    lines.push(`## ${cat}`);
    for (const e of list) {
      lines.push(`- **${formatDate(e.createdAt)}**: ${encodeContent(e.content)}`);
    }
    lines.push("");
  }
  const tmp = `${p}.tmp.${process.pid}.${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  try {
    await fs.writeFile(tmp, lines.join("\n"), "utf-8");
    await fs.rename(tmp, p);
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}
function sanitizeCategory(cat: unknown): string {
  const s = typeof cat === "string" ? cat.replace(/[\r\n]+/g, " ").trim().slice(0, 80) : "";
  return s || "general";
}
function encodeContent(s: string): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/\r\n/g, "\\n").replace(/[\n\r]/g, "\\n");
}
function decodeContent(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === "n" || s[i + 1] === "\\")) {
      out += s[i + 1] === "n" ? "\n" : "\\";
      i++;
      continue;
    }
    out += s[i];
  }
  return out;
}
function memoryPath(workspaceRoot: string, scope: "workspace" | "global"): string {
  const dir = scope === "global" ? getArcDir() : getWorkspaceArcDir(workspaceRoot);
  return path.join(dir, "MEMORY.md");
}
function parseMemoryMd(raw: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let category = "general";
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) { category = h2[1].trim(); continue; }
    const bullet = line.match(/^-\s+\*\*([^*]+)\*\*:\s*(.+)/);
    if (bullet) {
      entries.push({
        category,
        content: decodeContent(bullet[2].trim()),
        createdAt: bullet[1].trim(),
        updatedAt: bullet[1].trim(),
      });
    }
  }
  return entries;
}
function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
  } catch {
    return iso;
  }
}
export type { MemoryEntry } from "./types.js";