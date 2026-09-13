import * as fs from "node:fs/promises";
import { Dirent } from "node:fs";
import * as path from "node:path";
interface DepNode {
  file: string;
  imports: string[];
  importedBy: string[];
}
const PATTERNS: { ext: RegExp; re: RegExp }[] = [
  { ext: /\.(ts|tsx|js|jsx|mjs|cjs)$/, re: /(?:import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\))/g },
  { ext: /\.(py)$/, re: /(?:from\s+(\S+)\s+import|import\s+(\S+))/g },
  { ext: /\.(rs)$/, re: /(?:use\s+(\S+)(?:::|;)|mod\s+(\S+);|extern\s+crate\s+(\S+);)/g },
  { ext: /\.(go)$/, re: /import\s+["']([^"']+)["']/g },
  { ext: /\.(java)$/, re: /import\s+(\S+);/g },
];
function resolveImport(fromFile: string, importPath: string, root: string): string | null {
  if (importPath.startsWith(".")) {
    const dir = path.dirname(fromFile);
    const resolved = path.resolve(dir, importPath);
    const tryExts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js", ".py", ".rs", ".go", ".java"];
    for (const ext of tryExts) {
      const p = resolved + ext;
      if (p.startsWith(root + path.sep)) return p;
    }
    return resolved;
  }
  return null;
}
export async function generateDependencyGraph(workspaceRoot: string): Promise<DepNode[]> {
  const files = await collectFiles(workspaceRoot);
  const imports = new Map<string, Set<string>>();
  for (const file of files) {
    const ext = path.extname(file);
    const pattern = PATTERNS.find((p) => p.ext.test(ext));
    if (!pattern) continue;
    try {
      const content = await fs.readFile(file, "utf-8");
      const deps = new Set<string>();
      let m: RegExpExecArray | null;
      pattern.re.lastIndex = 0;
      while ((m = pattern.re.exec(content)) !== null) {
        const imp = m[1] || m[2] || m[3];
        if (!imp) continue;
        const resolved = resolveImport(file, imp, workspaceRoot);
        if (resolved) deps.add(path.relative(workspaceRoot, resolved));
      }
      if (deps.size > 0) imports.set(path.relative(workspaceRoot, file), deps);
    } catch { }
  }
  const nodes: DepNode[] = [];
  const parseable = files
    .filter((f) => PATTERNS.some((p) => p.ext.test(path.extname(f))))
    .map((f) => path.relative(workspaceRoot, f));
  const fileSet = new Set(parseable);
  for (const file of parseable) {
    const outImports = [...(imports.get(file) ?? [])].filter((d) => fileSet.has(d));
    const importedBy: string[] = [];
    for (const [f, deps] of imports) {
      if (deps.has(file)) importedBy.push(f);
    }
    nodes.push({ file, imports: outImports, importedBy });
  }
  nodes.sort((a, b) => a.file.localeCompare(b.file));
  return nodes;
}
export function formatDepGraph(nodes: DepNode[], workspaceRoot: string): string {
  const lines: string[] = [];
  lines.push(`## Codebase dependency graph`);
  lines.push(`${nodes.length} source files across ${path.basename(workspaceRoot)}`);
  lines.push("");
  const top = nodes.filter((n) => n.importedBy.length === 0 && n.imports.length > 0).sort((a, b) => b.imports.length - a.imports.length).slice(0, 20);
  if (top.length > 0) {
    lines.push("### Entry points (no incoming dependencies)");
    for (const n of top) {
      lines.push(`- \`${n.file}\` → imports ${n.imports.length} module${n.imports.length === 1 ? "" : "s"}`);
    }
    lines.push("");
  }
  const hubs = nodes.filter((n) => n.importedBy.length >= 3).sort((a, b) => b.importedBy.length - a.importedBy.length).slice(0, 20);
  if (hubs.length > 0) {
    lines.push("### High-connectivity modules (imported by 3+ files)");
    for (const n of hubs) {
      lines.push(`- \`${n.file}\` - imported by ${n.importedBy.length} file${n.importedBy.length === 1 ? "" : "s"}, imports ${n.imports.length}`);
    }
    lines.push("");
  }
  const cycles = findCycles(nodes);
  if (cycles.length > 0) {
    lines.push("### Circular dependencies");
    for (const cycle of cycles.slice(0, 10)) {
      lines.push(`- ${cycle.join(" → ")}`);
    }
    lines.push("");
  }
  lines.push("### Full dependency table");
  lines.push("");
  lines.push("| File | Imports | Imported by |");
  lines.push("| :--- | :--- | :--- |");
  for (const n of nodes.slice(0, 200)) {
    const imps = n.imports.length ? n.imports.map((i) => `\`${i}\``).join(", ") : "-";
    const by = n.importedBy.length ? n.importedBy.length + "" : "-";
    lines.push(`| \`${n.file}\` | ${imps} | ${by} |`);
  }
  if (nodes.length > 200) lines.push(`| ... | +${nodes.length - 200} more files | |`);
  return lines.join("\n");
}
function findCycles(nodes: DepNode[]): string[][] {
  const index = new Map(nodes.map((n) => [n.file, n]));
  const visited = new Set<string>();
  const cycles: string[][] = [];
  for (const node of nodes) {
    if (visited.has(node.file)) continue;
    const stack: string[] = [];
    const onStack = new Set<string>();
    function dfs(file: string): boolean {
      visited.add(file);
      stack.push(file);
      onStack.add(file);
      const n = index.get(file);
      if (n) {
        for (const imp of n.imports) {
          if (!index.has(imp)) continue;
          if (!visited.has(imp)) {
            if (dfs(imp)) return true;
          } else if (onStack.has(imp)) {
            const cycle = stack.slice(stack.indexOf(imp));
            cycle.push(imp);
            cycles.push(cycle);
            return true;
          }
        }
      }
      onStack.delete(file);
      stack.pop();
      return false;
    }
    dfs(node.file);
  }
  return cycles;
}
async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const excludes = new Set(["node_modules", ".git", ".arc", "dist", "out", "build", ".next", "__pycache__", "target", ".venv", "venv"]);
  const walk = async (d: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (excludes.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (e.isFile()) out.push(full);
    }
  };
  await walk(dir);
  return out;
}