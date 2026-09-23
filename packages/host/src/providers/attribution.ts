import type { ProviderKind } from "../protocol/protocol.js";
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
export const OPENCODE_VER_DEFAULT = "1.18.31";
export let OPENCODE_VER = OPENCODE_VER_DEFAULT;
export let OPENCODE_UA = `opencode/${OPENCODE_VER}`;
export const OPENCODE_CLIENT = "cli";
export function setOpencodeVer(ver: string): void {
  if (!ver) return;
  OPENCODE_VER = ver;
  OPENCODE_UA = `opencode/${ver}`;
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
function newOpencodeRequestId(): string {
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
export function opencodeSessionHeader(baseUrl: string | undefined, kind: ProviderKind, conversationId: string | undefined, requestId?: string): Record<string, string> {
  if (!isOpencodeEndpoint(baseUrl, kind)) return {};
  const out: Record<string, string> = {
    "user-agent": OPENCODE_UA,
    "x-opencode-client": OPENCODE_CLIENT,
  };
  if (conversationId) out["x-opencode-session"] = conversationId;
  out["x-opencode-request"] = requestId || newOpencodeRequestId();
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