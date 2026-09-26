export interface DomainModelJson {
  v: number;
  vocab: Record<string, number>;
  idf: string; 
  classes: string[];
  coefs: string[]; 
  intercepts: number[];
  sublinearTf?: boolean;
  norm?: string;
}
export interface DomainModel {
  vocab: Record<string, number>;
  idf: Float32Array;
  classes: string[];
  coefs: Float32Array[];
  intercepts: number[];
  tokenRe: RegExp;
}
function decodeF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
export function loadDomainModel(json: DomainModelJson): DomainModel {
  if (!json || typeof json !== "object") throw new Error("Invalid domain model: not an object.");
  if (!json.vocab || typeof json.vocab !== "object") throw new Error("Invalid domain model: bad vocab.");
  if (!Array.isArray(json.classes) || json.classes.length === 0) throw new Error("Invalid domain model: bad classes.");
  if (!Array.isArray(json.coefs) || json.coefs.length !== json.classes.length) throw new Error("Invalid domain model: bad coefs.");
  if (!Array.isArray(json.intercepts) || json.intercepts.length !== json.classes.length || !json.intercepts.every(Number.isFinite)) {
    throw new Error("Invalid domain model: bad intercepts.");
  }
  const idf = decodeF32(json.idf);
  if (idf.length === 0) throw new Error("Invalid domain model: empty idf.");
  const vocabSize = Object.keys(json.vocab).length;
  if (vocabSize !== idf.length) throw new Error("Invalid domain model: vocab/idf size mismatch.");
  for (const idx of Object.values(json.vocab)) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= idf.length) throw new Error("Invalid domain model: vocab index out of range.");
  }
  const coefs = json.coefs.map((c) => decodeF32(c));
  for (const coef of coefs) {
    if (coef.length !== idf.length) throw new Error("Invalid domain model: coef length mismatch.");
  }
  return {
    vocab: json.vocab,
    idf,
    classes: json.classes,
    coefs,
    intercepts: json.intercepts,
    tokenRe: /\b\w\w+\b/g,
  };
}
function tokenize(text: string, re: RegExp): string[] {
  return text.toLowerCase().match(re) ?? [];
}
function ngrams(tokens: string[]): string[] {
  const out = tokens.slice();
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}
function transform(text: string, m: DomainModel): Float64Array {
  const tokens = ngrams(tokenize(text, m.tokenRe));
  const counts = new Map<number, number>();
  for (const g of tokens) {
    const j = m.vocab[g];
    if (j !== undefined) counts.set(j, (counts.get(j) ?? 0) + 1);
  }
  const n = m.idf.length;
  const raw = new Float64Array(n);
  for (const [j, c] of counts) {
    const tf = 1.0 + Math.log(c);
    raw[j] = tf * m.idf[j];
  }
  let norm = 0;
  for (let i = 0; i < n; i++) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) raw[i] /= norm;
  return raw;
}
export function classifyDomain(text: string, m: DomainModel): string {
  const x = transform(text, m);
  let bestClass = m.classes[0] ?? "general";
  let bestScore = -Infinity;
  for (let c = 0; c < m.classes.length; c++) {
    const coef = m.coefs[c];
    let s = m.intercepts[c] ?? 0;
    for (let i = 0; i < x.length; i++) s += coef[i] * x[i];
    if (s > bestScore) {
      bestScore = s;
      bestClass = m.classes[c];
    }
  }
  return bestClass;
}
export function domainScores(text: string, m: DomainModel): Record<string, number> {
  const x = transform(text, m);
  const out: Record<string, number> = {};
  for (let c = 0; c < m.classes.length; c++) {
    const coef = m.coefs[c];
    let s = m.intercepts[c] ?? 0;
    for (let i = 0; i < x.length; i++) s += coef[i] * x[i];
    out[m.classes[c]] = s;
  }
  return out;
}