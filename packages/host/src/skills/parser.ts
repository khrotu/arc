import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SkillMetadata } from "./types.js";
const MAX_SKILL_MD_BYTES = 256 * 1024;
export async function parseSkillMd(filePath: string, scope: "workspace" | "global"): Promise<SkillMetadata | undefined> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (stat && stat.size > MAX_SKILL_MD_BYTES) return undefined;
  const raw = await fs.readFile(filePath, "utf-8");
  if (raw.length > MAX_SKILL_MD_BYTES) return undefined;
  const frontmatter = extractFrontmatter(raw);
  const name = (frontmatter?.name as string)?.trim() ?? path.basename(filePath, ".md");
  if (!/^[a-z0-9-]+$/.test(name)) return undefined;
  const description = ((frontmatter?.description as string)?.trim() ?? firstHeading(raw))?.slice(0, 2000);
  if (!name || !description) return undefined;
  const skillDir = path.dirname(filePath);
  const shortDescription = description.slice(0, 120);
  const scripts = await listDirIfExists(path.join(skillDir, "scripts"));
  const references = await listDirIfExists(path.join(skillDir, "references"));
  const assets = await listDirIfExists(path.join(skillDir, "assets"));
  const meta = frontmatter?.metadata as Record<string, unknown> | undefined;
  return {
    name,
    description,
    shortDescription: (meta?.["short-description"] as string) ?? shortDescription,
    path: filePath,
    scope,
    scripts: scripts.map((s: string) => path.join(skillDir, "scripts", s)),
    references: references.map((r: string) => path.join(skillDir, "references", r)),
    assets: assets.map((a: string) => path.join(skillDir, "assets", a)),
  };
}
export async function readSkillBody(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf-8");
  return bodyAfterFrontmatter(raw).slice(0, MAX_SKILL_MD_BYTES);
}
function extractFrontmatter(raw: string): Record<string, unknown> | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) return undefined;
  const yamlText = lines.slice(1, end).join("\n");
  return parseSimpleYaml(yamlText);
}
function firstHeading(raw: string): string | undefined {
  const heading = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || undefined;
}
function bodyAfterFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return raw;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) return raw;
  return lines.slice(end + 1).join("\n").trim();
}
async function listDirIfExists(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let currentKey = "";
  let nested: Record<string, unknown> | undefined;
  for (const rawLine of lines) {
    const line = rawLine;
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    if (indent === 0) {
      flushNested();
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      result[key] = parseYamlValue(value);
      if (value === "" || value === "{}") {
        currentKey = key;
        nested = {};
      } else {
        currentKey = "";
        nested = undefined;
      }
    } else if (indent >= 2 && nested !== undefined && currentKey) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(indent, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      nested[key] = parseYamlValue(value);
    }
  }
  flushNested();
  function flushNested() {
    if (currentKey && nested && Object.keys(nested).length > 0) {
      result[currentKey] = nested;
    }
    currentKey = "";
    nested = undefined;
  }
  return result;
}
function parseYamlValue(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (!raw || raw === "{}") return raw;
  return raw;
}