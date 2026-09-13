import { randomUUID } from "node:crypto";
import type { ChatMessage, ModelDescriptor } from "../protocol/protocol.js";
const CHARS_PER_TOKEN = 4;
const FACTOR = 1.3;
const MIN_OUTPUT_RESERVE = 16_384;
const IMAGE_TOKEN_OVERHEAD = 800;
export const COMPACTION_SUMMARY_HEADER = "## Compaction summary of";
export interface CompactionStats {
  avgOutput: number;
  avgPrompt: number;
  avgUser: number;
  avgHitRate: number;
  avgSummary: number;
  samples: number;
}
export class CompactionTracker {
  private stats = new Map<string, CompactionStats>();
  observe(modelId: string, usage: { prompt: number; completion: number; thinking: number; cacheRead?: number; cacheWrite?: number }, userTokens: number = 0) {
    const s = this.stats.get(modelId) ?? { avgOutput: 0, avgPrompt: 0, avgUser: 0, avgHitRate: 0, avgSummary: 0, samples: 0 };
    const alpha = 0.2;
    const out = usage.completion + usage.thinking;
    s.avgOutput = s.avgOutput * (1 - alpha) + out * alpha;
    s.avgPrompt = s.avgPrompt * (1 - alpha) + usage.prompt * alpha;
    s.avgUser = s.avgUser * (1 - alpha) + userTokens * alpha;
    const hit = usage.cacheRead ?? 0;
    s.avgHitRate = s.avgHitRate * (1 - alpha) + (usage.prompt > 0 ? Math.min(1, Math.max(0, hit / usage.prompt)) : 0) * alpha;
    s.samples += 1;
    this.stats.set(modelId, s);
  }
  noteSummary(modelId: string, summaryTokens: number) {
    const s = this.stats.get(modelId) ?? { avgOutput: 0, avgPrompt: 0, avgUser: 0, avgHitRate: 0, avgSummary: 0, samples: 0 };
    s.avgSummary = s.avgSummary > 0 ? s.avgSummary * 0.7 + summaryTokens * 0.3 : summaryTokens;
    this.stats.set(modelId, s);
  }
  for(modelId: string): CompactionStats | undefined {
    const s = this.stats.get(modelId);
    return s && s.samples >= 3 ? s : undefined;
  }
}
export type CompactionStrategy = "model-aware" | "fixed";
export interface CompactionConfig {
  safetyMargin: number;
  enforce: boolean;
  keepTail: number;
  strategy?: CompactionStrategy;
  fixedAtPct?: number;
  frictionCost?: number;
  lostContextPenalty?: number;
}
export const defaultCompactionConfig: CompactionConfig = {
  safetyMargin: 0.15,
  enforce: true,
  keepTail: 6,
  fixedAtPct: 75,
  frictionCost: 0,
  lostContextPenalty: 0,
};
export interface CompactionDecision {
  shouldCompact: boolean;
  reason: string;
  currentUsage: number;
  usable: number;
  window: number;
}
export interface CompactionCostTarget {
  s0: number;
  p: number;
  m: number;
  tStar: number;
  tMax: number;
  tOpt: number;
  nCompact: number;
}
const DEFAULT_SUMMARY_TOKENS = 1024;
const COST_TRIGGER_FLOOR_PCT = 0.5;
function outputReserve(model: ModelDescriptor, stats: CompactionStats | undefined, strategy: CompactionStrategy, window: number): number {
  const halfWindow = Math.floor(window / 2);
  if (strategy !== "fixed" && stats && stats.avgOutput > 0) {
    const projected = Math.ceil(stats.avgOutput * 1.4);
    return Math.min(halfWindow, Math.max(projected, MIN_OUTPUT_RESERVE));
  }
  const base = Math.max(model.maxOutputTokens ?? MIN_OUTPUT_RESERVE, MIN_OUTPUT_RESERVE);
  return Math.min(halfWindow, base);
}
function estimatePostCompactionTokens(messages: ChatMessage[], cfg: CompactionConfig, summaryTokens: number): number {
  const { lead, tailStart } = segment(messages, cfg.keepTail);
  const middle = messages.slice(lead, tailStart);
  const prot = protectedIndices(middle);
  const preserved = middle.filter((_, i) => prot.has(i));
  return estimateTokens(messages.slice(0, lead)) + estimateTokens(preserved) + summaryTokens + estimateTokens(messages.slice(tailStart));
}
export function compactionCostTarget(
  messages: ChatMessage[],
  model: ModelDescriptor,
  stats: CompactionStats | undefined,
  cfg: CompactionConfig,
  hardLimit: number,
): CompactionCostTarget | undefined {
  const perIn = model.costPer1mIn / 1_000_000;
  const perCache = (model.costPer1mCacheRead ?? model.costPer1mIn) / 1_000_000;
  const perOut = model.costPer1mOut / 1_000_000;
  if (!(perIn > 0)) return undefined;
  const h = Math.min(1, Math.max(0, stats?.avgHitRate ?? 0));
  const p = h * perCache + (1 - h) * perIn;
  const m = (stats?.avgUser ?? 0) + (stats?.avgOutput ?? 0);
  if (!(p > 0) || !(m > 0)) return undefined;
  const summaryTokens = stats && stats.avgSummary > 0 ? stats.avgSummary : DEFAULT_SUMMARY_TOKENS;
  const s0 = estimatePostCompactionTokens(messages, cfg, summaryTokens);
  const friction = Math.max(0, cfg.frictionCost ?? 0);
  const lostPenalty = Math.max(0, cfg.lostContextPenalty ?? 0);
  const summaryTerm = Math.max(0, perOut - lostPenalty) * summaryTokens;
  const numerator = 2 * (p * s0 + summaryTerm + friction);
  const tStar = Math.sqrt(numerator / (p * m));
  const tMax = Math.floor(Math.max(0, hardLimit - s0) / m);
  const tOpt = Math.min(Math.max(tStar, 1), Math.max(1, tMax));
  return { s0, p, m, tStar, tMax, tOpt, nCompact: Math.ceil(s0 + tOpt * m) };
}
export function decideCompaction(
  messages: ChatMessage[],
  model: ModelDescriptor,
  tracker?: CompactionTracker,
  cfg: CompactionConfig = defaultCompactionConfig,
  lastKnownPromptTokens: number = 0,
  tools?: { description?: string; inputSchema?: unknown }[],
): CompactionDecision {
  const estimated = estimateTokens(messages, tools);
  const current = lastKnownPromptTokens > 0 ? Math.max(lastKnownPromptTokens, estimated) : estimated;
  const window = model.contextWindow ?? 0;
  if (!Number.isFinite(window) || window <= 0) {
    return { shouldCompact: false, reason: "unlimited context window", currentUsage: current, usable: 0, window };
  }
  const margin = Math.min(0.8, Math.max(0, cfg.safetyMargin));
  const reserve = outputReserve(model, tracker?.for(model.id), cfg.strategy ?? "model-aware", window);
  const limit = Math.floor(Math.max(0, window - reserve) * (1 - margin));
  if (limit <= 0) {
    return { shouldCompact: false, reason: "usable window exhausted by reserves", currentUsage: current, usable: limit, window };
  }
  if ((cfg.strategy ?? "model-aware") === "fixed") {
    const rawPct = cfg.fixedAtPct ?? 75;
    const fixedPct = Math.min(1, Math.max(0.01, rawPct > 1 ? rawPct / 100 : rawPct));
    const fixedLimit = Math.min(Math.floor(window * fixedPct), limit);
    if (current >= fixedLimit) {
      return { shouldCompact: true, reason: `fixed: estimated ${current} >= ${Math.round(fixedPct * 100)}% of window (${fixedLimit})`, currentUsage: current, usable: fixedLimit, window };
    }
    return { shouldCompact: false, reason: `fixed: below ${Math.round(fixedPct * 100)}% of window`, currentUsage: current, usable: fixedLimit, window };
  }
  if (current >= limit) {
    return { shouldCompact: true, reason: `estimated ${current} >= limit ${limit}`, currentUsage: current, usable: limit, window };
  }
  const target = compactionCostTarget(messages, model, tracker?.for(model.id), cfg, limit);
  if (target && current >= target.nCompact) {
    const floor = Math.floor(limit * COST_TRIGGER_FLOOR_PCT);
    if (current >= floor) {
      return { shouldCompact: true, reason: `cost-optimal: ${current} >= N_compact ${target.nCompact} (T*=${target.tStar.toFixed(1)})`, currentUsage: current, usable: limit, window };
    }
    return { shouldCompact: false, reason: `cost-optimal deferred: ${current} below ${Math.round(COST_TRIGGER_FLOOR_PCT * 100)}% of usable window (${floor})`, currentUsage: current, usable: limit, window };
  }
  return { shouldCompact: false, reason: "headroom sufficient", currentUsage: current, usable: limit, window };
}
function isPriorSummary(m: ChatMessage): boolean {
  return m.role === "system" && typeof m.content === "string" && m.content.startsWith(COMPACTION_SUMMARY_HEADER);
}
interface Segments { lead: number; tailStart: number }
export function clampKeepTail(keepTail: unknown): number {
  return Number.isFinite(keepTail) ? Math.max(1, Math.min(50, Math.floor(keepTail as number))) : 5;
}
function segment(messages: ChatMessage[], keepTail: number): Segments {
  const tail = clampKeepTail(keepTail);
  let lead = 0;
  while (lead < messages.length && messages[lead].role === "system" && !isPriorSummary(messages[lead])) lead++;
  let tailStart = Math.max(lead, messages.length - tail);
  while (tailStart > lead && messages[tailStart]?.role === "tool") tailStart--;
  while (tailStart > lead) {
    const prev = messages[tailStart - 1];
    if (prev.role === "assistant" && (prev.toolCalls?.length ?? 0) > 0) tailStart--;
    else break;
  }
  return { lead, tailStart };
}
function protectedIndices(middle: ChatMessage[]): Set<number> {
  const prot = new Set<number>();
  for (let i = 0; i < middle.length; i++) {
    if (!middle[i].noCompact) continue;
    if (middle[i].role === "tool") {
      let j = i;
      while (j > 0 && middle[j - 1].role === "tool") j--;
      if (j > 0 && middle[j - 1].toolCalls?.length) {
        prot.add(j - 1);
        for (let k = j; k < middle.length && middle[k].role === "tool"; k++) prot.add(k);
      }
    } else {
      prot.add(i);
      if (middle[i].toolCalls?.length) {
        for (let k = i + 1; k < middle.length && middle[k].role === "tool"; k++) prot.add(k);
      }
    }
  }
  return prot;
}
function buildSummaryMessage(count: number, summary: string): ChatMessage {
  return {
    id: `summary-${Date.now()}-${randomUUID().slice(0, 8)}`,
    role: "system",
    content: `${COMPACTION_SUMMARY_HEADER} ${count} earlier messages\n\n${summary}`,
    ts: Date.now(),
  };
}
function assemble(messages: ChatMessage[], cfg: CompactionConfig, summary: string): ChatMessage[] | undefined {
  const tail = clampKeepTail(cfg.keepTail);
  const { lead, tailStart } = segment(messages, tail);
  if (messages.length <= tail + lead + 1 || tailStart <= lead) return undefined;
  const middle = messages.slice(lead, tailStart);
  const prot = protectedIndices(middle);
  const preserved = middle.filter((_, i) => prot.has(i));
  const compactable = middle.filter((_, i) => !prot.has(i));
  if (compactable.length === 0) return undefined;
  return [...messages.slice(0, lead), ...preserved, buildSummaryMessage(compactable.length, summary), ...messages.slice(tailStart)];
}
export function compact(messages: ChatMessage[], cfg: CompactionConfig = defaultCompactionConfig, summarize: (msgs: ChatMessage[]) => string): ChatMessage[] {
  const tail = clampKeepTail(cfg.keepTail);
  const { lead, tailStart } = segment(messages, tail);
  if (messages.length <= tail + lead + 1 || tailStart <= lead) return messages;
  const middle = messages.slice(lead, tailStart);
  const prot = protectedIndices(middle);
  const compactable = middle.filter((_, i) => !prot.has(i));
  if (compactable.length === 0) return messages;
  return assemble(messages, cfg, summarize(compactable)) ?? messages;
}
export async function compactAsync(
  messages: ChatMessage[],
  summarize: (msgs: ChatMessage[]) => Promise<string>,
  cfg: CompactionConfig = defaultCompactionConfig,
): Promise<ChatMessage[]> {
  const tail = clampKeepTail(cfg.keepTail);
  const { lead, tailStart } = segment(messages, tail);
  if (messages.length <= tail + lead + 1 || tailStart <= lead) return messages;
  const middle = messages.slice(lead, tailStart);
  const prot = protectedIndices(middle);
  const compactable = middle.filter((_, i) => !prot.has(i));
  if (compactable.length === 0) return messages;
  const out = assemble(messages, cfg, await summarize(compactable));
  return out ?? messages;
}
export function estimateTokens(messages: ChatMessage[], tools?: { description?: string; inputSchema?: unknown }[]): number {
  let chars = 0;
  let imageTokens = 0;
  for (const m of messages) {
    chars += contentLength(m.content);
    if (m.thinking) chars += contentLength(m.thinking);
    if (m.toolCallId) chars += contentLength(m.toolCallId);
    chars += ROLE_OVERHEAD[m.role] ?? ROLE_OVERHEAD.default;
    if (m.images?.length) imageTokens += m.images.length * IMAGE_TOKEN_OVERHEAD;
    if (m.toolCalls) {
      for (const t of m.toolCalls) {
        chars += contentLength(t.name) + stringifyLength(t.args);
        chars += TOOL_CALL_OVERHEAD;
      }
    }
  }
  if (tools?.length) {
    let defs = 0;
    for (const t of tools) {
      const name = "name" in t ? contentLength((t as { name: unknown }).name) : 0;
      defs += name + contentLength(t.description) + stringifyLength(t.inputSchema);
    }
    chars += defs;
  }
  return Math.ceil((chars / CHARS_PER_TOKEN) * FACTOR) + imageTokens;
}
function contentLength(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (v === undefined || v === null) return 0;
  try {
    return JSON.stringify(v)?.length ?? 8;
  } catch {
    return 8;
  }
}
function stringifyLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}
function renderArgs(v: unknown): string {
  try {
    const s = JSON.stringify(v) ?? "";
    return s.length > 200 ? `${s.slice(0, 200)}...` : s;
  } catch {
    return "";
  }
}
const ROLE_OVERHEAD: Record<string, number> = {
  system: 12,
  user: 10,
  assistant: 12,
  tool: 16,
  developer: 12,
  default: 8,
};
const TOOL_CALL_OVERHEAD = 24;
const SUMMARY_MSG_CAP = 2_400;
const SUMMARY_TOTAL_BUDGET = 120_000;
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return "";
  }
}
export function renderForSummary(msgs: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    let line: string;
    const text = textOf(m.content);
    if (isPriorSummary(m)) {
      line = text;
    } else if (m.role === "system") {
      line = `[system] ${text}`;
    } else if (m.role === "user") {
      line = `[user] ${text}`;
    } else if (m.role === "assistant") {
      const tc = m.toolCalls?.length ? ` tools=${m.toolCalls.map((t) => `${t.name}(${renderArgs(t.args)})`).join("; ")}` : "";
      line = `[assistant] ${text}${tc}`;
    } else if (m.role === "tool") {
      line = `[tool:${m.toolCallId ?? ""}] ${text}`;
    } else if (m.role === "developer") {
      line = `[developer] ${text}`;
    } else {
      line = `[${m.role}] ${text}`;
    }
    if (m.thinking) line += `\n[thinking] ${textOf(m.thinking)}`;
    if (line.length > SUMMARY_MSG_CAP) line = `${line.slice(0, SUMMARY_MSG_CAP)} ...`;
    lines.push(line);
  }
  const total = lines.reduce((s, l) => s + l.length + 1, 0);
  if (total <= SUMMARY_TOTAL_BUDGET) return lines.join("\n");
  const OMISSION_MARK = "...(transcript omitted for length - sections above cover the oldest turns and sections below the newest turns)...";
  const headBudget = Math.floor(SUMMARY_TOTAL_BUDGET * 0.2);
  let used = 0;
  let headEnd = 0;
  while (headEnd < lines.length && used < headBudget) {
    used += lines[headEnd].length + 1;
    headEnd++;
  }
  if (used > headBudget && headEnd > 0) {
    headEnd--;
    used -= lines[headEnd].length + 1;
  }
  let remaining = SUMMARY_TOTAL_BUDGET - used - OMISSION_MARK.length;
  let tailStart = lines.length;
  while (tailStart > headEnd && remaining > 0) {
    remaining -= lines[tailStart - 1].length + 1;
    if (remaining >= 0) tailStart--;
  }
  if (tailStart <= headEnd) {
    return [...lines.slice(0, headEnd), OMISSION_MARK].join("\n").slice(0, SUMMARY_TOTAL_BUDGET);
  }
  return [...lines.slice(0, headEnd), OMISSION_MARK, ...lines.slice(tailStart)].join("\n");
}
export function summarizeInProcess(msgs: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const text = textOf(m.content);
    if (isPriorSummary(m)) lines.push(`- [prior summary]: ${text.replace(COMPACTION_SUMMARY_HEADER, "").slice(0, 200)}`);
    else if (m.role === "tool") lines.push(`- [tool ${m.toolCallId ?? ""}]: ${text.slice(0, 80)}`);
    else if (m.role === "assistant") lines.push(`- [assistant]: ${text.slice(0, 120)}${m.toolCalls?.length ? ` (${m.toolCalls.map((t) => t.name).join(", ")})` : ""}`);
    else if (m.role === "user") lines.push(`- [user]: ${text.slice(0, 120)}`);
    else if (m.role === "system") lines.push(`- [system]: ${text.slice(0, 120)}`);
    else lines.push(`- [${m.role}]: ${text.slice(0, 120)}`);
  }
  return lines.join("\n");
}