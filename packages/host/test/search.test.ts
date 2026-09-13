import { describe, it, expect } from "vitest";
import { HashEmbeddingBackend, hashEmbed } from "../src/search/hash-backend";
import { VectorIndex } from "../src/search/vector-index";
import { chunkText } from "../src/search/indexer";
import { OllamaEmbeddingBackend } from "../src/search/ollama-backend";
describe("HashEmbeddingBackend", () => {
  it("returns unit-length vectors", async () => {
    const be = new HashEmbeddingBackend(64);
    const [v] = await be.embed({ model: "test", input: "hello world" });
    expect(v.dim).toBe(64);
    const norm = Math.sqrt(v.values.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
  it("returns similar vectors for similar inputs", async () => {
    const be = new HashEmbeddingBackend(128);
    const [a] = await be.embed({ model: "test", input: "the quick brown fox" });
    const [b] = await be.embed({ model: "test", input: "the quick brown fox jumps" });
    let dot = 0;
    for (let i = 0; i < a.values.length; i++) dot += a.values[i] * b.values[i];
    expect(dot).toBeGreaterThan(0.3);
  });
  it("returns different vectors for unrelated inputs", async () => {
    const be = new HashEmbeddingBackend(128);
    const [a] = await be.embed({ model: "test", input: "the quick brown fox" });
    const [b] = await be.embed({ model: "test", input: "strawberry banana smoothie recipe" });
    let dot = 0;
    for (let i = 0; i < a.values.length; i++) dot += a.values[i] * b.values[i];
    expect(dot).toBeLessThan(0.5);
  });
  it("hashEmbed returns zero vector for empty input", () => {
    const v = hashEmbed("", 8);
    expect(v.values.every((x) => x === 0)).toBe(true);
  });
});
describe("VectorIndex", () => {
  it("returns nearest neighbors by cosine similarity", () => {
    const idx = new VectorIndex();
    const a = { id: "a", vector: [1, 0, 0], meta: { file: "a.ts" } };
    const b = { id: "b", vector: [0, 1, 0], meta: { file: "b.ts" } };
    const c = { id: "c", vector: [0.9, 0.1, 0], meta: { file: "c.ts" } };
    idx.add(a);
    idx.add(b);
    idx.add(c);
    const hits = idx.search({ values: [1, 0, 0], dim: 3 }, 2);
    expect(hits[0].id).toBe("a");
    expect(hits[1].id).toBe("c");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });
  it("removes records", () => {
    const idx = new VectorIndex();
    idx.add({ id: "x", vector: [1, 0], meta: {} });
    expect(idx.size()).toBe(1);
    idx.remove("x");
    expect(idx.size()).toBe(0);
  });
  it("returns empty results for empty index", () => {
    const idx = new VectorIndex();
    const hits = idx.search({ values: [1, 0, 0], dim: 3 }, 5);
    expect(hits).toEqual([]);
  });
});
describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const { chunks: c, truncated } = chunkText("hello world");
    expect(truncated).toBe(false);
    expect(c.length).toBe(1);
    expect(c[0].start).toBe(0);
    expect(c[0].end).toBe("hello world".length);
  });
  it("splits long text into overlapping chunks", () => {
    const long = "x".repeat(4000);
    const { chunks: c, truncated } = chunkText(long, { maxChunkChars: 1500, overlapChars: 200 });
    expect(truncated).toBe(false);
    expect(c.length).toBeGreaterThan(1);
    expect(c[0].text.length).toBeLessThanOrEqual(1500);
    expect(c[c.length - 1].end).toBe(long.length);
  });
  it("flags truncation when the chunk cap is hit", () => {
    const long = "x".repeat(100_000);
    const { chunks: c, truncated } = chunkText(long, { maxChunkChars: 64, overlapChars: 0 });
    expect(truncated).toBe(true);
    expect(c.length).toBe(512);
  });
});
describe("OllamaEmbeddingBackend", () => {
  it("parses a successful embeddings response", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = init?.body ? String(init.body) : "";
      expect(body).toContain("nomic-embed-text:v1.5");
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const be = new OllamaEmbeddingBackend("nomic-embed-text:v1.5", { baseUrl: "http://127.0.0.1:11434" });
      const [v] = await be.embed({ model: "nomic-embed-text:v1.5", input: "hello" });
      expect(v.dim).toBe(4);
      expect(v.values).toEqual([0.1, 0.2, 0.3, 0.4]);
    } finally {
      globalThis.fetch = real;
    }
  });
  it("surfaces non-OK responses as errors", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;
    try {
      const be = new OllamaEmbeddingBackend("missing-model", { baseUrl: "http://127.0.0.1:11434" });
      await expect(be.embed({ model: "missing-model", input: "hello" })).rejects.toThrow(/404/);
    } finally {
      globalThis.fetch = real;
    }
  });
});