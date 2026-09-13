import { applyEdit } from "./apply.js";
export interface ParsedBlock {
  file: string;
  search: string;
  replace: string;
}
export interface ParseDiffResult {
  ok: boolean;
  blocks: ParsedBlock[];
  errors: string[];
}
const SEARCH_OPEN = /^<<<<<<< SEARCH\s*$/;
const DIVIDER = /^=======\s*$/;
const REPLACE_CLOSE = /^>>>>>>> REPLACE\s*$/;
export function parseDiff(input: string): ParseDiffResult {
  if (input.length > 4 * 1024 * 1024) {
    return { ok: false, blocks: [], errors: ["Diff input exceeds the 4 MiB limit."] };
  }
  const lines = input.split(/\r\n?|\n/);
  if (lines.length > 100_000) {
    return { ok: false, blocks: [], errors: ["Diff input exceeds 100,000 lines."] };
  }
  const blocks: ParsedBlock[] = [];
  const errors: string[] = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;
    if (/^```/.test(lines[i].trim())) {
      i++;
      while (i < lines.length && lines[i].trim() === "") i++;
    }
    if (i >= lines.length) break;
    const file = lines[i].trim();
    if (!file || SEARCH_OPEN.test(file) || DIVIDER.test(file) || REPLACE_CLOSE.test(file)) {
      errors.push(`Line ${i + 1}: expected filename header, got '${lines[i]}'.`);
      return { ok: false, blocks, errors };
    }
    i++;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length || !SEARCH_OPEN.test(lines[i].trim())) {
      errors.push(`Line ${i + 1}: expected '<<<<<<< SEARCH' for file '${file}'.`);
      return { ok: false, blocks, errors };
    }
    i++;
    const search: string[] = [];
    while (i < lines.length && !DIVIDER.test(lines[i].trim())) {
      search.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      errors.push(`Unexpected EOF inside SEARCH block for '${file}'.`);
      return { ok: false, blocks, errors };
    }
    i++;
    const replace: string[] = [];
    while (i < lines.length && !REPLACE_CLOSE.test(lines[i].trim())) {
      replace.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      errors.push(`Unexpected EOF inside REPLACE block for '${file}'.`);
      return { ok: false, blocks, errors };
    }
    i++;
    if (blocks.length >= 500) {
      return { ok: false, blocks: [], errors: ["Diff input exceeds 500 blocks."] };
    }
    blocks.push({
      file,
      search: search.join("\n"),
      replace: replace.join("\n"),
    });
    if (i < lines.length && /^```/.test(lines[i].trim())) i++;
  }
  return { ok: errors.length === 0, blocks, errors };
}
export interface ApplyDiffInput {
  files: Record<string, string>;
  diff: string;
}
export interface ApplyDiffBlockResult {
  file: string;
  ok: boolean;
  matches: number;
  strategy?: string;
  error?: string;
}
export interface ApplyDiffResult {
  ok: boolean;
  files: Record<string, string>;
  results: ApplyDiffBlockResult[];
  errors: string[];
}
export function applyDiff(input: ApplyDiffInput): ApplyDiffResult {
  const parsed = parseDiff(input.diff);
  if (!parsed.ok) {
    return {
      ok: false,
      files: input.files,
      results: [],
      errors: parsed.errors,
    };
  }
  const files: Record<string, string> = { ...input.files };
  const results: ApplyDiffBlockResult[] = [];
  const errors: string[] = [];
  for (const block of parsed.blocks) {
    const before = files[block.file] ?? "";
    const r = applyEdit({ before, search: block.search, replace: block.replace });
    if (!r.ok) {
      results.push({ file: block.file, ok: false, matches: 0, error: r.error });
      errors.push(`Failed to apply block to ${block.file}: ${r.error}`);
      continue;
    }
    files[block.file] = r.after;
    results.push({
      file: block.file,
      ok: true,
      matches: r.matches,
      strategy: r.strategy,
    });
  }
  return { ok: errors.length === 0, files, results, errors };
}