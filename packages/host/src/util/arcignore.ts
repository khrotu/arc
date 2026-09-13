import * as fs from "node:fs/promises";
import * as path from "node:path";
import { globToRegExpSource } from "./glob.js";
export interface ArcIgnore {
  patterns: string[];
  dirPatterns: string[];
  negations: string[];
  raw: string[];
  isIgnored(relPath: string, isDir?: boolean): boolean;
  filter<T>(files: T[], toRel: (f: T) => string): T[];
}
function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  if (p.startsWith("./")) p = p.slice(2);
  return new RegExp(`^(?:${globToRegExpSource(p)})$`);
}
function matchWithVariants(rel: string, pattern: string): boolean {
  const pats = [pattern];
  if (!pattern.includes("/") && !pattern.startsWith("**")) {
    pats.push(`**/${pattern}`);
    pats.push(`**/${pattern}/**`);
  }
  if (pattern.endsWith("/")) {
    pats.push(pattern.slice(0, -1));
  }
  if (!pattern.includes("*") && !pattern.includes("?") && !pattern.endsWith("/")) {
    pats.push(`${pattern}/**`);
  }
  for (const p of pats) {
    const re = patternToRegExp(p);
    if (re.test(rel)) return true;
    if (!p.includes("/") && re.test(rel.split("/").pop() ?? rel)) return true;
  }
  return false;
}
export function parseArcIgnore(content: string): { patterns: string[]; negations: string[] } {
  const patterns: string[] = [];
  const negations: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      const pat = line.slice(1).trim().replace(/^\/+/, "");
      if (pat) negations.push(pat);
    } else {
      const pat = line.replace(/^\/+/, "");
      if (pat) patterns.push(pat);
    }
  }
  return { patterns, negations };
}
export function createArcIgnore(patterns: string[], negations: string[] = [], raw: string[] = []): ArcIgnore {
  const ordered: { neg: boolean; pat: string }[] = [];
  if (raw.length > 0) {
    for (const rawLine of raw) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("!")) {
        const pat = line.slice(1).trim().replace(/^\/+/, "");
        if (pat) ordered.push({ neg: true, pat });
      } else {
        const pat = line.replace(/^\/+/, "");
        if (pat) ordered.push({ neg: false, pat });
      }
    }
  } else {
    for (const pat of patterns) ordered.push({ neg: false, pat });
    for (const pat of negations) ordered.push({ neg: true, pat });
  }
  const isIgnored = (relPath: string, _isDir = false): boolean => {
    const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || rel === ".arcignore") return false;
    let ignored = false;
    for (const rule of ordered) {
      if (matchWithVariants(rel, rule.pat)) ignored = !rule.neg;
    }
    return ignored;
  };
  return {
    patterns,
    dirPatterns: patterns.filter((p) => p.endsWith("/")),
    negations,
    raw,
    isIgnored,
    filter<T>(files: T[], toRel: (f: T) => string): T[] {
      return files.filter((f) => !isIgnored(toRel(f)));
    },
  };
}
export function emptyArcIgnore(): ArcIgnore {
  return createArcIgnore([]);
}
const cache = new Map<string, { mtimeMs: number; ctimeMs: number; ino: number; size: number; ignore: ArcIgnore }>();
export async function loadArcIgnore(root: string): Promise<ArcIgnore> {
  const file = path.join(root, ".arcignore");
  try {
    const stat = await fs.stat(file);
    const ctimeMs = (stat as { ctimeMs?: number }).ctimeMs ?? stat.mtimeMs;
    const ino = (stat as { ino?: number }).ino ?? 0;
    const cached = cache.get(root);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === ctimeMs && cached.ino === ino && cached.size === stat.size) return cached.ignore;
    const content = await fs.readFile(file, "utf-8");
    const stat2 = await fs.stat(file).catch(() => stat);
    const { patterns, negations } = parseArcIgnore(content);
    const ignore = createArcIgnore(patterns, negations, content.split(/\r?\n/));
    cache.set(root, { mtimeMs: stat2.mtimeMs, ctimeMs: (stat2 as { ctimeMs?: number }).ctimeMs ?? stat2.mtimeMs, ino: (stat2 as { ino?: number }).ino ?? 0, size: stat2.size, ignore });
    return ignore;
  } catch {
    const ignore = emptyArcIgnore();
    cache.set(root, { mtimeMs: 0, ctimeMs: 0, ino: 0, size: 0, ignore });
    return ignore;
  }
}
export function clearArcIgnoreCache(root?: string): void {
  if (root) cache.delete(root);
  else cache.clear();
}
export function isIgnoredBy(patterns: string[], negations: string[], relPath: string): boolean {
  return createArcIgnore(patterns, negations).isIgnored(relPath);
}