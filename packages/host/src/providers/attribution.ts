import type { ProviderKind } from "../protocol/protocol.js";
import { createHash, randomBytes } from "node:crypto";
export interface AppIdentity {
  url: string;
  title: string;
  version: string;
  categories?: string[];
}
export const APP_VERSION: string = process.env.ARC_VERSION || "0.0.0-dev";
export const APP: AppIdentity = {
  url: "https://github.com/khrotu/arc",
  title: "Arc",
  version: APP_VERSION,
  categories: ["ide-extension"],
};
const UA = (a: AppIdentity): Record<string, string> => ({
  "user-agent": `${a.title}/${a.version} (+${a.url})`,
});
const OR = (a: AppIdentity): Record<string, string> => ({
  "x-title": a.title,
});
const OR_DIALECT = new Set<ProviderKind>([
  "poe",
  "zenmux",
  "requesty",
  "orcarouter",
  "fastrouter",
  "anyapi",
  "unorouter",
]);
const OPENCODE_HOSTS = new Set(["opencode.ai"]);
export const OPENCODE_VER_DEFAULT = "2.0.15";
export let OPENCODE_VER = OPENCODE_VER_DEFAULT;
export let OPENCODE_UA = `opencode/latest/${OPENCODE_VER}/cli`;
export const OPENCODE_CLIENT = "cli";
export function setOpencodeVer(ver: string): void {
  if (!ver) return;
  OPENCODE_VER = ver;
  OPENCODE_UA = `opencode/latest/${ver}/cli`;
}
export function isOpencodeEndpoint(baseUrl: string | undefined, kind: ProviderKind): boolean {
  if (kind === "opencode" || kind === "opencode-go") return true;
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    if (OPENCODE_HOSTS.has(host) || host.endsWith(".opencode.ai")) return true;
    const path = url.pathname.toLowerCase();
    if (path.includes("/zen/") || path.includes("/zen") || path.includes("/go/v1")) return true;
    return false;
  } catch {
    const lower = baseUrl.toLowerCase();
    return lower.includes("opencode.ai") || lower.includes("/zen/") || lower.includes("/go/v1");
  }
}
const OPENCODE_ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let opencodeIdCounter = 0;
let opencodeIdLastTs = 0;
function opencodeRandomSuffix(digest: Uint8Array, offset: number): string {
  let suffix = "";
  for (let i = 0; i < 14; i++) suffix += OPENCODE_ID_CHARS[digest[offset + i] % 62];
  return suffix;
}
const opencodeSessionIds = new Map<string, string>();
function nextOpencodeCounter(now: number): number {
  if (now !== opencodeIdLastTs) {
    opencodeIdLastTs = now;
    opencodeIdCounter = 0;
  }
  opencodeIdCounter++;
  return opencodeIdCounter;
}
function opencodeTimeHex(now: number, counter: number): string {
  const n = BigInt(now) * BigInt(0x1000) + BigInt(counter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) timeBytes[i] = Number((n >> BigInt(40 - 8 * i)) & BigInt(0xff));
  return timeBytes.toString("hex");
}
export function opencodeMessageId(now: number = Date.now()): string {
  return `msg_${opencodeTimeHex(now, nextOpencodeCounter(now))}${opencodeRandomSuffix(randomBytes(14), 0)}`;
}
export function opencodeSessionId(conversationId: string): string {
  const cached = opencodeSessionIds.get(conversationId);
  if (cached) return cached;
  const now = Date.now();
  const id = `ses_${opencodeTimeHex(now, nextOpencodeCounter(now))}${opencodeRandomSuffix(randomBytes(14), 0)}`;
  if (opencodeSessionIds.size >= 500) {
    const oldest = opencodeSessionIds.keys().next().value as string | undefined;
    if (oldest !== undefined) opencodeSessionIds.delete(oldest);
  }
  opencodeSessionIds.set(conversationId, id);
  return id;
}
export function opencodeProjectId(workspaceRoot: string): string {
  const digest = createHash("sha256").update(`arc-opencode-project:${workspaceRoot}`).digest();
  return `${digest.subarray(0, 6).toString("hex")}${opencodeRandomSuffix(digest, 6)}`;
}
export function opencodeSessionHeader(baseUrl: string | undefined, kind: ProviderKind, conversationId: string | undefined, requestId?: string, projectRoot?: string): Record<string, string> {
  if (!isOpencodeEndpoint(baseUrl, kind)) return {};
  const out: Record<string, string> = {
    "user-agent": OPENCODE_UA,
    "x-opencode-client": OPENCODE_CLIENT,
  };
  if (projectRoot) out["x-opencode-project"] = opencodeProjectId(projectRoot);
  if (conversationId) {
    const session = opencodeSessionId(conversationId);
    out["x-opencode-session"] = session;
    out["x-session-affinity"] = session;
    out["x-session-id"] = session;
  }
  out["x-opencode-request"] = requestId || opencodeMessageId();
  return out;
}
export function attributionHeaders(kind: ProviderKind, a: AppIdentity = APP): Record<string, string> {
  switch (kind) {
    case "openrouter":
      return {
        ...UA(a),
        "http-referer": a.url,
        "x-openrouter-title": a.title,
        ...(a.categories?.length ? { "x-openrouter-categories": a.categories.join(",") } : {}),
      };
    case "vercel":
      return { ...UA(a), "http-referer": a.url, "x-title": a.title };
    case "llmgateway":
      return { ...UA(a), ...OR(a), "x-source": new URL(a.url).host };
    case "github-copilot":
      return {
        "copilot-integration-id": "copilot-developer-cli",
        "editor-version": `${a.title}/${a.version}`,
        "editor-plugin-version": `${a.title}/${a.version}`,
        "user-agent": `${a.title}/${a.version}`,
      };
    case "cohere":
      return { ...UA(a), "x-client-name": a.title };
    case "cerebras":
      return { ...UA(a), "x-cerebras-3rd-party-integration": a.title.toLowerCase() };
    case "perplexity":
    case "perplexity-agent":
      return { ...UA(a), "x-pplx-integration": `${a.title.toLowerCase()}/${a.version}` };
    case "google":
    case "gcp-vertex":
      return { ...UA(a), "x-goog-api-client": `${a.title.toLowerCase()}/${a.version}` };
    case "kilo-gateway":
      return { ...UA(a), "x-kilocode-feature": a.title.toLowerCase(), "x-kilocode-version": a.version };
    case "huggingface":
      return { ...UA(a), ...(process.env.HF_BILL_TO ? { "x-hf-bill-to": process.env.HF_BILL_TO } : {}) };
    case "helicone":
      return { ...UA(a), "helicone-property-app": a.title, "helicone-property-version": a.version };
    case "inference":
      return { ...UA(a), "x-inference-metadata-app": a.title, "x-inference-metadata-version": a.version };
    case "portkey":
      return { ...UA(a), "x-portkey-metadata": JSON.stringify({ _environment: "production", app: a.title }) };
    case "litellm-proxy":
      return { ...UA(a), "x-litellm-tags": `app:${a.title.toLowerCase()}` };
    case "trustedrouter":
      return { ...UA(a), ...OR(a) };
    case "opencode":
    case "opencode-go":
      return { "user-agent": OPENCODE_UA };
    default:
      if (OR_DIALECT.has(kind)) return { ...UA(a), ...OR(a) };
      if (kind === "anthropic") return UA(a);
      return UA(a);
  }
}