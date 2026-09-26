import { readBodyLimited } from "../security/network.js";
export type WebSearchBackendId = "builtin" | "exa" | "firecrawl" | "parallel" | "tavily";
export interface ApiSearchResult { title: string; snippet: string; url: string; }
export interface BackendCallOpts { apiKey: string; signal?: AbortSignal; dispatcher?: unknown; fetchImpl?: typeof fetch; }
const BACKEND_TIMEOUT_MS = 25_000;
export function normalizeWebSearchBackend(v: unknown): WebSearchBackendId {
  if (v === "exa" || v === "firecrawl" || v === "parallel" || v === "tavily") return v;
  return "builtin";
}
export const WEB_SEARCH_BACKEND_LABELS: Record<Exclude<WebSearchBackendId, "builtin">, { label: string; keyUrl: string }> = {
  exa: { label: "Exa", keyUrl: "https://dashboard.exa.ai/api-keys" },
  firecrawl: { label: "Firecrawl", keyUrl: "https://www.firecrawl.dev/app/api-keys" },
  parallel: { label: "Parallel", keyUrl: "https://platform.parallel.ai/api-keys" },
  tavily: { label: "Tavily", keyUrl: "https://app.tavily.com/home" },
};
function backendSignal(outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(BACKEND_TIMEOUT_MS);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function clipSnippet(s: string, max = 1200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
async function postJson(url: string, headers: Record<string, string>, body: unknown, opts: BackendCallOpts): Promise<unknown> {
  const impl = opts.fetchImpl ?? fetch;
  const res = await impl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: backendSignal(opts.signal),
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  } as RequestInit);
  const text = await readBodyLimited(res, 2 * 1024 * 1024);
  const json = (() => { try { return JSON.parse(text) as unknown; } catch { return undefined; } })();
  if (!res.ok) {
    const detail = asRecord(json)?.message ?? asRecord(json)?.error ?? text.slice(0, 200);
    throw new Error(`HTTP ${res.status}${typeof detail === "string" && detail ? `: ${detail}` : ""}`);
  }
  return json;
}
export function parseExaResults(json: unknown): ApiSearchResult[] {
  const results = asRecord(json)?.results;
  if (!Array.isArray(results)) return [];
  const out: ApiSearchResult[] = [];
  for (const item of results) {
    const r = asRecord(item);
    if (!r) continue;
    const title = asString(r.title).trim();
    const url = asString(r.url).trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const highlights = Array.isArray(r.highlights) ? r.highlights.filter((h): h is string => typeof h === "string") : [];
    const snippet = clipSnippet(asString(r.text) || highlights.join(" ") || asString(r.summary));
    out.push({ title, snippet, url });
  }
  return out;
}
export async function exaSearch(query: string, max: number, opts: BackendCallOpts): Promise<ApiSearchResult[]> {
  const json = await postJson("https://api.exa.ai/search", { "x-api-key": opts.apiKey }, { query, numResults: max, type: "auto", contents: { text: { maxCharacters: 1200 } } }, opts);
  return parseExaResults(json);
}
export function parseFirecrawlResults(json: unknown): ApiSearchResult[] {
  const data = asRecord(json)?.data;
  const list = Array.isArray(data) ? data : asRecord(data)?.web;
  if (!Array.isArray(list)) return [];
  const out: ApiSearchResult[] = [];
  for (const item of list) {
    const r = asRecord(item);
    if (!r) continue;
    const title = asString(r.title).trim();
    const url = asString(r.url).trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, snippet: clipSnippet(asString(r.description) || asString(r.markdown)), url });
  }
  return out;
}
export async function firecrawlSearch(query: string, max: number, opts: BackendCallOpts): Promise<ApiSearchResult[]> {
  const json = await postJson("https://api.firecrawl.dev/v2/search", { Authorization: `Bearer ${opts.apiKey}` }, { query, limit: max }, opts);
  return parseFirecrawlResults(json);
}
export function parseParallelResults(json: unknown): ApiSearchResult[] {
  const results = asRecord(json)?.results;
  if (!Array.isArray(results)) return [];
  const out: ApiSearchResult[] = [];
  for (const item of results) {
    const r = asRecord(item);
    if (!r) continue;
    const title = asString(r.title).trim();
    const url = asString(r.url).trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const excerpts = Array.isArray(r.excerpts) ? r.excerpts.filter((e): e is string => typeof e === "string").join(" ") : "";
    const snippet = clipSnippet(excerpts || asString(r.excerpt) || asString(r.snippet));
    out.push({ title, snippet, url });
  }
  return out;
}
export async function parallelSearch(query: string, max: number, opts: BackendCallOpts): Promise<ApiSearchResult[]> {
  const json = await postJson("https://api.parallel.ai/v1/search", { "x-api-key": opts.apiKey }, { objective: query, search_queries: [query], mode: "basic", max_chars_total: 12000, advanced_settings: { max_results: max, excerpt_settings: { max_chars_per_result: 1500 } } }, opts);
  return parseParallelResults(json);
}
export function parseTavilyResults(json: unknown): ApiSearchResult[] {
  const results = asRecord(json)?.results;
  if (!Array.isArray(results)) return [];
  const out: ApiSearchResult[] = [];
  for (const item of results) {
    const r = asRecord(item);
    if (!r) continue;
    const title = asString(r.title).trim();
    const url = asString(r.url).trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, snippet: clipSnippet(asString(r.content)), url });
  }
  return out;
}
export async function tavilySearch(query: string, max: number, opts: BackendCallOpts): Promise<ApiSearchResult[]> {
  const json = await postJson("https://api.tavily.com/search", { Authorization: `Bearer ${opts.apiKey}` }, { query, max_results: max, search_depth: "basic", include_answer: false }, opts);
  return parseTavilyResults(json);
}
export async function searchWithApiBackend(backend: Exclude<WebSearchBackendId, "builtin">, query: string, max: number, opts: BackendCallOpts): Promise<ApiSearchResult[]> {
  if (backend === "exa") return exaSearch(query, max, opts);
  if (backend === "firecrawl") return firecrawlSearch(query, max, opts);
  if (backend === "parallel") return parallelSearch(query, max, opts);
  return tavilySearch(query, max, opts);
}