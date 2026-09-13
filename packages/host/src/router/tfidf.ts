export interface DifficultyFold {
  coef: number[];
  intercept: number;
  sigmoidA: number;
  sigmoidB: number;
}
export interface DifficultyModel {
  vocab: Record<string, number>;
  idf: number[];
  folds: DifficultyFold[];
  weakScore: number;
  strongScore: number;
}
export function loadDifficultyModel(json: DifficultyModel): DifficultyModel {
  if (!json || typeof json !== "object") throw new Error("Invalid difficulty model: not an object.");
  if (!json.vocab || typeof json.vocab !== "object") throw new Error("Invalid difficulty model: bad vocab.");
  if (!Array.isArray(json.idf) || json.idf.length === 0 || !json.idf.every(Number.isFinite)) {
    throw new Error("Invalid difficulty model: bad idf.");
  }
  if (!Array.isArray(json.folds) || json.folds.length === 0) throw new Error("Invalid difficulty model: bad folds.");
  const vocabSize = Object.keys(json.vocab).length;
  for (const [term, idx] of Object.entries(json.vocab)) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= json.idf.length) {
      throw new Error(`Invalid difficulty model: vocab index out of range for '${term}'.`);
    }
  }
  if (vocabSize !== json.idf.length) throw new Error("Invalid difficulty model: vocab/idf size mismatch.");
  for (const fold of json.folds) {
    if (!fold || !Array.isArray(fold.coef) || fold.coef.length !== json.idf.length || !fold.coef.every(Number.isFinite)) {
      throw new Error("Invalid difficulty model: bad fold coefficients.");
    }
    if (!Number.isFinite(fold.intercept) || !Number.isFinite(fold.sigmoidA) || !Number.isFinite(fold.sigmoidB)) {
      throw new Error("Invalid difficulty model: bad fold parameters.");
    }
  }
  if (!Number.isFinite(json.weakScore) || !Number.isFinite(json.strongScore)) throw new Error("Invalid difficulty model: bad scores.");
  return json;
}
const TOKEN_RE = /\b\w\w+\b/g;
export function tokenize(text: string): string[] {
  const t = text.toLowerCase();
  return t.match(TOKEN_RE) ?? [];
}
function ngrams(tokens: string[]): string[] {
  const out: string[] = tokens.slice();
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}
export function transformDocument(text: string, model: DifficultyModel): number[] {
  const tokens = tokenize(text);
  const counts = new Map<number, number>();
  for (const g of ngrams(tokens)) {
    const j = model.vocab[g];
    if (j !== undefined) counts.set(j, (counts.get(j) ?? 0) + 1);
  }
  const n = model.idf.length;
  const raw = new Float64Array(n);
  for (const [j, c] of counts) {
    const tf = 1.0 + Math.log(c); 
    raw[j] = tf * model.idf[j];
  }
  let norm = 0;
  for (let i = 0; i < n; i++) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = raw[i] / norm;
  return Array.from(out);
}
export function estimateDifficulty(text: string, model: DifficultyModel): number {
  const x = transformDocument(text, model);
  let sum = 0;
  for (const f of model.folds) {
    let dec = f.intercept;
    for (let i = 0; i < x.length; i++) dec += f.coef[i] * x[i];
    sum += 1.0 / (1.0 + Math.exp(f.sigmoidA * dec + f.sigmoidB));
  }
  return sum / model.folds.length;
}