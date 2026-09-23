import { describe, it, expect } from "vitest";
import { attributionHeaders, opencodeSessionHeader, isOpencodeEndpoint, APP_VERSION, OPENCODE_UA, OPENCODE_CLIENT, OPENCODE_VER_DEFAULT, setOpencodeVer } from "../src/providers/attribution";
describe("attribution headers", () => {
  it("sends the OpenRouter dialect for openrouter with its own title header", () => {
    const h = attributionHeaders("openrouter");
    expect(h["http-referer"]).toBe("https://github.com/khrotu/arc");
    expect(h["x-openrouter-title"]).toBe("Arc");
    expect(h["x-openrouter-categories"]).toBe("ide-extension");
    expect(h["user-agent"]).toBe(`Arc/${APP_VERSION} (+https://github.com/khrotu/arc)`);
  });
  it("sends X-Title without HTTP-Referer for OpenRouter-dialect routers", () => {
    for (const kind of ["poe", "zenmux", "requesty", "orcarouter", "fastrouter", "anyapi", "unorouter"] as const) {
      const h = attributionHeaders(kind);
      expect(h["http-referer"]).toBeUndefined();
      expect(h["x-title"]).toBe("Arc");
    }
  });
  it("sends lowercase referer/title for Vercel", () => {
    const h = attributionHeaders("vercel");
    expect(h["http-referer"]).toBe("https://github.com/khrotu/arc");
    expect(h["x-title"]).toBe("Arc");
  });
  it("adds X-Source for LLM Gateway", () => {
    const h = attributionHeaders("llmgateway");
    expect(h["x-source"]).toBe("github.com");
    expect(h["x-title"]).toBe("Arc");
  });
  it("sends mandatory Copilot headers for github-copilot", () => {
    const h = attributionHeaders("github-copilot");
    expect(h["copilot-integration-id"]).toBe("copilot-developer-cli");
    expect(h["editor-version"]).toBe(`Arc/${APP_VERSION}`);
    expect(h["user-agent"]).toBe(`Arc/${APP_VERSION}`);
  });
  it("sends vendor-prefixed integration headers", () => {
    expect(attributionHeaders("cohere")["x-client-name"]).toBe("Arc");
    expect(attributionHeaders("cerebras")["x-cerebras-3rd-party-integration"]).toBe("arc");
    expect(attributionHeaders("perplexity")["x-pplx-integration"]).toBe(`arc/${APP_VERSION}`);
    expect(attributionHeaders("perplexity-agent")["x-pplx-integration"]).toBe(`arc/${APP_VERSION}`);
    expect(attributionHeaders("google")["x-goog-api-client"]).toBe(`arc/${APP_VERSION}`);
    expect(attributionHeaders("gcp-vertex")["x-goog-api-client"]).toBe(`arc/${APP_VERSION}`);
    expect(attributionHeaders("kilo-gateway")["x-kilocode-feature"]).toBe("arc");
    expect(attributionHeaders("helicone")["helicone-property-app"]).toBe("Arc");
    expect(attributionHeaders("inference")["x-inference-metadata-app"]).toBe("Arc");
    expect(attributionHeaders("portkey")["x-portkey-metadata"]).toContain("Arc");
    expect(attributionHeaders("litellm-proxy")["x-litellm-tags"]).toBe("app:arc");
  });
  it("always includes a descriptive user-agent and the safe default set", () => {
    for (const kind of ["openai", "deepseek", "mistral", "groq", "xai", "anthropic"] as const) {
      const h = attributionHeaders(kind);
      expect(h["user-agent"]).toBe(`Arc/${APP_VERSION} (+https://github.com/khrotu/arc)`);
    }
  });
  it("derives the app version instead of hardcoding it", () => {
    expect(typeof APP_VERSION).toBe("string");
    expect(APP_VERSION.length).toBeGreaterThan(0);
  });
  it("detects OpenCode endpoints by kind or hostname", () => {
    expect(isOpencodeEndpoint("https://opencode.ai/zen/v1", "opencode")).toBe(true);
    expect(isOpencodeEndpoint(undefined, "opencode")).toBe(true);
    expect(isOpencodeEndpoint("https://opencode.ai/zen/v1", "openai-compatible")).toBe(true);
    expect(isOpencodeEndpoint("https://foo.opencode.ai/v1", "openai")).toBe(true);
    expect(isOpencodeEndpoint("https://api.openai.com/v1", "openai")).toBe(false);
    expect(isOpencodeEndpoint("https://notopencode.ai.evil.com/v1", "openai")).toBe(false);
    expect(isOpencodeEndpoint("not a url", "openai")).toBe(false);
    expect(isOpencodeEndpoint(undefined, "openai")).toBe(false);
  });
  it("emits x-opencode-session only for OpenCode endpoints with a conversation id", () => {
    const withConv = opencodeSessionHeader("https://opencode.ai/zen/v1", "opencode", "conv-1");
    expect(withConv["x-opencode-session"]).toBe("conv-1");
    expect(withConv["user-agent"]).toBe(OPENCODE_UA);
    expect(withConv["x-opencode-client"]).toBe(OPENCODE_CLIENT);
    expect(typeof withConv["x-opencode-request"]).toBe("string");
    const compat = opencodeSessionHeader("https://opencode.ai/zen/v1", "openai-compatible", "conv-1");
    expect(compat["x-opencode-session"]).toBe("conv-1");
    const noConv = opencodeSessionHeader("https://opencode.ai/zen/v1", "opencode", undefined);
    expect(noConv["user-agent"]).toBe(OPENCODE_UA);
    expect(noConv["x-opencode-client"]).toBe(OPENCODE_CLIENT);
    expect(typeof noConv["x-opencode-request"]).toBe("string");
    expect(noConv["x-opencode-session"]).toBeUndefined();
    expect(opencodeSessionHeader("https://opencode.ai/zen/v1", "opencode", "conv-1", "req-123")["x-opencode-request"]).toBe("req-123");
    expect(opencodeSessionHeader("https://api.openai.com/v1", "openai", "conv-1")).toEqual({});
  });
  it("uses OpenCode identity on Zen/Go endpoints", () => {
    expect(attributionHeaders("opencode")["user-agent"]).toBe(OPENCODE_UA);
    expect(attributionHeaders("opencode-go")["user-agent"]).toBe(OPENCODE_UA);
  });
  it("updates UA when cached version refreshes", () => {
    setOpencodeVer("9.9.9");
    expect(attributionHeaders("opencode")["user-agent"]).toBe("opencode/9.9.9");
    setOpencodeVer(OPENCODE_VER_DEFAULT);
  });
});