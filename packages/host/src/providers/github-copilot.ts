import { createHash } from "node:crypto";
import { APP } from "./attribution.js";
import { makeProxyDispatcher } from "../util/proxy.js";
import { readBodyLimited } from "../security/network.js";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
export const COPILOT_API_VERSION = "2025-04-01";
const TOKEN_SKEW_MS = 60_000;
const FALLBACK_TTL_MS = 20 * 60_000;
interface CachedToken {
  token: string;
  expiresAtMs: number;
}
const tokenCache = new Map<string, CachedToken>();
const tokenInflight = new Map<string, Promise<string>>();
function fingerprint(token: string): string {
  try {
    return createHash("sha256").update(token).digest("hex").slice(0, 16);
  } catch {
    return `len${token.length}`;
  }
}
function newRequestId(): string {
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function isExchangedCopilotToken(token: string): boolean {
  const t = token.trim();
  if (/^tid:/i.test(t)) return true;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) return true;
  return false;
}
export function clearCopilotTokenCache(): void {
  tokenCache.clear();
  tokenInflight.clear();
}
const TOKEN_GUIDANCE =
  "Provide a valid GitHub token with Copilot access: an OAuth token (gho_/ghu_), " +
  "a fine-grained PAT with the Copilot Requests permission, or a PAT with the copilot scope.";
export async function getCopilotBearerToken(
  githubToken: string | undefined,
  opts: { proxyUrl?: string } = {},
): Promise<string> {
  const key = (githubToken ?? "").trim();
  if (!key) throw new Error(`GitHub Copilot is missing its GitHub token. ${TOKEN_GUIDANCE}`);
  if (isExchangedCopilotToken(key)) return key;
  const fp = fingerprint(key);
  const cached = tokenCache.get(fp);
  if (cached && Date.now() < cached.expiresAtMs - TOKEN_SKEW_MS) return cached.token;
  const pending = tokenInflight.get(fp);
  if (pending) return pending;
  let taskRef: Promise<string> | undefined;
  const task = (async () => {
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "editor-version": `${APP.title}/${APP.version}`,
        "editor-plugin-version": `${APP.title}/${APP.version}`,
        "user-agent": `${APP.title}/${APP.version}`,
        "x-github-api-version": COPILOT_API_VERSION,
      };
      const init: RequestInit = {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      };
      if (opts.proxyUrl) {
        try {
          (init as Record<string, unknown>).dispatcher = makeProxyDispatcher(opts.proxyUrl);
        } catch {}
      }
      let res: Response;
      try {
        res = await fetch(COPILOT_TOKEN_URL, init);
      } catch (e) {
        throw new Error(`GitHub Copilot token exchange failed: ${(e as Error)?.message ?? e}. ${TOKEN_GUIDANCE}`);
      }
      if (!res.ok) {
        const body = await readBodyLimited(res, 8 * 1024).catch(() => "");
        const hint =
          res.status === 401 || res.status === 403
            ? " The GitHub token is invalid/expired, lacks Copilot access, or has no Copilot subscription."
            : "";
        throw new Error(
          `GitHub Copilot token exchange failed (HTTP ${res.status}).${hint} ${TOKEN_GUIDANCE}` +
            (body ? ` Upstream: ${body.slice(0, 300)}` : ""),
        );
      }
      const data = (await res.json().catch(() => undefined)) as
        | { token?: unknown; expires_at?: unknown; refresh_in?: unknown }
        | undefined;
      const token = typeof data?.token === "string" ? data.token.trim() : "";
      if (!token) throw new Error(`GitHub Copilot token exchange returned no token. ${TOKEN_GUIDANCE}`);
      const now = Date.now();
      const expAt = typeof data?.expires_at === "number" && Number.isFinite(data.expires_at) ? data.expires_at * 1000 : NaN;
      const refreshIn = typeof data?.refresh_in === "number" && Number.isFinite(data.refresh_in) ? data.refresh_in * 1000 : NaN;
      const expiresAtMs = Number.isFinite(expAt)
        ? Number.isFinite(refreshIn)
          ? Math.min(expAt, now + refreshIn)
          : expAt
        : Number.isFinite(refreshIn)
          ? now + refreshIn
          : now + FALLBACK_TTL_MS;
      tokenCache.set(fp, { token, expiresAtMs });
      while (tokenCache.size > 50) {
        const oldest = tokenCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        tokenCache.delete(oldest);
      }
      return token;
    } finally {
      if (tokenInflight.get(fp) === taskRef) tokenInflight.delete(fp);
    }
  })();
  taskRef = task;
  tokenInflight.set(fp, task);
  return task;
}
export function copilotRequestHeaders(opts: {
  vision?: boolean;
  agentCall?: boolean;
  requestId?: string;
} = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "openai-intent": "conversation-panel",
    "x-github-api-version": COPILOT_API_VERSION,
    "x-request-id": opts.requestId || newRequestId(),
    "x-initiator": opts.agentCall ? "agent" : "user",
  };
  if (opts.vision) headers["copilot-vision-request"] = "true";
  return headers;
}
export function isAgentCall(messages: { role: string }[]): boolean {
  return messages.some((m) => m.role === "assistant" || m.role === "tool");
}
export function hasImageContent(messages: { images?: unknown }[]): boolean {
  return messages.some((m) => Array.isArray((m as { images?: unknown }).images) && ((m as { images?: unknown[] }).images?.length ?? 0) > 0);
}