import { randomUUID } from "node:crypto";
import { ModelRegistry } from "../routing/registry.js";
import { pickProvider } from "../routing/router.js";
import { transportFor } from "../providers/transport.js";
import type { ChatMessage, ModelDescriptor, ModelTier } from "../protocol/protocol.js";
export type PolishLevel = "off" | "basic" | "polish";
function polishSystemPrompt(level: Exclude<PolishLevel, "off">): string {
  if (level === "basic") {
    return "You are a prompt editor. Fix ONLY grammar and spelling errors in the user's message. Keep the meaning, structure, and every technical detail (paths, commands, code, filenames) identical. Do not add, remove, or rewrite anything beyond corrections. Reply with ONLY the corrected text - no quotes, no explanations, no prefix.";
  }
  return "You are a prompt editor for an agentic coding assistant. Improve the user's prompt: fix grammar and spelling, sharpen clarity and intent, organize jumbled instructions into a logical order, and make the goal explicit. Keep every technical detail (paths, commands, code, filenames, error strings) verbatim and preserve the original meaning exactly. Reply with ONLY the polished prompt - no quotes, no explanations, no prefix.";
}
export type PolishAttempt = { model: string; provider: string; error?: string };
export type PolishOutcome =
  | { ok: true; polished: string; attempts: PolishAttempt[] }
  | { ok: false; reason: "no-model" | "error" | "identical"; attempts: PolishAttempt[] };
export async function polishPrompt(
  registry: ModelRegistry,
  text: string,
  level: Exclude<PolishLevel, "off">,
  proxyUrl?: string,
): Promise<PolishOutcome> {
  const candidates: ModelDescriptor[] = [];
  const seen = new Set<string>();
  const tierPrefs = level === "basic" ? (["free", "light"] as ModelTier[]) : (["light"] as ModelTier[]);
  for (const tier of tierPrefs) {
    for (const m of registry.list()) {
      if (m.tier !== tier || seen.has(m.id)) continue;
      if (pickProvider(registry, m)) {
        seen.add(m.id);
        candidates.push(m);
      }
    }
  }
  const cur = registry.getCurrent();
  if (cur && !seen.has(cur.id) && pickProvider(registry, cur)) candidates.push(cur);
  if (!candidates.length) return { ok: false, reason: "no-model", attempts: [] };
  const attempts: PolishAttempt[] = [];
  for (const model of candidates) {
    const attempt = await tryOnce(registry, model, text, level, proxyUrl);
    attempts.push(attempt.attempt);
    if (attempt.outcome.ok) return { ok: true, polished: attempt.outcome.polished, attempts };
  }
  return { ok: false, reason: attempts.some((a) => a.error === "identical") ? "identical" : "error", attempts };
}
async function tryOnce(
  registry: ModelRegistry,
  model: ModelDescriptor,
  text: string,
  level: Exclude<PolishLevel, "off">,
  proxyUrl?: string,
): Promise<{ attempt: PolishAttempt; outcome: { ok: true; polished: string } | { ok: false } }> {
  const decision = pickProvider(registry, model);
  const attempt: PolishAttempt = { model: model.id, provider: decision?.provider.label || decision?.provider.id || "?" };
  if (!decision) {
    attempt.error = "no provider";
    return { attempt, outcome: { ok: false } };
  }
  try {
    const transport = transportFor(decision.provider);
    const messages: ChatMessage[] = [
      { id: randomUUID(), role: "system", content: polishSystemPrompt(level), ts: Date.now() },
      { id: randomUUID(), role: "user", content: text, ts: Date.now() },
    ];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const stream = await transport.stream({
        model,
        provider: decision.provider,
        messages,
        signal: abort.signal,
        proxyUrl,
      });
      let out = "";
      let sawError = false;
      let streamError = "";
      for await (const ev of stream.events) {
        if (ev.type === "text") out += ev.delta;
        if (ev.type === "error") { sawError = true; streamError = ev.message; break; }
        if (ev.type === "done") break;
      }
      const polished = out.trim();
      if (!polished) {
        attempt.error = sawError ? streamError : "empty response";
        return { attempt, outcome: { ok: false } };
      }
      if (polished === text) {
        attempt.error = "identical";
        return { attempt, outcome: { ok: false } };
      }
      return { attempt, outcome: { ok: true, polished } };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    attempt.error = (e as Error)?.message ?? String(e);
    return { attempt, outcome: { ok: false } };
  }
}