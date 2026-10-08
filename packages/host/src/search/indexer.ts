import * as fs from "node:fs/promises";
import * as path from "node:path";
import { globToRegExp } from "../util/glob.js";
const DEFAULT_INCLUDE = [
  "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs",
  "**/*.py", "**/*.rs", "**/*.go", "**/*.java", "**/*.kt", "**/*.cs",
  "**/*.rb", "**/*.php", "**/*.swift", "**/*.c", "**/*.cpp", "**/*.h",
  "**/*.hpp", "**/*.md", "**/*.mdx", "**/*.txt", "**/*.json", "**/*.yaml", "**/*.yml",
  "**/*.toml", "**/*.html", "**/*.css", "**/*.scss", "**/*.sql",
];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**", "**/build/**",
  "**/.next/**", "**/.vscode/**", "**/coverage/**", "**/.cache/**",
  "**/target/**", "**/venv/**", "**/__pycache__/**", "**/*.min.js", "**/*.lock",
  "**/*.lockb", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock",
];
export { DEFAULT_INCLUDE, DEFAULT_EXCLUDE };
export async function walk(
  root: string,
  include: string[],
  exclude: string[],
  opts: { ignore?: { isIgnored: (f: string) => boolean }; maxFiles?: number } = {},
): Promise<string[]> {
  const out: string[] = [];
  const maxFiles = opts.maxFiles ?? 50_000;
  async function visit(dir: string) {
    if (out.length >= maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (ent.isDirectory()) {
        if (matchesAny(rel + "/", exclude)) continue;
        if (opts.ignore?.isIgnored(`${rel}/`)) continue;
        await visit(full);
      } else if (ent.isFile()) {
        if (matchesAny(rel, exclude)) continue;
        if (opts.ignore?.isIgnored(rel)) continue;
        if (matchesAny(rel, include)) out.push(rel);
      }
    }
  }
  await visit(root);
  return out;
}
export function matchesAny(p: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (matchGlob(p, pat)) return true;
  }
  return false;
}
function matchGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}