import type { EmbeddingBackend, EmbeddingRequest, EmbeddingVector } from "./backend.js";
import { readBodyLimited } from "../security/network.js";
export interface OllamaEmbeddingOptions {
  baseUrl?: string;
  signal?: AbortSignal;
}
export class OllamaEmbeddingBackend implements EmbeddingBackend {
  readonly id = "ollama";
  readonly dim: number;
  constructor(readonly model: string, private opts: OllamaEmbeddingOptions = {}) {
    this.dim = knownDims[model] ?? 768;
  }
  async embed(req: EmbeddingRequest): Promise<EmbeddingVector[]> {
    const base = (this.opts.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const out: EmbeddingVector[] = [];
    for (const text of inputs) {
      const res = await fetch(`${base}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: req.model || this.model, prompt: text }),
        signal: this.opts.signal ?? AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await readBodyLimited(res).catch((error) => (error as Error).message);
        throw new Error(`Ollama embedding returned ${res.status}: ${body.slice(0, 200)}`);
      }
      const j = JSON.parse(await readBodyLimited(res)) as { embedding?: number[] };
      if (!j.embedding) throw new Error(`Ollama embedding response missing 'embedding' field.`);
      out.push({ values: j.embedding, dim: j.embedding.length });
    }
    if (out.length > 0) (this as { dim: number }).dim = out[0].dim;
    return out;
  }
}
const knownDims: Record<string, number> = {
  "nomic-embed-text:v1.5": 768,
  "qwen3-embedding:0.6b": 1024,
  "qwen3-embedding:8b": 4096,
};
export const DEFAULT_EMBEDDING_MODELS: Record<"low" | "mid" | "high", string> = {
  low: "nomic-embed-text:v1.5",
  mid: "qwen3-embedding:0.6b",
  high: "qwen3-embedding:8b",
};