import * as dns from "node:dns/promises";
import * as net from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
const MAX_REDIRECTS = 5;
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;
function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) || a >= 224;
}
function expandIpv6(value: string): number[] | undefined {
  const parts = value.split("::");
  if (parts.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const out: number[] = [];
    for (const h of side.split(":")) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
        const bytes = h.split(".").map(Number);
        if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return undefined;
        out.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(h)) {
        out.push(parseInt(h, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = parseSide(parts[0]);
  const tail = parseSide(parts[1] ?? "");
  if (!head || !tail || head.length + tail.length > 8) return undefined;
  if (parts.length === 1 && head.length !== 8) return undefined;
  const zeros = new Array(8 - head.length - tail.length).fill(0);
  return [...head, ...zeros, ...tail];
}
function privateIpv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0];
  const hextets = expandIpv6(value);
  if (!hextets) return true;
  const isZero = hextets.every((h) => h === 0);
  if (isZero) return true;
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true;
  const first = hextets[0];
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && hextets[1] === 0x0db8) return true;
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return privateIpv4(`${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`);
  }
  return false;
}
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  return family === 4 ? privateIpv4(address) : family === 6 ? privateIpv6(address) : true;
}
export interface UrlPolicy {
  allowPrivate?: boolean;
  allowHttpLoopback?: boolean;
  sameOrigin?: string;
}
export function normalizeProviderBaseUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new Error("Provider base URL is empty.");
  if (/[\s<>\"'\\]/.test(trimmed)) throw new Error("Provider base URL contains invalid characters.");
  const withScheme = /:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Provider base URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Provider URL scheme '${url.protocol}' is not allowed.`);
  if (url.username || url.password) throw new Error("Provider URL userinfo is not allowed.");
  if (!url.hostname) throw new Error("Provider base URL is missing a hostname.");
  return withScheme.replace(/\/+$/, "");
}
export async function assertSafeUrl(raw: string | URL, policy: UrlPolicy = {}): Promise<URL> {
  const url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
  await resolveAndCheck(url, policy);
  return url;
}
async function resolveAndCheck(url: URL, policy: UrlPolicy): Promise<string[]> {
  if (url.username || url.password) throw new Error("URL userinfo is not allowed.");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`URL scheme '${url.protocol}' is not allowed.`);
  if (policy.sameOrigin && url.origin !== new URL(policy.sameOrigin).origin) throw new Error(`Cross-origin endpoint is not allowed: ${url.origin}`);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  const hasPrivate = literal.some(isPrivateAddress);
  if (hasPrivate && !policy.allowPrivate) throw new Error(`Private or reserved network destination is blocked: ${url.hostname}`);
  if (url.protocol === "http:" && !(policy.allowHttpLoopback && literal.every((address) => address === "127.0.0.1" || address === "::1"))) {
    throw new Error("Plain HTTP is allowed only for an explicitly permitted loopback service.");
  }
  return literal;
}
function pinnedDispatcher(addresses: string[]): unknown {
  try {
    const { Agent } = require("undici") as { Agent?: new (opts: unknown) => unknown };
    if (typeof Agent !== "function") return undefined;
    const lookup = (_hostname: string, opts: { all?: boolean }, cb: (err: null, address: string | { address: string; family: number }[], family?: number) => void): void => {
      if (opts?.all) {
        cb(null, addresses.map((address) => ({ address, family: net.isIP(address) })));
        return;
      }
      const pick = addresses[0];
      cb(null, pick, net.isIP(pick) === 6 ? 6 : 4);
    };
    return new Agent({ connect: { lookup } });
  } catch {
    return undefined;
  }
}
export async function safeFetch(raw: string | URL, init: RequestInit = {}, policy: UrlPolicy = {}): Promise<Response> {
  let url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
  let addresses = await resolveAndCheck(url, policy);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = "dispatcher" in init
      ? await fetch(url, { ...init, redirect: "manual" })
      : await pinnedRequest(url, init, addresses);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new Error("Redirect response is missing Location.");
    if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects.");
    url = new URL(location, url);
    addresses = await resolveAndCheck(url, policy);
  }
  throw new Error("Too many redirects.");
}
function pinnedLookup(addresses: string[]): (hostname: string, opts: { all?: boolean }, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => void {
  let cursor = 0;
  return (_hostname, opts, cb) => {
    if (opts?.all) {
      cb(null, addresses.map((address) => ({ address, family: net.isIP(address) })));
      return;
    }
    if (cursor >= addresses.length) {
      cb(new Error(`All ${addresses.length} resolved addresses failed.`), "", 4);
      return;
    }
    const pick = addresses[cursor++];
    cb(null, pick, net.isIP(pick) === 6 ? 6 : 4);
  };
}
async function pinnedRequest(url: URL, init: RequestInit, addresses: string[]): Promise<Response> {
  const dispatcher = pinnedDispatcher(addresses);
  if (dispatcher) return fetch(url, { ...init, redirect: "manual", dispatcher } as RequestInit);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  return new Promise<Response>((resolve, reject) => {
    const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = lib(
      url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: pinnedLookup(addresses) as never,
      },
      (res) => {
        const outHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headersDistinct ?? {})) {
          for (const item of (Array.isArray(v) ? v : [v]) as (string | undefined)[]) {
            if (item !== undefined) outHeaders.append(k, item);
          }
        }
        const code = res.statusCode ?? 200;
        const body = code === 204 || code === 304 ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        resolve(new Response(body, {
          status: code,
          statusText: res.statusMessage ?? "",
          headers: outHeaders,
        }));
      },
    );
    req.on("error", reject);
    const onAbort = (): void => {
      req.destroy(new DOMException("The operation was aborted.", "AbortError"));
    };
    init.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => init.signal?.removeEventListener("abort", onAbort));
    const body = init.body as unknown;
    if (typeof body === "string" || body instanceof Uint8Array) {
      req.write(body as string | Uint8Array);
    } else if (body instanceof ArrayBuffer) {
      req.write(Buffer.from(body));
    } else if (body !== undefined && body !== null) {
      req.destroy();
      reject(new Error("safeFetch: unsupported body type for direct transport."));
      return;
    }
    req.end();
  });
}
export async function readBodyLimited(response: Response, maxBytes = MAX_HTTP_BODY_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`HTTP response exceeded ${maxBytes} bytes.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}