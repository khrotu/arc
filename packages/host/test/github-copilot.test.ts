import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCopilotBearerToken,
  copilotRequestHeaders,
  isAgentCall,
  hasImageContent,
  clearCopilotTokenCache,
  COPILOT_API_VERSION,
} from "../src/providers/github-copilot";
const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
function tokenResponse(token: string, expiresAtSec: number, refreshInSec?: number): Response {
  return new Response(JSON.stringify({ token, expires_at: expiresAtSec, refresh_in: refreshInSec }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
describe("getCopilotBearerToken", () => {
  beforeEach(() => {
    clearCopilotTokenCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCopilotTokenCache();
  });
  it("throws actionable guidance when the GitHub token is missing", async () => {
    await expect(getCopilotBearerToken(undefined)).rejects.toThrow(/missing its GitHub token/);
    await expect(getCopilotBearerToken("  ")).rejects.toThrow(/OAuth token/);
  });
  it("passes through already-exchanged Copilot tokens without a network call", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse("unused", 9999999999)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCopilotBearerToken("tid:abc123")).resolves.toBe("tid:abc123");
    await expect(
      getCopilotBearerToken("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"),
    ).resolves.toContain("eyJ");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("exchanges a GitHub token and caches the bearer", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse("copilot-bearer-1", 9999999999, 1800)));
    vi.stubGlobal("fetch", fetchMock);
    const first = await getCopilotBearerToken("gho_testtoken123");
    expect(first).toBe("copilot-bearer-1");
    const second = await getCopilotBearerToken("gho_testtoken123");
    expect(second).toBe("copilot-bearer-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gho_testtoken123");
    expect(headers["x-github-api-version"]).toBe(COPILOT_API_VERSION);
  });
  it("refetches once the cached token is expired", async () => {
    const past = Math.floor(Date.now() / 1000) - 120;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("stale-bearer", past))
      .mockResolvedValueOnce(tokenResponse("fresh-bearer", 9999999999, 1800));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCopilotBearerToken("gho_expiring")).resolves.toBe("stale-bearer");
    await expect(getCopilotBearerToken("gho_expiring")).resolves.toBe("fresh-bearer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("dedupes concurrent exchanges for the same token", async () => {
    let resolveFetch: ((r: Response) => void) | undefined;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => gate);
    vi.stubGlobal("fetch", fetchMock);
    const a = getCopilotBearerToken("gho_concurrent");
    const b = getCopilotBearerToken("gho_concurrent");
    resolveFetch!(tokenResponse("shared-bearer", 9999999999, 1800));
    await expect(a).resolves.toBe("shared-bearer");
    await expect(b).resolves.toBe("shared-bearer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("throws a helpful error without leaking the token on 401", async () => {
    const secret = "gho_super_secret_token_xyz";
    const fetchMock = vi.fn(() => Promise.resolve(new Response("Bad credentials", { status: 401 })));
    vi.stubGlobal("fetch", fetchMock);
    const err = await getCopilotBearerToken(secret).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("HTTP 401");
    expect(err.message).toContain("Copilot");
    expect(err.message).not.toContain(secret);
  });
  it("throws when the exchange returns no token", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCopilotBearerToken("gho_empty")).rejects.toThrow(/no token/);
  });
});
describe("copilotRequestHeaders", () => {
  it("emits required per-request headers with a user initiator by default", () => {
    const h = copilotRequestHeaders();
    expect(h["openai-intent"]).toBe("conversation-panel");
    expect(h["x-github-api-version"]).toBe(COPILOT_API_VERSION);
    expect(h["x-initiator"]).toBe("user");
    expect(typeof h["x-request-id"]).toBe("string");
    expect(h["x-request-id"].length).toBeGreaterThan(0);
    expect(h["copilot-vision-request"]).toBeUndefined();
  });
  it("marks agent calls and vision requests", () => {
    expect(copilotRequestHeaders({ agentCall: true })["x-initiator"]).toBe("agent");
    expect(copilotRequestHeaders({ vision: true })["copilot-vision-request"]).toBe("true");
    expect(copilotRequestHeaders({ requestId: "req-1" })["x-request-id"]).toBe("req-1");
  });
});
describe("copilot message helpers", () => {
  it("detects agent calls from assistant/tool roles", () => {
    expect(isAgentCall([{ role: "user" }])).toBe(false);
    expect(isAgentCall([{ role: "user" }, { role: "assistant" }])).toBe(true);
    expect(isAgentCall([{ role: "tool" }])).toBe(true);
  });
  it("detects image content", () => {
    expect(hasImageContent([{ role: "user" }])).toBe(false);
    expect(hasImageContent([{ role: "user", images: [] }])).toBe(false);
    expect(hasImageContent([{ role: "user", images: [{ type: "image_url" }] }])).toBe(true);
  });
});