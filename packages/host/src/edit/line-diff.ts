export interface LineChange {
  added?: boolean;
  removed?: boolean;
  value: string;
  count: number;
  oldStart?: number;
  newStart?: number;
}
function splitLines(value: string): string[] {
  if (!value) return [];
  const lines = value.match(/.*?(?:\r\n|\n|$)/g) ?? [];
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
export function diffLines(before: string, after: string): LineChange[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  if (!oldLines.length && !newLines.length) return [{ value: "", count: 0 }];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const removed = oldLines.slice(prefix, oldEnd);
  const added = newLines.slice(prefix, newEnd);
  const result: LineChange[] = [];
  const push = (change: Omit<LineChange, "count"> & { count?: number }) => {
    const count = change.count ?? splitLines(change.value).length;
    const last = result[result.length - 1];
    if (last && last.added === change.added && last.removed === change.removed) {
      last.value += change.value;
      last.count += count;
    } else result.push({ ...change, count });
  };
  if (prefix) push({ value: oldLines.slice(0, prefix).join("") });
  if (!removed.length) {
    if (added.length) push({ added: true, value: added.join("") });
  } else if (!added.length) {
    push({ removed: true, value: removed.join("") });
  } else if (removed.length * added.length > 4_000_000) {
    push({ removed: true, value: removed.join("") });
    push({ added: true, value: added.join("") });
  } else {
    const backtracks = traceback(removed, added);
    let oldIndex = 0;
    let newIndex = 0;
    for (const [nextOld, nextNew] of backtracks) {
      if (nextOld > oldIndex) push({ removed: true, value: removed.slice(oldIndex, nextOld).join("") });
      if (nextNew > newIndex) push({ added: true, value: added.slice(newIndex, nextNew).join("") });
      if (nextOld < removed.length && nextNew < added.length) push({ value: removed[nextOld] });
      oldIndex = nextOld + 1;
      newIndex = nextNew + 1;
    }
  }
  if (oldEnd < oldLines.length) push({ value: oldLines.slice(oldEnd).join("") });
  let oldAt = 1;
  let newAt = 1;
  for (const h of result) {
    h.oldStart = oldAt;
    h.newStart = newAt;
    if (h.removed || (!h.added && !h.removed)) oldAt += h.count;
    if (h.added || (!h.added && !h.removed)) newAt += h.count;
  }
  return result;
}
function traceback(oldLines: string[], newLines: string[]): [number, number][] {
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const max = oldLines.length + newLines.length;
  const table = new Int32Array(rows * cols);
  for (let x = 0; x <= oldLines.length; x++) {
    for (let y = Math.min(newLines.length, max - x); y >= 0; y--) {
      const up = y > 0 ? table[x * cols + y - 1] : 0;
      const diagonal = x > 0 && y > 0 && oldLines[x - 1] === newLines[y - 1] ? table[(x - 1) * cols + y - 1] + 1 : 0;
      const left = x > 0 ? table[(x - 1) * cols + y] : 0;
      table[x * cols + y] = diagonal > up && diagonal > left ? diagonal : Math.max(up, left);
    }
  }
  const path: [number, number][] = [];
  let x = oldLines.length;
  let y = newLines.length;
  while (x > 0 || y > 0) {
    if (x > 0 && y > 0 && oldLines[x - 1] === newLines[y - 1] && table[x * cols + y] === table[(x - 1) * cols + y - 1] + 1) path.push([x - 1, y - 1]), x--, y--;
    else if (x > 0 && (y === 0 || table[(x - 1) * cols + y] >= table[x * cols + y - 1])) x--;
    else y--;
  }
  return path.reverse();
}