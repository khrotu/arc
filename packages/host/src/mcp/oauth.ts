import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeFetch, readBodyLimited, assertSafeUrl } from "../security/network.js";
import type { McpOAuthTokens } from "./client.js";
export interface OAuthClientInfo {
  clientId: string;
  clientSecret?: string;
}
export interface OAuthFlowOptions {
  serverUrl: string;
  wwwAuthenticate?: string;
  openExternal: (url: string) => Promise<void>;
  scopes?: string[];
  timeoutMs?: number;
}
export interface OAuthFlowResult {
  tokens: McpOAuthTokens;
  client: OAuthClientInfo;
  tokenEndpoint: string;
  scopes?: string;
}
interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}
interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}
function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function parseWwwAuthenticate(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = header.slice(header.indexOf(" ") + 1);
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params))) out[m[1].toLowerCase()] = m[2];
  return out;
}
async function fetchJson(url: string, sameOrigin?: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await safeFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }, sameOrigin ? { sameOrigin } : {});
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const text = await readBodyLimited(res, 1024 * 1024);
    const json = JSON.parse(text);
    return json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
function wellKnownCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const origin = url.origin;
  const out: string[] = [];
  if (path) out.push(`${origin}/.well-known/oauth-authorization-server${path}`);
  out.push(`${origin}/.well-known/oauth-authorization-server`);
  if (path) out.push(`${origin}/.well-known/openid-configuration${path}`);
  out.push(`${origin}/.well-known/openid-configuration`);
  return out;
}
export async function discoverAuthorizationServer(serverUrl: string, wwwAuthenticate?: string): Promise<{ metadata: AuthServerMetadata; issuer: string } | undefined> {
  let issuer: string | undefined;
  let resourceScopes: string[] | undefined;
  if (wwwAuthenticate) {
    const params = parseWwwAuthenticate(wwwAuthenticate);
    const resourceMeta = params["resource_metadata"];
    if (resourceMeta) {
      const meta = await fetchJson(resourceMeta) as ProtectedResourceMetadata | undefined;
      issuer = meta?.authorization_servers?.[0];
      resourceScopes = meta?.scopes_supported;
    }
  }
  if (!issuer) issuer = new URL(serverUrl).origin;
  try {
    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  for (const candidate of wellKnownCandidates(issuer)) {
    const metadata = await fetchJson(candidate) as AuthServerMetadata | undefined;
    if (metadata?.authorization_endpoint && metadata.token_endpoint) {
      try {
        const authUrl = new URL(String(metadata.authorization_endpoint));
        const tokenUrl = new URL(String(metadata.token_endpoint));
        if (authUrl.protocol !== "https:" || tokenUrl.protocol !== "https:") continue;
      } catch {
        continue;
      }
      return { metadata: { ...metadata, scopes_supported: resourceScopes ?? metadata.scopes_supported }, issuer };
    }
  }
  return undefined;
}
export async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<OAuthClientInfo> {
  const res = await safeFetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Arc",
      client_uri: "https://github.com/khrotu/arc",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Dynamic client registration failed (HTTP ${res.status}).`);
  const json = JSON.parse(await readBodyLimited(res, 1024 * 1024)) as Record<string, unknown>;
  const clientId = typeof json.client_id === "string" ? json.client_id : undefined;
  if (!clientId) throw new Error("Dynamic client registration returned no client_id.");
  return { clientId, clientSecret: typeof json.client_secret === "string" ? json.client_secret : undefined };
}
export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
export async function runAuthorizationFlow(opts: OAuthFlowOptions): Promise<OAuthFlowResult> {
  const discovered = await discoverAuthorizationServer(opts.serverUrl, opts.wwwAuthenticate);
  if (!discovered) throw new Error("Could not discover OAuth authorization server metadata for this MCP server.");
  const { metadata } = discovered;
  const server: http.Server = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  let client: OAuthClientInfo | undefined;
  if (metadata.registration_endpoint) {
    try {
      const regUrl = new URL(String(metadata.registration_endpoint));
      if (regUrl.protocol !== "https:") throw new Error("registration endpoint must use https");
      await assertSafeUrl(regUrl);
    } catch (e) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw e instanceof Error ? e : new Error("Invalid registration endpoint.");
    }
    client = await registerClient(metadata.registration_endpoint, redirectUri).catch(() => undefined);
  }
  if (!client) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("MCP OAuth requires dynamic client registration, which the authorization server does not support.");
  }
  const state = base64Url(crypto.randomBytes(16));
  const { verifier, challenge } = pkce();
  const resource = new URL(opts.serverUrl).origin;
  const scopes = opts.scopes ?? metadata.scopes_supported;
  const authUrl = new URL(metadata.authorization_endpoint!);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  if (scopes?.length) authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", resource);
  const codePromise = new Promise<string>((resolve, reject) => {
    let settled = false;
    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      if (settled) {
        res.writeHead(410, { "content-type": "text/plain" });
        res.end("Authorization already completed.");
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found.");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body style="font-family:sans-serif;background:#1e1e1e;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh"><p>${error ? `Authorization failed: ${esc(error)}` : "Authorization complete. You can close this tab."}</p></body></html>`);
      if (error) {
        settled = true;
        reject(new Error(`Authorization failed: ${error} (${url.searchParams.get("error_description") ?? ""})`));
      } else if (url.searchParams.get("state") !== state) {
        settled = true;
        reject(new Error("OAuth state mismatch."));
      } else if (code) {
        settled = true;
        resolve(code);
      } else {
        settled = true;
        reject(new Error("Authorization callback contained no code."));
      }
    });
  });
  await opts.openExternal(authUrl.toString());
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out waiting for OAuth authorization.")), timeoutMs);
  });
  try {
    const code = await Promise.race([codePromise, timeout]);
    const tokens = await exchangeCode({
      tokenEndpoint: metadata.token_endpoint!,
      code,
      redirectUri,
      client,
      verifier,
      resource,
    });
    return { tokens, client, tokenEndpoint: metadata.token_endpoint!, scopes: scopes?.join(" ") };
  } finally {
    if (timer) clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
export async function exchangeCode(args: { tokenEndpoint: string; code: string; redirectUri: string; client: OAuthClientInfo; verifier: string; resource?: string }): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.client.clientId,
    code_verifier: args.verifier,
  });
  if (args.client.clientSecret) body.set("client_secret", args.client.clientSecret);
  if (args.resource) body.set("resource", args.resource);
  return tokenRequest(args.tokenEndpoint, body);
}
export async function refreshTokens(args: { tokenEndpoint: string; refreshToken: string; client: OAuthClientInfo; resource?: string }): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.client.clientId,
  });
  if (args.client.clientSecret) body.set("client_secret", args.client.clientSecret);
  if (args.resource) body.set("resource", args.resource);
  return tokenRequest(args.tokenEndpoint, body);
}
async function tokenRequest(endpoint: string, body: URLSearchParams): Promise<McpOAuthTokens> {
  const res = await safeFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await readBodyLimited(res, 1024 * 1024);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch {}
  if (!res.ok || typeof json.access_token !== "string") {
    throw new Error(`Token request failed (HTTP ${res.status}): ${String(json.error ?? text.slice(0, 200))}`);
  }
  const tokens: McpOAuthTokens = { accessToken: json.access_token };
  if (typeof json.refresh_token === "string") tokens.refreshToken = json.refresh_token;
  if (typeof json.expires_in === "number") tokens.expiresAt = Date.now() + json.expires_in * 1000;
  return tokens;
}