import { deflateSync, inflateSync } from "node:zlib";
import { aesGcmEncrypt, aesGcmDecrypt } from "@arc/host/util";
import type { ChatMeta, ChatSnapshot, ChatMessage, Role, ModelTier } from "@arc/host";
export const CHATS_FILE_NAME = "arc.chats.arcx";
export const LEGACY_CHATS_FILE_NAME = "arc.chats.json";
const MAGIC = Buffer.from("ARCX1", "ascii");
const FORMAT_VERSION = 4;
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
function safeInflate(compressed: Buffer): Buffer {
  if (compressed.length > 16 * 1024 * 1024) throw new Error("compressed block too large");
  const out = inflateSync(compressed, { maxOutputLength: MAX_INFLATED_BYTES } as unknown as object);
  if (out.length > MAX_INFLATED_BYTES) throw new Error("decompressed block too large");
  return out as Buffer;
}
const decodeWarnings: string[] = [];
export function getLastDecodeWarnings(): string[] {
  return [...decodeWarnings];
}
const ROLE_INDEX: Record<Role, number> = { system: 0, user: 1, assistant: 2, tool: 3, developer: 4 };
const ROLE_NAMES: Role[] = ["system", "user", "assistant", "tool", "developer"];
const TIER_INDEX: Record<ModelTier, number> = { heavy: 0, default: 1, light: 2, free: 3 };
const TIER_NAMES: ModelTier[] = ["heavy", "default", "light", "free"];
function varint(n: number): number[] {
  const out: number[] = [];
  let v = Math.floor(n);
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
  return out;
}
function readVarint(buf: Buffer, off: { o: number }): number {
  let result = 0;
  let mult = 1;
  for (let i = 0; i < 8; i++) {
    const b = buf[off.o++];
    if (b === undefined) throw new Error("ARCX: truncated varint");
    result += (b & 0x7f) * mult;
    if (!(b & 0x80)) return result;
    mult *= 128;
  }
  throw new Error("ARCX: varint too long");
}
class Writer {
  private parts: Buffer[] = [];
  str(s: string): void {
    const b = Buffer.from(s, "utf8");
    this.parts.push(Buffer.from(varint(b.length)), b);
  }
  u8(v: number): void { this.parts.push(Buffer.from([v & 0xff])); }
  varint(v: number): void { this.parts.push(Buffer.from(varint(v))); }
  f64(v: number): void { const b = Buffer.alloc(8); b.writeDoubleLE(v); this.parts.push(b); }
  raw(b: Buffer): void { this.parts.push(b); }
  build(): Buffer { return Buffer.concat(this.parts); }
}
class Reader {
  constructor(private buf: Buffer, private off: { o: number }) {}
  u8(): number { const v = this.buf[this.off.o++]; if (v === undefined) throw new Error("ARCX: truncated"); return v; }
  varint(): number { return readVarint(this.buf, this.off); }
  f64(): number { const v = this.buf.readDoubleLE(this.off.o); this.off.o += 8; return v; }
  str(): string {
    const len = this.varint();
    const s = this.buf.toString("utf8", this.off.o, this.off.o + len);
    this.off.o += len;
    return s;
  }
  bytes(len: number): Buffer { const b = this.buf.subarray(this.off.o, this.off.o + len); this.off.o += len; return b; }
  done(): void { if (this.off.o !== this.buf.length) throw new Error("ARCX: trailing bytes"); }
}
function encodeMessage(w: Writer, m: ChatMessage): void {
  const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  w.str(m.id);
  w.u8(ROLE_INDEX[m.role] ?? 1);
  w.varint(m.ts);
  w.str(content);
  let flags = 0;
  if (m.thinking !== undefined) flags |= 1;
  if (m.toolCallId !== undefined) flags |= 2;
  if (m.toolCalls?.length) flags |= 4;
  if (m.meta && typeof m.meta.modelId === "string" && typeof m.meta.providerId === "string") flags |= 8;
  if (m.images?.length) flags |= 16;
  if (m.noCompact) flags |= 32;
  w.u8(flags);
  if (flags & 1) w.str(m.thinking!);
  if (flags & 2) w.str(m.toolCallId!);
  if (flags & 4) {
    w.varint(m.toolCalls!.length);
    for (const tc of m.toolCalls!) {
      w.str(tc.id);
      w.str(tc.name);
      w.str(JSON.stringify(tc.args ?? {}));
    }
  }
  if (flags & 8) {
    w.str(m.meta!.modelId);
    w.str(m.meta!.providerId);
    w.u8(TIER_INDEX[m.meta!.tier] ?? 1);
  }
  if (flags & 16) {
    w.varint(m.images!.length);
    for (const img of m.images!) {
      w.str(img.type);
      w.str(img.image_url.url);
    }
  }
}
function decodeMessage(r: Reader): ChatMessage {
  const id = r.str();
  const role = ROLE_NAMES[r.u8()] ?? "user";
  const ts = r.varint();
  const content = r.str();
  const flags = r.u8();
  const m: ChatMessage = { id, role, content, ts };
  if (flags & 1) m.thinking = r.str();
  if (flags & 2) m.toolCallId = r.str();
  if (flags & 4) {
    const n = r.varint();
    m.toolCalls = [];
    for (let i = 0; i < n; i++) {
      m.toolCalls.push({ id: r.str(), name: r.str(), args: JSON.parse(r.str()) as Record<string, unknown> });
    }
  }
  if (flags & 8) {
    m.meta = { modelId: r.str(), providerId: r.str(), tier: TIER_NAMES[r.u8()] ?? "default" };
  }
  if (flags & 16) {
    const n = r.varint();
    m.images = [];
    for (let i = 0; i < n; i++) m.images.push({ type: r.str(), image_url: { url: r.str() } });
  }
  if (flags & 32) m.noCompact = true;
  return m;
}
export function encodeSnapshot(snap: ChatSnapshot): Buffer {
  const w = new Writer();
  w.u8(FORMAT_VERSION);
  w.u8(snap.currentId ? 1 : 0);
  if (snap.currentId) w.str(snap.currentId);
  w.varint(snap.chats.length);
  for (const c of snap.chats) {
    w.str(c.id);
    w.str(c.title);
    w.varint(c.createdAt);
    w.varint(c.updatedAt);
    w.f64(c.cost);
    w.f64(c.promptTokens ?? 0);
    w.f64(c.inputTokens ?? 0);
    w.f64(c.completionTokens ?? 0);
    w.f64(c.cacheRead ?? 0);
    w.f64(c.cacheWrite ?? 0);
    w.f64(c.cacheReadCost ?? 0);
    w.f64(c.costIn ?? 0);
    w.f64(c.costOut ?? 0);
  }
  const msgEntries = Object.entries(snap.messages ?? {});
  w.varint(msgEntries.length);
  for (const [chatId, msgs] of msgEntries) {
    w.str(chatId);
    w.varint(msgs.length);
    for (const m of msgs as ChatMessage[]) {
      const mw = new Writer();
      encodeMessage(mw, m);
      const framed = mw.build();
      w.varint(framed.length);
      w.raw(framed);
    }
  }
  const stepEntries = Object.entries(snap.steps ?? {});
  w.varint(stepEntries.length);
  for (const [chatId, steps] of stepEntries) {
    w.str(chatId);
    const compressed = deflateSync(Buffer.from(JSON.stringify(steps), "utf8"));
    w.varint(compressed.length);
    w.raw(compressed);
  }
  return w.build();
}
export function decodeSnapshot(buf: Buffer): ChatSnapshot {
  const r = new Reader(buf, { o: 0 });
  const version = r.u8();
  if (version < 1 || version > FORMAT_VERSION) throw new Error(`ARCX: unsupported format version ${version}`);
  decodeWarnings.length = 0;
  const warn = (msg: string): void => {
    if (decodeWarnings.length < 20) decodeWarnings.push(msg);
  };
  const snap: ChatSnapshot = { chats: [], messages: {}, steps: {} };
  if (r.u8()) snap.currentId = r.str();
  const chatCount = r.varint();
  for (let i = 0; i < chatCount; i++) {
    const c: ChatMeta = { id: r.str(), title: r.str(), createdAt: r.varint(), updatedAt: r.varint(), cost: r.f64() };
    if (version >= 2) {
      const pt = r.f64();
      if (pt > 0) c.promptTokens = pt;
    }
    if (version >= 3) {
      const it = r.f64();
      if (it > 0) c.inputTokens = it;
      const ct = r.f64();
      if (ct > 0) c.completionTokens = ct;
      const cr = r.f64();
      if (cr > 0) c.cacheRead = cr;
      const cw = r.f64();
      if (cw > 0) c.cacheWrite = cw;
      const crc = r.f64();
      if (crc > 0) c.cacheReadCost = crc;
      const ci = r.f64();
      if (ci > 0) c.costIn = ci;
      const co = r.f64();
      if (co > 0) c.costOut = co;
    }
    snap.chats.push(c);
  }
  const msgChatCount = r.varint();
  for (let i = 0; i < msgChatCount; i++) {
    const chatId = r.str();
    const n = r.varint();
    const msgs: ChatMessage[] = [];
    for (let j = 0; j < n; j++) {
      if (version >= 4) {
        const len = r.varint();
        const frame = r.bytes(len);
        try {
          msgs.push(decodeMessage(new Reader(frame, { o: 0 })));
        } catch (e) {
          warn(`chat ${chatId}: dropped corrupt message ${j} (${(e as Error)?.message ?? e})`);
        }
      } else {
        msgs.push(decodeMessage(r));
      }
    }
    snap.messages[chatId] = msgs;
  }
  const stepChatCount = r.varint();
  for (let i = 0; i < stepChatCount; i++) {
    const chatId = r.str();
    const len = r.varint();
    const compressed = r.bytes(len);
    try {
      snap.steps[chatId] = JSON.parse(safeInflate(compressed).toString("utf8")) as unknown[];
    } catch (e) {
      warn(`chat ${chatId}: dropped corrupt steps (${(e as Error)?.message ?? e})`);
      snap.steps[chatId] = [];
    }
  }
  try {
    r.done();
  } catch (e) {
    warn(`trailing bytes ignored (${(e as Error)?.message ?? e})`);
  }
  return snap;
}
export function encryptChatSnapshot(snap: ChatSnapshot, key: Buffer): Buffer {
  const plaintext = encodeSnapshot(snap);
  const { iv, tag, data } = aesGcmEncrypt(key, plaintext);
  const payload = Buffer.concat([iv, tag, data]);
  const header = Buffer.alloc(10);
  MAGIC.copy(header, 0);
  header[5] = FORMAT_VERSION;
  header.writeUInt32BE(payload.length, 6);
  return Buffer.concat([header, payload]);
}
export function decryptChatSnapshot(fileBuf: Buffer, key: Buffer): ChatSnapshot {
  if (fileBuf.length < 10 || !fileBuf.subarray(0, 5).equals(MAGIC)) throw new Error("ARCX: bad magic");
  const payloadLen = fileBuf.readUInt32BE(6);
  if (10 + payloadLen > fileBuf.length) throw new Error("ARCX: truncated payload");
  const payload = fileBuf.subarray(10, 10 + payloadLen);
  const plaintext = aesGcmDecrypt(key, {
    iv: payload.subarray(0, 12),
    tag: payload.subarray(12, 28),
    data: payload.subarray(28),
  });
  const snap = decodeSnapshot(plaintext);
  if (10 + payloadLen < fileBuf.length) {
    decodeWarnings.push(`ignored ${fileBuf.length - 10 - payloadLen} unauthenticated trailing bytes`);
  }
  return snap;
}