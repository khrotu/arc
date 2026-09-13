export type LosslessKind = "search" | "log" | "diff" | "text" | "auto";
export function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}
const ANSI_RE =
  /[\u001b\u009b](?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[[()#;?]*[0-9;:.]*[0-9A-ORZcf-nqry=><~])/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}
export function collapseBlankRuns(text: string): string {
  const eol = detectEol(text);
  return text.replace(/[ \t]+$/gm, "").replace(/(?:\r?\n){4,}/g, eol.repeat(3));
}
export function collapseRepeatedLines(text: string, minRun = 3): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= minRun && lines[i].trim().length > 0) {
      out.push(lines[i], `... (repeated ${run} times)`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out.join(detectEol(text));
}
export function expandRepeatedLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\.\.\. \(repeated (\d+) times\)$/);
    if (m && out.length > 0) {
      const total = Number(m[1]);
      if (!Number.isSafeInteger(total) || total <= 0 || total > 100_000) {
        out.push(lines[i]);
        continue;
      }
      for (let k = 1; k < total; k++) out.push(out[out.length - 1]);
    } else {
      out.push(lines[i]);
    }
  }
  return out.join(detectEol(text));
}
export interface FoldedBlock {
  text: string;
  folded: boolean;
}
export function foldRepeatedBlocks(text: string, maxBlock = 64, maxLines = 20_000): FoldedBlock {
  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) return { text, folded: false };
  const out: string[] = [];
  let folded = false;
  let i = 0;
  while (i < lines.length) {
    let best: { k: number; d: number } | undefined;
    const remaining = lines.length - i;
    const maxK = Math.min(maxBlock, remaining, i);
    for (let k = maxK; k >= 3; k--) {
      const d = k;
      if (d > i) continue;
      let match = true;
      for (let o = 0; o < k; o++) {
        if (lines[i + o] !== lines[i - d + o]) {
          match = false;
          break;
        }
      }
      if (match) {
        best = { k, d };
        break;
      }
    }
    if (best) {
      out.push(`... (repeats ${best.k} lines from ${best.d} lines back)`);
      i += best.k;
      folded = true;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return { text: out.join(detectEol(text)), folded };
}
export function unfoldRepeatedBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\.\.\. \(repeats (\d+) lines from (\d+) lines back\)$/);
    if (m) {
      const k = Number(m[1]);
      const d = Number(m[2]);
      if (!Number.isSafeInteger(k) || !Number.isSafeInteger(d) || k > d || k <= 0 || k > 100_000 || d > out.length) {
        out.push(line);
        continue;
      }
      const start = out.length - d;
      for (let o = 0; o < k; o++) out.push(out[start + o]);
    } else {
      out.push(line);
    }
  }
  return out.join(detectEol(text));
}
const GREP_ROW_RE = /^(.+?):(\d+):(.*)$/;
export const TIMESTAMP_ROW_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
export function searchHeading(text: string): string {
  const lines = text.split(/\r?\n/);
  const eol = detectEol(text);
  const out: string[] = [];
  let curPath = "";
  let folded = false;
  for (const line of lines) {
    if (TIMESTAMP_ROW_RE.test(line)) {
      curPath = "";
      out.push(line);
      continue;
    }
    const m = line.match(GREP_ROW_RE);
    if (m && m[1].length < 260 && !/\s{2,}/.test(m[1])) {
      const [, p, n, rest] = m;
      if (p !== curPath) {
        curPath = p;
        out.push(`##> ${p}`);
        folded = true;
      }
      out.push(`${n}:${rest}`);
      continue;
    }
    curPath = "";
    if (line.startsWith("#")) {
      out.push(`#${line}`);
    } else if (/^ ?\d+:.*$/.test(line)) {
      out.push(` ${line}`);
    } else {
      out.push(line);
    }
  }
  return folded ? out.join(eol) : text;
}
export function searchUnheading(text: string): string {
  const lines = text.split(/\r?\n/);
  const eol = detectEol(text);
  const out: string[] = [];
  let curPath = "";
  let active = false;
  for (const line of lines) {
    const h = line.match(/^##> (\S.*)$/);
    const row = line.match(/^(\d+):(.*)$/);
    if (h && !row) {
      curPath = h[1];
      active = true;
      continue;
    }
    if (active && curPath && row) {
      out.push(`${curPath}:${row[1]}:${row[2]}`);
      continue;
    }
    if (line.startsWith("#")) {
      active = false;
      out.push(line.slice(1));
      continue;
    }
    const escapedRow = line.match(/^ ( ?\d+:.*)$/);
    if (escapedRow) {
      out.push(escapedRow[1]);
      continue;
    }
    active = false;
    out.push(line);
  }
  return out.join(eol);
}
export function diffStripIndex(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("index "))
    .join(detectEol(text));
}
function acceptFold(original: string, folded: string, unfold: (s: string) => string): string | undefined {
  if (folded.length >= original.length) return undefined;
  try {
    if (unfold(folded) !== original) return undefined;
  } catch {
    return undefined;
  }
  return folded;
}
export function compactLossless(text: string, kind: LosslessKind = "auto"): string {
  if (process.env.ARC_NO_LOSSLESS === "1") return text;
  let working = stripAnsi(text);
  working = collapseBlankRuns(working);
  const runs = collapseRepeatedLines(working);
  const runsOk = acceptFold(working, runs, expandRepeatedLines);
  if (runsOk !== undefined) working = runsOk;
  const wantsSearch = kind === "search" || kind === "auto";
  if (wantsSearch) {
    const folded = searchHeading(working);
    const ok = acceptFold(working, folded, searchUnheading);
    if (ok !== undefined) working = ok;
  }
  const blocks = foldRepeatedBlocks(working);
  if (blocks.folded) {
    const ok = acceptFold(working, blocks.text, unfoldRepeatedBlocks);
    if (ok !== undefined) working = ok;
  }
  return working;
}