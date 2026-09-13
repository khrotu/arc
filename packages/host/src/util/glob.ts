const MAX_EXPANSIONS = 256;
const regexCache = new Map<string, RegExp>();
export function expandBraces(pattern: string): string[] {
  let open = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") { open = i; break; }
  }
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const parts: string[] = [];
  const inner = pattern.slice(open + 1, close);
  let start = 0;
  depth = 0;
  const alts: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      alts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  alts.push(inner.slice(start));
  for (const alt of alts) {
    for (const expanded of expandBraces(head + alt + tail)) {
      parts.push(expanded);
      if (parts.length >= MAX_EXPANSIONS) return parts;
    }
  }
  return parts;
}
export function globToRegExpSource(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      re += next === "*" || next === "?" || next === "[" || next === "]" || next === "{" || next === "}" || next === "\\"
        ? `\\${next}`
        : `\\\\${next}`;
      i++;
      continue;
    }
    if (c === "{") {
      let depth = 1;
      let j = i + 1;
      for (; j < pattern.length; j++) {
        const d = pattern[j];
        if (d === "\\") { j++; continue; }
        if (d === "{") depth++;
        else if (d === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j >= pattern.length) {
        re += "\\{";
        continue;
      }
      const inner = pattern.slice(i + 1, j);
      const alts: string[] = [];
      let start = 0;
      depth = 0;
      for (let k = 0; k < inner.length; k++) {
        const d = inner[k];
        if (d === "\\") { k++; continue; }
        if (d === "{") depth++;
        else if (d === "}") depth--;
        else if (d === "," && depth === 0) {
          alts.push(inner.slice(start, k));
          start = k + 1;
        }
      }
      alts.push(inner.slice(start));
      re += `(?:${alts.map(globToRegExpSource).join("|")})`;
      i = j;
      continue;
    }
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (pattern[j] === "!" || pattern[j] === "^") { cls += "^"; j++; }
      if (pattern[j] === "]") { cls += "\\]"; j++; }
      let closed = false;
      for (; j < pattern.length; j++) {
        const d = pattern[j];
        if (d === "\\" && j + 1 < pattern.length) { cls += `\\${pattern[j + 1]}`; j++; continue; }
        if (d === "]") { closed = true; break; }
        cls += d;
      }
      if (!closed) {
        re += "\\[";
        continue;
      }
      re += `${cls}]`;
      i = j;
      continue;
    }
    if ("^$.|.+(){} ".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return re;
}
export function globToRegExp(pattern: string): RegExp {
  const hit = regexCache.get(pattern);
  if (hit) return hit;
  const re = new RegExp(`^${globToRegExpSource(pattern)}$`);
  if (regexCache.size > 1000) regexCache.clear();
  regexCache.set(pattern, re);
  return re;
}
export function matchAnyGlob(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(path)) return true;
  }
  return false;
}