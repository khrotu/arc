import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../protocol/protocol.js";
export interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  cost: number;
  promptTokens?: number;
  inputTokens?: number;
  completionTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheReadCost?: number;
  costIn?: number;
  costOut?: number;
}
export interface ChatSnapshot {
  chats: ChatMeta[];
  currentId?: string;
  messages: Record<string, unknown[]>;
  steps: Record<string, unknown[]>;
}
export class ChatHistory {
  private chats: ChatMeta[] = [];
  private currentId: string | undefined;
  private messages: Record<string, unknown[]> = {};
  private steps: Record<string, unknown[]> = {};
  private maxMessages = 100000;
  private maxSteps = 200000;
  private maxSerializedBytes = 512 * 1024 * 1024;
  load(input: { chats?: ChatMeta[]; currentId?: string; messages?: Record<string, unknown[]>; steps?: Record<string, unknown[]> }) {
    const seen = new Set<string>();
    const metas = (input.chats ?? []).filter((c) => {
      if (!c || typeof c.id !== "string" || c.id.length === 0) return false;
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      if (typeof c.title !== "string" || !c.title) c.title = c.id;
      return true;
    });
    metas.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    this.chats = metas.slice(0, 1000);
    this.messages = {};
    for (const id of Object.keys(input.messages ?? {})) {
      const v = input.messages![id];
      if (seen.has(id) && Array.isArray(v)) this.messages[id] = v;
    }
    this.steps = {};
    for (const id of Object.keys(input.steps ?? {})) {
      const v = input.steps![id];
      if (seen.has(id) && Array.isArray(v)) this.steps[id] = v;
    }
    this.currentId = seen.has(input.currentId ?? "") ? input.currentId : this.chats[0]?.id;
    for (const c of this.chats) {
      this.messages[c.id] = this.messages[c.id] ?? [];
      this.steps[c.id] = this.steps[c.id] ?? [];
    }
    for (const id of Object.keys(this.messages)) this.trimChat(id);
  }
  snapshot(): ChatSnapshot {
    const messages: Record<string, unknown[]> = {};
    for (const [k, v] of Object.entries(this.messages)) messages[k] = [...v];
    const steps: Record<string, unknown[]> = {};
    for (const [k, v] of Object.entries(this.steps)) steps[k] = [...v];
    return { chats: this.chats.map((c) => ({ ...c })), currentId: this.currentId, messages, steps };
  }
  list(): ChatMeta[] {
    return this.chats.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }
  current(): string | undefined {
    return this.currentId;
  }
  create(title?: string): ChatMeta {
    const now = Date.now();
    const c: ChatMeta = {
      id: randomUUID(),
      title: title?.trim() || `New chat \u00b7 ${new Date(now).toLocaleString()}`,
      createdAt: now,
      updatedAt: now,
      cost: 0,
    };
    this.chats.push(c);
    this.currentId = c.id;
    this.messages[c.id] = [];
    this.steps[c.id] = [];
    return c;
  }
  ensure(id?: string): ChatMeta {
    if (id) {
      const found = this.chats.find((c) => c.id === id);
      if (found) {
        this.currentId = found.id;
        return found;
      }
    }
    return this.create();
  }
  switch(id: string): ChatMeta | undefined {
    const c = this.chats.find((x) => x.id === id);
    if (c) this.currentId = c.id;
    return c;
  }
  rename(id: string, title: string): ChatMeta | undefined {
    const c = this.chats.find((x) => x.id === id);
    if (c) { c.title = title.trim() || c.title; c.updatedAt = Date.now(); }
    return c;
  }
  importChat(meta: ChatMeta, messages: ChatMessage[], steps?: unknown[]): boolean {
    if (!meta || typeof meta.id !== "string" || meta.id.length === 0) return false;
    if (this.chats.some((c) => c.id === meta.id)) return false;
    if (this.chats.length >= 1000) return false;
    const clean: ChatMeta = {
      id: meta.id,
      title: typeof meta.title === "string" ? meta.title : meta.id,
      createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : Date.now(),
      updatedAt: Number.isFinite(meta.updatedAt) ? meta.updatedAt : Date.now(),
      cost: Number.isFinite(meta.cost) ? meta.cost : 0,
    };
    for (const k of ["promptTokens", "inputTokens", "completionTokens", "cacheRead", "cacheWrite", "cacheReadCost", "costIn", "costOut"] as const) {
      const v = meta[k];
      if (Number.isFinite(v)) clean[k] = v as number;
    }
    this.chats.push(clean);
    this.messages[meta.id] = Array.isArray(messages) ? [...messages] : [];
    this.steps[meta.id] = Array.isArray(steps) ? [...steps] : [];
    this.trimChat(meta.id);
    return true;
  }
  remove(id: string): void {
    this.chats = this.chats.filter((c) => c.id !== id);
    delete this.messages[id];
    delete this.steps[id];
    if (this.currentId === id) {
      let latest: ChatMeta | undefined;
      for (const c of this.chats) {
        if (!latest || (c.updatedAt ?? 0) > (latest.updatedAt ?? 0)) latest = c;
      }
      this.currentId = latest?.id;
    }
  }
  bump(id: string, cost: number, detail?: { inputTokens?: number; cacheRead?: number; cacheWrite?: number; cacheReadCost?: number; costIn?: number; costOut?: number; completionTokens?: number }): void {
    const c = this.chats.find((x) => x.id === id);
    if (!c) return;
    c.updatedAt = Date.now();
    if (Number.isFinite(cost)) c.cost += cost;
    if (detail) {
      for (const k of ["inputTokens", "cacheRead", "cacheWrite", "cacheReadCost", "costIn", "costOut", "completionTokens"] as const) {
        const v = detail[k];
        if (Number.isFinite(v)) (c[k] as number) = ((c[k] as number | undefined) ?? 0) + (v as number);
      }
    }
  }
  bumpPromptTokens(id: string, promptTokens: number): void {
    const c = this.chats.find((x) => x.id === id);
    if (c && Number.isFinite(promptTokens) && (!c.promptTokens || promptTokens > c.promptTokens)) c.promptTokens = promptTokens;
  }
  setPromptTokens(id: string, promptTokens: number): void {
    const c = this.chats.find((x) => x.id === id);
    if (c && Number.isFinite(promptTokens)) c.promptTokens = Math.max(0, Math.floor(promptTokens));
  }
  getMessages(id: string): unknown[] {
    return this.messages[id] ?? [];
  }
  setMessages(id: string, msgs: unknown[]): void {
    this.messages[id] = Array.isArray(msgs) ? [...msgs] : [];
    this.trimChat(id);
  }
  setSteps(id: string, s: unknown[]): void {
    this.steps[id] = Array.isArray(s) ? [...s] : [];
    this.trimChat(id);
  }
  getSteps(id: string): unknown[] {
    return this.steps[id] ?? [];
  }
  search(query: string, limit = 50): { chat: ChatMeta; matches: { index: number; text: string }[] }[] {
    if (!query.trim()) return [];
    const lower = query.toLowerCase();
    const results: { chat: ChatMeta; matches: { index: number; text: string }[] }[] = [];
    for (const chat of this.chats) {
      const titleMatch = chat.title.toLowerCase().includes(lower);
      const msgs = this.messages[chat.id] ?? [];
      const matches: { index: number; text: string }[] = [];
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i] as { role?: string; content?: unknown; toolCalls?: { id?: string; name?: string; args?: unknown; function?: { name?: string; arguments?: string } }[]; name?: string };
        const texts: string[] = [];
        if (typeof m.content === "string") texts.push(m.content);
        else if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (typeof part === "string") texts.push(part);
            else if (part && typeof (part as { text?: unknown }).text === "string") texts.push((part as { text: string }).text);
          }
        }
        if (m.role === "assistant" && Array.isArray(m.toolCalls)) {
          for (const tc of m.toolCalls) {
            const name = tc?.name ?? tc?.function?.name;
            if (name) texts.push(name);
            const args = tc?.args ?? tc?.function?.arguments;
            if (typeof args === "string") texts.push(args);
            else if (args !== undefined) {
              try {
                const s = JSON.stringify(args);
                if (typeof s === "string") texts.push(s);
              } catch {}
            }
          }
        }
        if (m.role === "tool" && typeof m.name === "string") texts.push(m.name);
        for (const t of texts) {
          if (t.toLowerCase().includes(lower)) {
            matches.push({ index: i, text: t.slice(0, 200) });
            break;
          }
        }
      }
      if (titleMatch || matches.length > 0) {
        results.push({ chat, matches: titleMatch && matches.length === 0 ? [{ index: -1, text: chat.title }] : matches.slice(0, 10) });
        if (results.length >= limit) break;
      }
    }
    return results;
  }
  private trimChat(id: string): void {
    const msgs = this.messages[id];
    if (msgs && msgs.length > this.maxMessages) {
      this.messages[id] = msgs.slice(-this.maxMessages);
    }
    if (this.messages[id]) this.messages[id] = trimSerialized(this.messages[id], this.maxSerializedBytes);
    const steps = this.steps[id];
    if (steps && steps.length > this.maxSteps) {
      this.steps[id] = steps.slice(-this.maxSteps);
    }
    if (this.steps[id]) this.steps[id] = trimSerialized(this.steps[id], this.maxSerializedBytes);
  }
}
function toolCallIds(m: unknown): string[] {
  const calls = (m as { toolCalls?: { id?: unknown }[] }).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.map((c) => String(c?.id ?? "")).filter((s) => s.length > 0);
}
function roughSize(v: unknown, budget: number, seen?: Set<object>): number {
  if (typeof v === "string") return Math.min(Buffer.byteLength(v), budget + 1);
  if (v === undefined || v === null) return 4;
  if (typeof v === "number" || typeof v === "boolean") return 8;
  if (typeof v !== "object") return 8;
  seen = seen ?? new Set();
  if (seen.has(v)) return 16;
  seen.add(v);
  let total = 2;
  if (Array.isArray(v)) {
    for (const item of v) {
      total += roughSize(item, budget, seen) + 1;
      if (total > budget) return total;
    }
    return total;
  }
  for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
    total += Buffer.byteLength(k) + roughSize(item, budget, seen) + 3;
    if (total > budget) return total;
  }
  return total;
}
function trimSerialized(items: unknown[], maxBytes: number): unknown[] {
  let bytes = 0;
  const kept: unknown[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    if (roughSize(items[index], Math.min(maxBytes, 64 * 1024 * 1024)) > Math.min(maxBytes, 64 * 1024 * 1024)) continue;
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(items[index])); }
    catch { continue; }
    if (kept.length && bytes + size > maxBytes) break;
    if (size > maxBytes) continue;
    bytes += size;
    kept.push(items[index]);
  }
  kept.reverse();
  while (kept.length > 0 && (kept[0] as { role?: string }).role === "tool") kept.shift();
  const provided = new Set<string>();
  for (const m of kept) for (const id of toolCallIds(m)) provided.add(id);
  const answered = new Set<string>();
  for (const m of kept) {
    if ((m as { role?: string }).role === "tool") {
      const rid = String((m as { toolCallId?: unknown }).toolCallId ?? "");
      if (rid && provided.has(rid)) answered.add(rid);
    }
  }
  const repaired = kept
    .map((m) => {
      const r = m as { role?: string; toolCalls?: { id?: unknown }[] };
      if (r.role === "assistant" && Array.isArray(r.toolCalls) && r.toolCalls.length > 0) {
        const live = r.toolCalls.filter((c) => answered.has(String(c?.id ?? "")));
        if (live.length !== r.toolCalls.length) {
          const copy = { ...(m as Record<string, unknown>) };
          if (live.length > 0) copy.toolCalls = live;
          else delete copy.toolCalls;
          return copy;
        }
      }
      return m;
    })
    .filter((m) => {
      if ((m as { role?: string }).role !== "tool") return true;
      return provided.has(String((m as { toolCallId?: unknown }).toolCallId ?? ""));
    });
  if (items.length > 0 && (items[0] as { role?: string }).role === "system" && !repaired.includes(items[0])) {
    try {
      if (Buffer.byteLength(JSON.stringify(items[0])) <= maxBytes - bytes) repaired.unshift(items[0]);
    } catch {}
  }
  if (repaired.length === 0 && items.length > 0) {
    const fallback = [...items].reverse().find((m) => (m as { role?: string }).role !== "tool") ?? items[0];
    return fallback && (fallback as { role?: string }).role !== "tool" ? [fallback] : [];
  }
  return repaired;
}