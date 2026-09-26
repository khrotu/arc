import { describe, it, expect } from "vitest";
import { exaSearch, firecrawlSearch, normalizeWebSearchBackend, parallelSearch, parseExaResults, parseFirecrawlResults, parseParallelResults, parseTavilyResults, searchWithApiBackend, tavilySearch } from "../src/websearch/websearch";
import { tools } from "../src/agent/tools";
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
describe("normalizeWebSearchBackend", () => {
  it("accepts known backends and defaults to builtin", () => {
    expect(normalizeWebSearchBackend("exa")).toBe("exa");
    expect(normalizeWebSearchBackend("firecrawl")).toBe("firecrawl");
    expect(normalizeWebSearchBackend("parallel")).toBe("parallel");
    expect(normalizeWebSearchBackend("tavily")).toBe("tavily");
    expect(normalizeWebSearchBackend(undefined)).toBe("builtin");
    expect(normalizeWebSearchBackend("google")).toBe("builtin");
  });
});
describe("parseExaResults", () => {
  it("maps text content and falls back to highlights", () => {
    const out = parseExaResults({ results: [
      { title: "A", url: "https://a.example/", text: "body text" },
      { title: "B", url: "https://b.example/", highlights: ["h1", "h2"] },
      { title: "", url: "https://c.example/" },
      { title: "D", url: "not-a-url" },
    ] });
    expect(out).toEqual([
      { title: "A", snippet: "body text", url: "https://a.example/" },
      { title: "B", snippet: "h1 h2", url: "https://b.example/" },
    ]);
  });
  it("returns empty for malformed payloads", () => {
    expect(parseExaResults(undefined)).toEqual([]);
    expect(parseExaResults({ results: "nope" })).toEqual([]);
  });
});
describe("parseFirecrawlResults", () => {
  it("reads v2 data.web shape", () => {
    const out = parseFirecrawlResults({ success: true, data: { web: [{ title: "A", url: "https://a.example/", description: "desc" }] } });
    expect(out).toEqual([{ title: "A", snippet: "desc", url: "https://a.example/" }]);
  });
  it("reads v1 data array shape", () => {
    const out = parseFirecrawlResults({ success: true, data: [{ title: "A", url: "https://a.example/", description: "desc" }] });
    expect(out).toHaveLength(1);
  });
});
describe("parseParallelResults", () => {
  it("joins excerpt arrays and falls back to excerpt string", () => {
    const out = parseParallelResults({ results: [
      { title: "A", url: "https://a.example/", excerpts: ["one", "two"] },
      { title: "B", url: "https://b.example/", excerpt: "single" },
    ] });
    expect(out).toEqual([
      { title: "A", snippet: "one two", url: "https://a.example/" },
      { title: "B", snippet: "single", url: "https://b.example/" },
    ]);
  });
});
describe("parseTavilyResults", () => {
  it("maps content snippets", () => {
    const out = parseTavilyResults({ results: [{ title: "A", url: "https://a.example/", content: "snippet here" }] });
    expect(out).toEqual([{ title: "A", snippet: "snippet here", url: "https://a.example/" }]);
  });
});
describe("backend requests", () => {
  it("exa posts query with x-api-key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ results: [{ title: "A", url: "https://a.example/", text: "t" }] });
    }) as unknown as typeof fetch;
    const out = await exaSearch("q", 5, { apiKey: "k", fetchImpl });
    expect(seen!.url).toBe("https://api.exa.ai/search");
    expect((seen!.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ query: "q", numResults: 5 });
    expect(out).toHaveLength(1);
  });
  it("tavily uses bearer auth and max_results", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ results: [] });
    }) as unknown as typeof fetch;
    await tavilySearch("q", 7, { apiKey: "k", fetchImpl });
    expect(seen!.url).toBe("https://api.tavily.com/search");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ query: "q", max_results: 7 });
  });
  it("firecrawl uses v2 endpoint with bearer auth", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ success: true, data: { web: [] } });
    }) as unknown as typeof fetch;
    await firecrawlSearch("q", 4, { apiKey: "k", fetchImpl });
    expect(seen!.url).toBe("https://api.firecrawl.dev/v2/search");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ query: "q", limit: 4 });
  });
  it("parallel uses v1 endpoint with x-api-key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ results: [] });
    }) as unknown as typeof fetch;
    await parallelSearch("q", 6, { apiKey: "k", fetchImpl });
    expect(seen!.url).toBe("https://api.parallel.ai/v1/search");
    expect((seen!.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ search_queries: ["q"] });
  });
  it("searchWithApiBackend routes and surfaces HTTP errors", async () => {
    const okImpl = (async () => jsonResponse({ results: [{ title: "A", url: "https://a.example/", content: "s" }] })) as unknown as typeof fetch;
    expect(await searchWithApiBackend("tavily", "q", 3, { apiKey: "k", fetchImpl: okImpl })).toHaveLength(1);
    const badImpl = (async () => jsonResponse({ message: "bad key" }, 401)) as unknown as typeof fetch;
    await expect(searchWithApiBackend("tavily", "q", 3, { apiKey: "bad", fetchImpl: badImpl })).rejects.toThrow("401");
  });
});
describe("web.search tool", () => {
  it("errors with setup guidance when the API backend has no key", async () => {
    const res = await tools["web.search"].fn({ query: "hello" }, { root: ".", approvalsConfig: {}, sessionApprovals: {}, workspacePath: ".", webSearchBackend: "exa" } as never);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("Exa");
    expect(res.output).toContain("API key");
  });
  it("rejects empty queries", async () => {
    const res = await tools["web.search"].fn({ query: "  " }, { root: ".", approvalsConfig: {}, sessionApprovals: {}, workspacePath: "." } as never);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("No query");
  });
});