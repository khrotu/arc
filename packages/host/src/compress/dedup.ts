export interface DedupBlock {
  text: string;
  turn: number;
  protect?: boolean;
}
import { detectEol, TIMESTAMP_ROW_RE } from "./lossless.js";
const MIN_LINES = 3;
const MIN_CHARS = 40;
const MAX_ANCHORS_PER_LINE = 16;
const MAX_EXTEND_LINES_PER_BLOCK = 40000;
function anchorKey(line: string): string | undefined {
  const t = line.trim();
  if (t.length < 8) return undefined;
  if (/^(return|pass|else:?|endif|end\}?)\b/i.test(t)) return undefined;
  const stripped = t.replace(/^\d+[:\t]\s*/, "");
  if (/^\d{2}:\d{2}:\d{2}/.test(stripped) || TIMESTAMP_ROW_RE.test(stripped)) return undefined;
  return stripped.slice(0, 120);
}
function isBetter(
  len: number,
  srcTurn: number,
  foldedSrc: boolean,
  best: { len: number; srcTurn: number; foldedSrc: boolean } | undefined,
): boolean {
  if (!best) return true;
  if (best.foldedSrc !== foldedSrc) return !foldedSrc;
  if (len !== best.len) return len > best.len;
  return srcTurn < best.srcTurn;
}
export function dedupBlocks(blocks: DedupBlock[]): (string | undefined)[] {
  const out: (string | undefined)[] = blocks.map((b) => b.text);
  const foldedTurn = new Array<boolean>(blocks.length).fill(false);
  const index = new Map<string, { turn: number; line: number }[]>();
  const blockLines = blocks.map((b) => b.text.split(/\r?\n/));
  for (let t = 0; t < blocks.length; t++) {
    if (blocks[t].protect) continue;
    const eol = detectEol(blocks[t].text);
    const lines = blockLines[t];
    const folded: string[] = [];
    let extendBudget = MAX_EXTEND_LINES_PER_BLOCK;
    let i = 0;
    while (i < lines.length) {
      let best: { len: number; srcTurn: number; anchor: string; foldedSrc: boolean } | undefined;
      const key = anchorKey(lines[i]);
      if (key && extendBudget > 0 && (index.get(key) ?? []).length > 0) {
        for (const cand of (index.get(key) ?? []).slice(0, MAX_ANCHORS_PER_LINE)) {
          if (extendBudget <= 0) break;
          if (cand.turn === t || foldedTurn[cand.turn]) continue;
          const src = blockLines[cand.turn];
          let len = 0;
          while (
            i + len < lines.length &&
            cand.line + len < src.length &&
            lines[i + len] === src[cand.line + len] &&
            len < 500
          ) {
            len++;
          }
          extendBudget -= len + 1;
          if (len >= MIN_LINES) {
            const chars = lines.slice(i, i + len).join(eol).length;
            const foldedSrc = false;
            if (chars >= MIN_CHARS && isBetter(len, cand.turn, foldedSrc, best)) {
              best = { len, srcTurn: cand.turn, anchor: lines[i].trim().slice(0, 60), foldedSrc };
            }
          }
        }
      }
      if (best) {
        folded.push(`[↑${best.len}L same as msg ${best.srcTurn}: '${best.anchor}']`);
        i += best.len;
      } else {
        folded.push(lines[i]);
        i++;
      }
    }
    const candidate = folded.join(eol);
    if (candidate.length < blocks[t].text.length) {
      out[t] = candidate;
      foldedTurn[t] = true;
    }
    if (!blocks[t].protect) {
      for (let ln = 0; ln < lines.length; ln++) {
        const k = anchorKey(lines[ln]);
        if (!k) continue;
        const arr = index.get(k) ?? [];
        if (arr.length < MAX_ANCHORS_PER_LINE) arr.push({ turn: t, line: ln });
        index.set(k, arr);
      }
    }
  }
  return out;
}