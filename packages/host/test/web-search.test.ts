import { describe, it, expect, vi, afterEach } from "vitest";
import {
  tools,
  decodeHtml,
  parseHtmlResults,
  parseYahooResults,
  parseHnResults,
  parseWikiResults,
  dedupeSearchResults,
} from "../src/agent/tools";
const ctx = {
  root: process.cwd(),
  workspacePath: process.cwd(),
  sandboxProfile: undefined,
  proxyShell: undefined,
  proxyUrl: undefined,
  requestApproval: async () => true,
} as any;
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("decodeHtml", () => {
  it("strips tags and decodes common entities", () => {
    expect(decodeHtml("<b>Fish &amp; Chips</b>")).toBe("Fish & Chips");
    expect(decodeHtml("a &lt;b&gt; &quot;q&quot; &#39;x&#39;")).toBe('a <b> "q" \'x\'');
  });
  it("decodes decimal and hex numeric entities instead of dropping them", () => {
    expect(decodeHtml("caf&#233;")).toBe("café");
    expect(decodeHtml("caf&#xE9;")).toBe("café");
    expect(decodeHtml("a&nbsp;&nbsp;b")).toBe("a b");
  });
});
describe("parseHtmlResults", () => {
  it("keeps results that have no snippet anchor", () => {
    const html = `
      <div class="result__body"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsolo&amp;rut=y">Solo Title</a></h2></div>`;
    expect(parseHtmlResults(html, 10)).toEqual([{ title: "Solo Title", snippet: "", url: "https://example.com/solo" }]);
  });
  it("pairs titles with snippets in order", () => {
    const html = `
      <a class="result__a" href="https://a.com/1">One</a>
      <a class="result__a" href="https://b.com/2">Two</a>
      <a class="result__snippet" href="https://a.com/1">snip one</a>
      <a class="result__snippet" href="https://b.com/2">snip two</a>`;
    const out = parseHtmlResults(html, 10);
    expect(out).toHaveLength(2);
    expect(out[0].snippet).toBe("snip one");
    expect(out[1].snippet).toBe("snip two");
  });
  it("returns [] on CAPTCHA pages", () => {
    expect(parseHtmlResults('<div class="anomaly-modal">challenge</div><a class="result__a" href="https://x.com/">X</a>', 10)).toEqual([]);
  });
});
describe("parseYahooResults", () => {
  it("unwraps RU redirect targets and pairs snippets", () => {
    const html = `
      <div class="dd fst algo algo-sr Sr"><div class="compTitle"><a target="_blank" href="https://r.search.yahoo.com/_ylt=abc;_ylu=def/RV=2/RE=1/RO=10/RU=https%3a%2f%2fexample.com%2fpage/RK=2/RS=x"><h3 class="title"><span>Example Page</span></h3></a></div><div class="compText"><p class="fz-14">example snippet <b>here</b></p></div></div>
      <div class="Sr"><a href="https://search.yahoo.com/search?p=related">related searches</a></div>`;
    expect(parseYahooResults(html, 10)).toEqual([
      { title: "Example Page", snippet: "example snippet here", url: "https://example.com/page" },
    ]);
  });
  it("returns [] when no RU links exist", () => {
    expect(parseYahooResults("<html><body>no results</body></html>", 5)).toEqual([]);
  });
});
describe("parseHnResults", () => {
  it("maps hits with url fallback to the HN item page", () => {
    const json = {
      hits: [
        { title: "TypeScript 5.9", url: "https://devblogs.microsoft.com/x", author: "soheilpro", points: 7, objectID: "1" },
        { title: null, story_title: "Ask HN: X?", url: null, author: "pg", points: 3, objectID: "2" },
        { title: "", url: "https://example.com/", objectID: "3" },
      ],
    };
    expect(parseHnResults(json, 10)).toEqual([
      { title: "TypeScript 5.9", snippet: "7 points by soheilpro", url: "https://devblogs.microsoft.com/x" },
      { title: "Ask HN: X?", snippet: "3 points by pg", url: "https://news.ycombinator.com/item?id=2" },
    ]);
  });
  it("returns [] for malformed payloads", () => {
    expect(parseHnResults(null, 5)).toEqual([]);
    expect(parseHnResults({ hits: "nope" }, 5)).toEqual([]);
  });
});
describe("parseWikiResults", () => {
  it("maps opensearch tuples", () => {
    const json = ["q", ["Alpha", "Beta"], ["desc a", "desc b"], ["https://en.wikipedia.org/wiki/Alpha", "https://en.wikipedia.org/wiki/Beta"]];
    expect(parseWikiResults(json, 10)).toEqual([
      { title: "Alpha", snippet: "desc a", url: "https://en.wikipedia.org/wiki/Alpha" },
      { title: "Beta", snippet: "desc b", url: "https://en.wikipedia.org/wiki/Beta" },
    ]);
  });
});
describe("dedupeSearchResults", () => {
  it("drops case/trailing-slash duplicate URLs", () => {
    const out = dedupeSearchResults([
      { title: "A", snippet: "", url: "https://Example.com/x/" },
      { title: "B", snippet: "", url: "https://example.com/x" },
      { title: "C", snippet: "", url: "https://example.com/y" },
    ]);
    expect(out.map((r) => r.title)).toEqual(["A", "C"]);
  });
});
describe("web.search tool", () => {
  it("rejects an empty query without fetching", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await tools["web.search"].fn({ query: "   " }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("No query");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("walks the chain (ddg-html, ddg-main, yahoo) before Wikipedia", async () => {
    const emptyHtml = new Response("<html><body>no results here</body></html>", { status: 200 });
    const yahoo = new Response(
      `<div class="dd algo Sr"><div class="compTitle"><a href="https://r.search.yahoo.com/_ylt=x/RV=2/RU=https%3a%2f%2ffound.example.com%2fp/RK=2/RS=y"><h3 class="title"><span>Found It</span></h3></a></div><div class="compText"><p>via yahoo</p></div></div>`,
      { status: 200 },
    );
    const calls: string[] = [];
    const fetchMock = vi.fn((url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("html.duckduckgo.com")) return Promise.resolve(emptyHtml.clone());
      if (u.includes("duckduckgo.com/html")) return Promise.resolve(emptyHtml.clone());
      if (u.includes("search.yahoo.com")) return Promise.resolve(yahoo.clone());
      return Promise.resolve(new Response("[]", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await tools["web.search"].fn({ query: "obscure topic", count: 5 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Found It");
    expect(r.output).toContain("https://found.example.com/p");
    expect(calls.some((u) => u.includes("html.duckduckgo.com"))).toBe(true);
    expect(calls.some((u) => u.includes("duckduckgo.com/html"))).toBe(true);
    expect(calls.some((u) => u.includes("wikipedia.org"))).toBe(false);
  });
  it("reaches Wikipedia when all web backends return nothing", async () => {
    const emptyHtml = new Response("<html><body>no results here</body></html>", { status: 200 });
    const wiki = new Response(
      JSON.stringify(["obscure topic", ["Found It"], ["via wiki"], ["https://en.wikipedia.org/wiki/Found_It"]]),
      { status: 200 },
    );
    const fetchMock = vi.fn((url: unknown) => {
      const u = String(url);
      if (u.includes("duckduckgo.com")) return Promise.resolve(emptyHtml.clone());
      if (u.includes("search.yahoo.com")) return Promise.resolve(emptyHtml.clone());
      if (u.includes("hn.algolia.com")) return Promise.resolve(new Response(JSON.stringify({ hits: [] }), { status: 200 }));
      if (u.includes("wikipedia.org")) return Promise.resolve(wiki.clone());
      return Promise.resolve(new Response("[]", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await tools["web.search"].fn({ query: "obscure topic", count: 5 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("https://en.wikipedia.org/wiki/Found_It");
  });
  it("retries a transient 503 then succeeds", async () => {
    const html = `<a rel="nofollow" class="result__a" href="https://retry.example.com/ok">Retry Win</a>`;
    const fail503 = new Response("busy", { status: 503 });
    const okHtml = new Response(html, { status: 200 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fail503)
      .mockResolvedValueOnce(okHtml);
    vi.stubGlobal("fetch", fetchMock);
    const r = await tools["web.search"].fn({ query: "retry me" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Retry Win");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("clamps invalid counts and still searches", async () => {
    const html = `<a class="result__a" href="https://clamp.example.com/">Clamped</a>`;
    const fetchMock = vi.fn(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await tools["web.search"].fn({ query: "q", count: "not-a-number" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Clamped");
  });
});