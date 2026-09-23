import type { ProviderKind } from "../protocol/protocol.js";
import type { ChatMessage } from "../protocol/protocol.js";
import { getProviderSpec } from "./catalog.js";
import { hostWarn } from "../log/logger.js";
export function sanitizeToolChains(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let dropped = 0;
  for (const m of messages) {
    if (m.role === "tool") {
      const id = (m.toolCallId ?? "").trim();
      if (!id) {
        out.push(m);
        continue;
      }
      let i = out.length - 1;
      while (i >= 0 && out[i].role === "tool") i--;
      const prev = out[i];
      if (!prev || prev.role !== "assistant" || !prev.toolCalls?.some((t) => t.id === id)) {
        dropped++;
        continue;
      }
      const consumed = new Set<string>();
      for (let j = out.length - 1; j >= 0 && out[j].role === "tool"; j--) {
        const cid = out[j].toolCallId;
        if (cid) consumed.add(cid);
      }
      if (consumed.has(id)) {
        dropped++;
        continue;
      }
    }
    out.push(m);
  }
  const removeIdx = new Set<number>();
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const unique = new Map<string, NonNullable<ChatMessage["toolCalls"]>[number]>();
    for (const t of m.toolCalls) {
      if (!unique.has(t.id)) unique.set(t.id, t);
    }
    const ids = [...unique.keys()];
    const answered = new Set<string>();
    for (let j = i + 1; j < out.length && out[j].role === "tool"; j++) {
      const cid = out[j].toolCallId;
      if (cid) answered.add(cid);
    }
    const complete = ids.every((id) => answered.has(id));
    if (!complete) {
      const kept = m.toolCalls.filter((t) => answered.has(t.id));
      if (kept.length > 0) {
        out[i] = { ...m, toolCalls: kept };
      } else if (m.content) {
        out[i] = { ...m, toolCalls: undefined };
      } else {
        removeIdx.add(i);
      }
      dropped++;
    } else if (unique.size !== m.toolCalls.length) {
      out[i] = { ...m, toolCalls: [...unique.values()] };
    }
  }
  const cleaned = removeIdx.size > 0 ? out.filter((_, i) => !removeIdx.has(i)) : out;
  if (dropped > 0) {
    hostWarn(`[arc] sanitizeToolChains cleaned ${dropped} orphaned/duplicate/incomplete tool message(s) before sending to the provider`);
  }
  return cleaned;
}
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_call_delta"; id: string; name: string; argsDelta: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "ping" }
  | { type: "error"; message: string }
  | { type: "done" };
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export const toApiToolName = (name: string): string =>
  name.replace(/_/g, "_u").replace(/\./g, "_d").replace(/\//g, "_s");
export function fromApiToolName(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    if (name[i] === "_" && i + 1 < name.length) {
      const c = name[i + 1];
      if (c === "u") { out += "_"; i++; continue; }
      if (c === "d") { out += "."; i++; continue; }
      if (c === "s") { out += "/"; i++; continue; }
    }
    out += name[i];
  }
  return out;
}
export interface StreamRequest {
  model: import("../protocol/protocol.js").ModelDescriptor;
  provider: import("../protocol/protocol.js").ProviderConfig;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  proxyUrl?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  conversationId?: string;
}
export interface StreamHandle {
  events: AsyncIterable<StreamEvent>;
  abort: () => void;
}
export interface Transport {
  kind: ProviderKind;
  stream(req: StreamRequest): Promise<StreamHandle>;
}
export const MAX_STREAM_CONTENT_BYTES = 4 * 1024 * 1024;
export interface StreamContentBudget {
  bytes: number;
}
export class StreamContentLimitError extends Error {
  constructor() {
    super("Provider stream exceeded 4 MiB.");
    this.name = "StreamContentLimitError";
  }
}
export function chargeStreamContent(budget: StreamContentBudget, delta: string): void {
  budget.bytes += Buffer.byteLength(delta);
  if (budget.bytes > MAX_STREAM_CONTENT_BYTES) throw new StreamContentLimitError();
}
export type TransportFactory = (provider: import("../protocol/protocol.js").ProviderConfig) => Transport | undefined;
const customTransportFactories = new Map<string, TransportFactory>();
export function registerTransport(kind: string, factory: TransportFactory): void {
  customTransportFactories.set(kind, factory);
}
export function unregisterTransport(kind: string): void {
  customTransportFactories.delete(kind);
}
import { openAICompatibleTransport } from "./openai-compatible.js";
import { anthropicTransport } from "./anthropic.js";
import { ollamaTransport } from "./ollama.js";
export { openAICompatibleTransport, anthropicTransport, ollamaTransport };
import type { TurnUsage } from "../protocol/protocol.js";
export function transportFor(provider: import("../protocol/protocol.js").ProviderConfig): Transport {
  const custom = customTransportFactories.get(provider.kind);
  if (custom) {
    const t = custom(provider);
    if (t) return t;
  }
  if (provider.kind === "ollama") return ollamaTransport;
  if (provider.kind === "anthropic") return anthropicTransport;
  if (provider.kind === "vscode-lm") {
    throw new Error("vscode-lm transport is wired by the extension host, not the generic transportFor() helper.");
  }
  const spec = getProviderSpec(provider.kind);
  const base = provider.baseUrl || spec?.defaultBaseUrl || "";
  return openAICompatibleTransport.withBase(base);
}