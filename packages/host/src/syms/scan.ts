import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CODE_EXTENSIONS, extractFileSymbols, type CodeSymbol } from "./extract.js";
import { loadArcIgnore } from "../util/arcignore.js";
import { walk, DEFAULT_EXCLUDE } from "../search/indexer.js";
export interface ScanOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
}
const CODE_INCLUDE = [...CODE_EXTENSIONS].map((ext) => `**/*.${ext}`);
const CODE_EXCLUDE = [
  ...DEFAULT_EXCLUDE,
  "**/target/**", "**/venv/**", "**/__pycache__/**", "**/.vscode/**",
  "**/.cache/**", "**/coverage/**", "**/.next/**",
];
export async function scanWorkspaceSymbols(root: string, opts: ScanOptions = {}): Promise<{ symbols: CodeSymbol[]; filesScanned: number }> {
  const maxFiles = opts.maxFiles ?? 500;
  const maxBytes = opts.maxBytesPerFile ?? 512 * 1024;
  let ignore: { isIgnored: (f: string) => boolean };
  try {
    ignore = await loadArcIgnore(root);
  } catch {
    ignore = { isIgnored: () => false };
  }
  const listed = await walk(root, CODE_INCLUDE, CODE_EXCLUDE, { ignore, maxFiles: 50_000 });
  const files = listed.sort(priorityCompare).slice(0, maxFiles);
  const symbols: CodeSymbol[] = [];
  let filesScanned = 0;
  for (const rel of files) {
    try {
      const stat = await fs.stat(path.join(root, rel));
      if (!stat.isFile() || stat.size > maxBytes || stat.size === 0) continue;
      const head = await readHead(path.join(root, rel));
      if (head.includes("\0")) continue;
      const text = await fs.readFile(path.join(root, rel), "utf-8");
      if (text.includes("\0")) continue;
      for (const s of extractFileSymbols(rel, text)) symbols.push(s);
      filesScanned++;
    } catch {
      continue;
    }
    if (symbols.length > 20_000) break;
  }
  return { symbols, filesScanned };
}
function priorityCompare(a: string, b: string): number {
  const rank = (f: string): number => {
    if (/(^|\/)(src|app|lib)\//.test(f)) return 0;
    if (/(^|\/)test/.test(f) || /\.test\.|\.spec\./.test(f)) return 2;
    return 1;
  };
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  const depth = a.split("/").length - b.split("/").length;
  if (depth !== 0) return depth;
  return a.localeCompare(b);
}
async function readHead(full: string, bytes = 8192): Promise<string> {
  try {
    const fh = await fs.open(full, "r");
    try {
      const buf = Buffer.alloc(Math.min(bytes, (await fh.stat()).size));
      await fh.read(buf, 0, buf.length, 0);
      return buf.toString("utf-8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}