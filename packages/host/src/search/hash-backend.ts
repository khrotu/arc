import type { EmbeddingBackend, EmbeddingRequest, EmbeddingVector } from "./backend.js";
export class HashEmbeddingBackend implements EmbeddingBackend {
  readonly id = "hash";
  readonly dim: number;
  constructor(dim = 256, readonly model = "hash-256") {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`Invalid embedding dim: ${dim}`);
    this.dim = dim;
  }
  async embed(req: EmbeddingRequest): Promise<EmbeddingVector[]> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return inputs.map((text) => hashEmbed(text, this.dim));
  }
}
export function hashEmbed(text: string, dim: number): EmbeddingVector {
  const values = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return { values, dim };
  for (const tok of tokens) {
    const h1 = fnv1a(tok);
    const h2 = fnv1a(tok + "\x00salt");
    const idx = Math.abs(h1) % dim;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    values[idx] += sign * (1 + (Math.abs(h2) % 5) / 5);
  }
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) values[i] /= norm;
  return { values, dim };
}
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 1);
}
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}