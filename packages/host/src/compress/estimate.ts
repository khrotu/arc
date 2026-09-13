const CJK_RE =
  /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af]/g;
const URL_RE = /https?:\/\/[^\s]+/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CHARS_PER_TOKEN_PROSE = 4;
const CHARS_PER_TOKEN_JSON = 5.5;
const CHARS_PER_TOKEN_CODE = 3.6;
function looksJson(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  if (text.length < 256 * 1024) {
    try {
      JSON.parse(text);
      return true;
    } catch {}
  }
  const keyColons = (text.match(/":/g) ?? []).length;
  if (keyColons > text.length / 500) return true;
  const braces = (t.match(/[{}[\]]/g) ?? []).length;
  return braces > text.length / 200;
}
function looksCode(text: string): boolean {
  if (!text.includes("\n") || !/[{};]/.test(text)) return false;
  const markers = (text.match(/(function|class|import|export|def |fn |const |let |var |=>|::|#include)/g) ?? []).length;
  return markers >= 3;
}
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const cjkUnits = (text.match(CJK_RE) ?? []).length;
  const astral = (text.match(/[\uD800-\uDBFF]/g) ?? []).length;
  const cjk = cjkUnits + astral;
  const nonCjk = text.length - cjkUnits - astral * 2;
  let charsPerToken = CHARS_PER_TOKEN_PROSE;
  if (looksJson(text)) charsPerToken = CHARS_PER_TOKEN_JSON;
  else if (looksCode(text)) charsPerToken = CHARS_PER_TOKEN_CODE;
  let tokens = nonCjk / charsPerToken + cjk; 
  tokens += ((text.match(URL_RE) ?? []).length * 8) / charsPerToken;
  tokens += (text.match(UUID_RE) ?? []).length * 2;
  tokens += 4;
  return Math.max(1, Math.ceil(tokens));
}
export function estimateSavedTokens(before: string, after: string): number {
  return Math.max(0, estimateTokenCount(before) - estimateTokenCount(after));
}