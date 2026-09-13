import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PROVIDERS } from "../providers/catalog.js";
import { prettyToolTitle } from "../agent/agent.js";
import type { ProviderKind } from "../protocol/protocol.js";
export interface ImportCredential {
  key: string;
  agent: string;
  provider: string;
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey: string;
}
export interface ImportCredentialPreview {
  key: string;
  provider: string;
  label: string;
  baseUrl?: string;
  kind: ProviderKind;
  keyPreview: string;
}
export interface ImportAgentSummary {
  agent: string;
  via: string;
  chats: number;
  messages: number;
  credentials: ImportCredential[];
}
export interface ImportAgentSummaryPreview {
  agent: string;
  via: string;
  chats: number;
  messages: number;
  credentials: ImportCredentialPreview[];
}
export interface ImportedMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  ts: number;
  thinking?: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  toolCallId?: string;
}
export interface ImportedStep {
  id: string;
  type: "thought" | "tool";
  title: string;
  ts: number;
  content?: string;
  output?: string;
  toolName?: string;
}
export interface ImportedChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ImportedMessage[];
  steps?: ImportedStep[];
}
export interface ImportChatsResult {
  chats: number;
  messages: number;
  bytes: number;
}
const KIND_ALIASES: Record<string, string> = {
  moonshotai: "kimi", "moonshotai-cn": "kimi-cn", "moonshot": "kimi",
  "z.ai": "z-ai", "zai": "z-ai", "zai-cn": "z-ai-cn", "zai-coding-plan": "zai-coding-plan",
  "z.ai - coding plan": "zai-coding-plan", "zhipu": "z-ai",
  "openai-native": "openai", "openai compatible": "openai-compatible", "openricompatible": "openai-compatible",
  "qwen": "dashscope", "qwen-code": "dashscope", "nousresearch": "openai-compatible", "litellm": "litellm-proxy",
  "claude-code": "anthropic", "vscode-lm": "openai-compatible", "lmstudio": "openai-compatible",
  "huggingface": "openai-compatible", "sapaicore": "openai-compatible", "amazon-bedrock": "openai-compatible",
  "google-vertex": "openai-compatible", "gemini": "google", "claude": "anthropic", "claudemin": "anthropic",
};
export function maskKey(key: string): string {
  if (key.length <= 12) return "\u2022\u2022\u2022";
  return `${key.slice(0, 4)}\u2022\u2022\u2022${key.slice(-4)}`;
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
const TOOL_KIND_MAP: Record<string, string> = {
  read: "file.read", readfile: "file.read", view: "file.read", openfile: "file.read",
  write: "file.write", writefile: "file.write", writetofile: "file.write", createnewfile: "file.write", writecontent: "file.write",
  edit: "file.edit", editfile: "file.edit", replaceinfile: "file.edit", applydiff: "file.edit", applypatch: "file.edit", insertcontent: "file.edit", searchandreplace: "file.edit", multiedit: "file.edit", strreplace: "file.edit", editnotebook: "file.edit",
  grep: "file.grep", grepsearch: "file.grep", searchfiles: "file.grep", searchfilecontent: "file.grep", ripgrepsearch: "file.grep", contentsearch: "file.grep",
  glob: "file.glob", globfilesearch: "file.glob", fileglobsearch: "file.glob", globsearch: "file.glob", findfiles: "file.glob",
  ls: "file.glob", list: "file.glob", listfiles: "file.glob", listdir: "file.glob", listdirtoplevel: "file.glob", listrecursivebymatchtype: "file.glob",
  bash: "shell.run", command: "shell.run", executecommand: "shell.run", runterminalcommand: "shell.run", runterminalcmd: "shell.run", terminalcommand: "shell.run",
  webfetch: "web.fetch", fetchwebpage: "web.fetch", readurlcontent: "web.fetch", fetch: "web.fetch",
  websearch: "web.search", searchweb: "web.search", searchwebfromquery: "web.search",
  browseraction: "browser.navigate", inspectsite: "browser.navigate", browsernavigate: "browser.navigate",
  usemcptool: "mcp.call",
  newtask: "subagent.spawn", subtask: "subagent.spawn", task: "subagent.spawn", spawnagent: "subagent.spawn",
  todowrite: "todo.write",
};
function mapTool(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const arc = TOOL_KIND_MAP[key];
  if (!arc) return { name, args };
  const p = (...ks: string[]): string | undefined => {
    for (const k of ks) {
      const v = args[k];
      if (typeof v === "string" && v) return v;
    }
    return undefined;
  };
  let conv: Record<string, unknown> | undefined;
  if (arc === "file.read") {
    const path = p("path", "filepath", "file_path", "filePath", "filename", "target_file");
    if (path) conv = { path };
  } else if (arc === "file.write") {
    const path = p("path", "filepath", "file_path", "filePath", "filename", "target_file");
    const content = typeof args.content === "string" ? args.content : undefined;
    if (path || content !== undefined) conv = { ...(path ? { path } : {}), ...(content !== undefined ? { content } : {}) };
  } else if (arc === "file.edit") {
    const path = p("path", "filepath", "file_path", "filePath", "filename", "target_file");
    const search = p("search", "old_string", "oldstring", "oldString", "find_text", "diff");
    const replace = p("replace", "new_string", "newstring", "newString", "replacement");
    if (path || search || replace) conv = { ...(path ? { path } : {}), ...(search ? { search } : {}), ...(replace ? { replace } : {}) };
  } else if (arc === "file.grep") {
    const pattern = p("pattern", "query", "regex", "search_query", "query_to_search");
    const include = p("include", "file_pattern", "filePattern");
    if (pattern || include) conv = { ...(pattern ? { pattern } : {}), ...(include ? { include } : {}) };
  } else if (arc === "file.glob") {
    const pattern = p("pattern", "glob", "dirPath", "dirpath", "directory", "path");
    if (pattern) conv = { pattern };
  } else if (arc === "shell.run") {
    const command = p("command", "cmd");
    const cwd = p("cwd", "working_dir", "workingDir");
    if (command || cwd) conv = { ...(command ? { command } : {}), ...(cwd ? { cwd } : {}) };
  } else if (arc === "web.fetch") {
    const url = p("url", "uri", "baseUrl");
    if (url) conv = { url };
  } else if (arc === "web.search") {
    const query = p("query", "q", "search_query");
    if (query) conv = { query };
  }
  return { name: arc, args: conv && Object.keys(conv).length ? conv : args };
}
function catalogKind(provider: string): { kind: ProviderKind; label?: string; baseUrl?: string } {
  const lower = provider.toLowerCase();
  const alias = KIND_ALIASES[lower] ?? KIND_ALIASES[slug(lower)];
  const target = (alias ?? slug(lower)).replace(/[^a-z0-9.-]/g, "");
  const spec = PROVIDERS.find((p) => p.kind === target);
  if (spec) return { kind: spec.kind, label: spec.label, baseUrl: spec.defaultBaseUrl };
  return { kind: "openai-compatible" };
}
function labelFor(provider: string, kind: ProviderKind): string {
  const spec = PROVIDERS.find((p) => p.kind === kind);
  return spec?.label ?? provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function ts(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n < 1e12 ? n * 1000 : n);
}
function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text" && typeof (b as Record<string, unknown>).text === "string").map((b) => (b as Record<string, unknown>).text as string).join("\n");
  }
  return "";
}
function tryParse(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== "string") return undefined;
  try { const p = JSON.parse(v); return p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, unknown> : undefined; } catch { return undefined; }
}
type SqliteDb = { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; get(...params: unknown[]): Record<string, unknown> | undefined; iterate(...params: unknown[]): IterableIterator<Record<string, unknown>> }; close(): void };
let sqliteLoader: (() => { DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => SqliteDb }) | undefined;
function openSqlite(dbPath: string): { db: SqliteDb; dispose: () => Promise<void> } | undefined {
  if (!sqliteLoader) {
    try { sqliteLoader = () => require("node:sqlite"); } catch { return undefined; }
  }
  let DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => SqliteDb;
  try { ({ DatabaseSync } = sqliteLoader()); } catch { return undefined; }
  try { const db = new DatabaseSync(dbPath, { readOnly: true }); return { db, dispose: async () => { try { db.close(); } catch { } } }; } catch { }
  const tmp = path.join(os.tmpdir(), `arc-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    let totalBytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = dbPath + suffix;
      if (!fs.existsSync(src)) continue;
      totalBytes += fs.statSync(src).size;
      if (totalBytes > 512 * 1024 * 1024) return undefined;
    }
    fs.mkdirSync(tmp, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = dbPath + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, path.basename(dbPath) + suffix));
    }
    return { db: new DatabaseSync(path.join(tmp, path.basename(dbPath)), { readOnly: true }), dispose: async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); } };
  } catch {
    void fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return undefined;
  }
}
function homePaths(home: string) {
  const appData = path.join(home, "AppData", "Roaming");
  return {
    clineSecrets: path.join(home, ".cline", "data", "secrets.json"),
    clineTasks: [path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"), path.join(appData, "Code - Insiders", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks")],
    kiloDb: path.join(home, ".local", "share", "kilo", "kilo.db"),
    opencodeDb: path.join(home, ".local", "share", "opencode", "opencode.db"),
    opencodeAuth: path.join(home, ".local", "share", "opencode", "auth.json"),
    zcodeDb: path.join(home, ".zcode", "cli", "db", "db.sqlite"),
    zcodeConfig: path.join(home, ".zcode", "v2", "config.json"),
    continueSessions: path.join(home, ".continue", "sessions"),
    continueConfig: path.join(home, ".continue", "config.yaml"),
  };
}
function readJson(p: string): unknown {
  try {
    const stat = fs.statSync(p);
    if (stat.size > 64 * 1024 * 1024) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return undefined; }
}
const MAX_SCAN_ENTRIES = 2000;
function pushCredential(out: ImportCredential[], agent: string, rec: { provider: string; id?: string; baseUrl?: string; apiKey: unknown }) {
  const key = typeof rec.apiKey === "string" ? rec.apiKey : "";
  if (!key) return;
  const mapped = catalogKind(rec.provider);
  out.push({
    key: `${agent}|${slug(rec.provider)}|${key.slice(-8)}`,
    agent,
    provider: rec.provider,
    label: labelFor(rec.provider, mapped.kind),
    kind: mapped.kind,
    baseUrl: rec.baseUrl ?? mapped.baseUrl,
    apiKey: key,
  });
}
function dedupeCredentials(creds: ImportCredential[]): ImportCredential[] {
  const seen = new Set<string>();
  return creds.filter((c) => {
    const fingerprint = `${c.provider}|${c.apiKey}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}
function collectSqliteCredentials(out: ImportCredential[], agent: string, dbPath: string, table: string) {
  const opened = openSqlite(dbPath);
  if (!opened) return;
  const { db, dispose } = opened;
  try {
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
      if (!row.integration_id) continue;
      const parsed = tryParse(row.value) ?? {};
      if (parsed.type === "oauth" || typeof parsed.refresh === "string") continue;
      const provider = String(row.integration_id);
      const key = typeof parsed.key === "string" ? parsed.key : typeof parsed.apiKey === "string" ? parsed.apiKey : typeof parsed.token === "string" ? parsed.token : undefined;
      if (!key || key === "opencode-oauth-dummy-key") continue;
      pushCredential(out, agent, { provider, baseUrl: (parsed.baseUrl ?? parsed.base_url) as string | undefined, apiKey: key });
    }
  } catch { } finally { void dispose(); }
}
function collectJsonCredentials(out: ImportCredential[], agent: string, filePath: string) {
  const root = readJson(filePath);
  if (!root || typeof root !== "object") return;
  if (path.basename(filePath) === "secrets.json" || path.basename(filePath) === "auth.json") {
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      if (/(oauth|nonce|secrets|credentials|accountid|sessiontoken|refreshtoken|accesstoken)$/i.test(k) || /^(cline|api)$/i.test(k.replace(/(ApiKey|Token)$/i, ""))) continue;
      if (typeof v === "string") pushCredential(out, agent, { provider: k.replace(/(ApiKey|Token)$/i, ""), apiKey: v });
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (o.type === "oauth") continue;
        pushCredential(out, agent, { provider: k, apiKey: o.key ?? o.apiKey ?? o.token, baseUrl: (typeof o.baseUrl === "string" ? o.baseUrl : undefined) });
      }
    }
    return;
  }
  const providers = (root as Record<string, unknown>).provider;
  if (!providers || typeof providers !== "object") return;
  for (const [pid, pv] of Object.entries(providers as Record<string, unknown>)) {
    const o = pv && typeof pv === "object" ? (pv as Record<string, unknown>).options as Record<string, unknown> | undefined : undefined;
    if (!o || typeof o.apiKey !== "string" || !o.apiKey) continue;
    pushCredential(out, agent, { provider: String((pv as Record<string, unknown>).name ?? pid), baseUrl: typeof o.baseURL === "string" ? o.baseURL : typeof o.baseUrl === "string" ? o.baseUrl : undefined, apiKey: o.apiKey });
  }
}
function parseContinueYaml(text: string): { provider: string; model: string; baseUrl?: string; apiKey: string }[] {
  const out: { provider: string; model: string; baseUrl?: string; apiKey: string }[] = [];
  let current: Partial<{ provider: string; model: string; baseUrl: string; apiKey: string }> | null = null;
  const flush = () => { if (current?.apiKey) out.push(current as { provider: string; model: string; baseUrl?: string; apiKey: string }); current = null; };
  const unquote = (s: string) => s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
  let inModels = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(line);
    if (indent === 0) { flush(); inModels = kv?.[1] === "models"; continue; }
    if (line.startsWith("- ")) {
      flush();
      if (inModels) current = {};
      const first = /^-\s*(\w+)\s*:\s*(.*)$/.exec(line);
      if (current && first) (current as Record<string, unknown>)[first[1]] = unquote(first[2]);
      continue;
    }
    if (kv && current) {
      if (kv[1] === "model") current.model = unquote(kv[2]);
      else if (kv[1] === "provider") current.provider = unquote(kv[2]);
      else if (kv[1] === "apiBase") current.baseUrl = unquote(kv[2]);
      else if (kv[1] === "apiKey") current.apiKey = unquote(kv[2]);
      else (current as Record<string, unknown>)[kv[1]] = unquote(kv[2]);
    }
  }
  flush();
  return out;
}
export async function scanAgentImports(home: string = os.homedir()): Promise<ImportAgentSummary[]> {
  const p = homePaths(home);
  const out: ImportAgentSummary[] = [];
  const exists = (f: string) => { try { return fs.existsSync(f); } catch { return false; } };
  if (exists(p.clineSecrets) || p.clineTasks.some((t) => exists(t))) {
    const creds: ImportCredential[] = [];
    collectJsonCredentials(creds, "Cline", p.clineSecrets);
    let chats = 0, messages = 0;
    for (const tasksDir of p.clineTasks) {
      let dirs: string[] = [];
      try { dirs = (await fsp.readdir(tasksDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).slice(0, MAX_SCAN_ENTRIES); } catch { continue; }
      for (const dir of dirs) {
        const file = path.join(tasksDir, dir, "api_conversation_history.json");
        const v = readJson(file);
        if (Array.isArray(v)) { chats++; messages += v.length; }
      }
    }
    out.push({ agent: "Cline", via: "VS Code extension saoudrizwan.claude-dev", chats, messages, credentials: dedupeCredentials(creds) });
  }
  if (exists(p.kiloDb)) {
    const creds: ImportCredential[] = [];
    collectSqliteCredentials(creds, "Kilo Code", p.kiloDb, "credential");
    const opened = openSqlite(p.kiloDb);
    let chats = 0, messages = 0;
    if (opened) {
      try {
        const row = opened.db.prepare("SELECT COUNT(DISTINCT session_id) chats, COUNT(*) messages FROM message").get();
        chats = Number(row?.chats ?? 0); messages = Number(row?.messages ?? 0);
      } catch { } finally { void opened.dispose(); }
    }
    out.push({ agent: "Kilo Code", via: p.kiloDb.replace(home, "~"), chats, messages, credentials: dedupeCredentials(creds) });
  }
  if (exists(p.opencodeDb) || exists(p.opencodeAuth)) {
    const creds: ImportCredential[] = [];
    collectJsonCredentials(creds, "OpenCode", p.opencodeAuth);
    const opened = openSqlite(p.opencodeDb);
    let chats = 0, messages = 0;
    if (opened) {
      try {
        const row = opened.db.prepare("SELECT COUNT(DISTINCT session_id) chats, COUNT(*) messages FROM message").get();
        chats = Number(row?.chats ?? 0); messages = Number(row?.messages ?? 0);
      } catch { } finally { void opened.dispose(); }
    }
    out.push({ agent: "OpenCode", via: p.opencodeDb.replace(home, "~"), chats, messages, credentials: dedupeCredentials(creds) });
  }
  if (exists(p.zcodeDb) || exists(p.zcodeConfig)) {
    const creds: ImportCredential[] = [];
    collectJsonCredentials(creds, "ZCode", p.zcodeConfig);
    const opened = openSqlite(p.zcodeDb);
    let chats = 0, messages = 0;
    if (opened) {
      try {
        const row = opened.db.prepare("SELECT COUNT(DISTINCT session_id) chats, COUNT(*) messages FROM message").get();
        chats = Number(row?.chats ?? 0); messages = Number(row?.messages ?? 0);
      } catch { } finally { void opened.dispose(); }
    }
    out.push({ agent: "ZCode", via: p.zcodeDb.replace(home, "~"), chats, messages, credentials: dedupeCredentials(creds) });
  }
  if (exists(p.continueSessions) || exists(p.continueConfig)) {
    const creds: ImportCredential[] = [];
    try {
      for (const rec of parseContinueYaml(fs.readFileSync(p.continueConfig, "utf8"))) pushCredential(creds, "Continue", { provider: rec.provider || rec.model, baseUrl: rec.baseUrl, apiKey: rec.apiKey });
    } catch { }
    let chats = 0, messages = 0;
    try {
      const entries = await fsp.readdir(p.continueSessions, { withFileTypes: true });
      let scanned = 0;
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".json") || e.name === "sessions.json") continue;
        if (++scanned > MAX_SCAN_ENTRIES) break;
        const v = readJson(path.join(p.continueSessions, e.name));
        if (!v || typeof v !== "object" || !Array.isArray((v as Record<string, unknown>).history)) continue;
        chats++;
        for (const item of (v as Record<string, unknown>).history as unknown[]) {
          const o = item && typeof item === "object" && (item as Record<string, unknown>).message && typeof (item as Record<string, unknown>).message === "object" ? (item as Record<string, unknown>).message as Record<string, unknown> : item as Record<string, unknown>;
          if (o?.role !== "user" && o?.role !== "assistant" && o?.role !== "thinking") continue;
          if (textBlocks(o.content).trim()) messages++;
        }
      }
    } catch { }
    out.push({ agent: "Continue", via: p.continueSessions.replace(home, "~"), chats, messages, credentials: dedupeCredentials(creds) });
  }
  return out;
}
export async function importAgentCredentials(summaries: ImportAgentSummary[], agent: string, keys: string[]): Promise<ImportCredential[]> {
  const summary = summaries.find((s) => s.agent === agent);
  if (!summary) return [];
  const wanted = new Set(keys);
  return summary.credentials.filter((c) => wanted.has(c.key));
}
export interface ImportProviderRef { id: string; kind: string; baseUrl?: string; apiKey?: string; apiKeys?: string[] }
export type CredentialPlan = { action: "create" } | { action: "append"; id: string; index: number } | { action: "skip"; id: string };
export function credentialTarget(providers: ImportProviderRef[], cred: ImportCredential): CredentialPlan {
  const existing = providers.find((p) => {
    if (p.kind !== cred.kind) return false;
    if (p.baseUrl && cred.baseUrl) return p.baseUrl === cred.baseUrl;
    if (cred.kind === "openai-compatible") return false;
    return true;
  });
  if (!existing) return { action: "create" };
  const cur = existing.apiKeys?.length ? existing.apiKeys : existing.apiKey ? [existing.apiKey] : [];
  if (cur.includes(cred.apiKey)) return { action: "skip", id: existing.id };
  return { action: "append", id: existing.id, index: cur.length };
}
type PendingChat = { sessionId: string; title?: string; createdAt: number; updatedAt: number; messages: ImportedMessage[]; steps: ImportedStep[]; callsById: Map<string, { name: string; args: Record<string, unknown> }> };
function finishChat(pending: PendingChat, agentSlug: string, sink: (chat: ImportedChat) => void): { messages: number; bytes: number } {
  const kept = pending.messages.filter((m) => m.content.trim() || m.toolCalls?.length || (m.role === "tool" && m.toolCallId));
  if (!kept.length && !pending.steps.length) return { messages: 0, bytes: 0 };
  const createdAt = kept[0]?.ts || pending.createdAt || Date.now();
  const updatedAt = kept[kept.length - 1]?.ts || pending.updatedAt || createdAt;
  const title = (pending.title ?? kept.find((m) => m.role === "user")?.content ?? pending.sessionId).slice(0, 60).trim() || pending.sessionId;
  sink({ id: `imp-${agentSlug}-${pending.sessionId}`.slice(0, 120), title, createdAt, updatedAt, messages: kept, steps: pending.steps });
  return { messages: kept.length, bytes: kept.reduce((n, m) => n + m.content.length + (m.thinking?.length ?? 0), 0) + pending.steps.reduce((n, s) => n + (s.content?.length ?? 0) + (s.output?.length ?? 0), 0) };
}
export async function importAgentChats(agent: string, home: string, sink: (chat: ImportedChat) => void, onProgress?: (done: number, total: number) => void): Promise<ImportChatsResult> {
  const p = homePaths(home);
  const agentSlug = slug(agent);
  const MAX_IMPORT_CHATS = 200;
  const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
  let chats = 0, messages = 0, bytes = 0;
  if (agent === "Cline") {
    let dirs: string[] = [];
    for (const tasksDir of p.clineTasks) {
      try { dirs = dirs.concat((await fsp.readdir(tasksDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).map((n) => path.join(tasksDir, n))); } catch { }
    }
    const capped = dirs.slice(0, MAX_IMPORT_CHATS);
    let done = 0;
    for (const dir of capped) {
      if (bytes >= MAX_IMPORT_BYTES) break;
      const v = readJson(path.join(dir, "api_conversation_history.json"));
      if (!Array.isArray(v)) { done++; continue; }
      const pending: PendingChat = { sessionId: path.basename(dir), createdAt: 0, updatedAt: 0, messages: [], steps: [], callsById: new Map() };
      for (const m of v) {
        if (!m || typeof m !== "object") continue;
        const o = m as Record<string, unknown>;
        const t = ts(o.ts);
        const blocks = Array.isArray(o.content) ? o.content as Record<string, unknown>[] : typeof o.content === "string" ? [{ type: "text", text: o.content }] : [];
        const texts: string[] = [];
        let thinking: string | undefined;
        const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
        const results: { toolCallId?: string; content: string }[] = [];
        for (const b of blocks) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
          else if (b.type === "thinking" || b.type === "reasoning") {
            const s = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
            if (s) thinking = thinking ? `${thinking}\n${s}` : s;
          } else if (b.type === "tool_use") {
            const mapped = mapTool(String(b.name ?? "tool"), (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>);
            calls.push({ id: String(b.id ?? ""), name: mapped.name, args: mapped.args });
          } else if (b.type === "tool_result") {
            const inner = typeof b.content === "string" ? b.content : textBlocks(b.content);
            if (inner) results.push({ toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined, content: inner });
          }
        }
        if (o.role === "assistant") {
          pending.messages.push({ role: "assistant", content: texts.join("\n"), ts: t, ...(thinking ? { thinking } : {}), ...(calls.length ? { toolCalls: calls } : {}) });
          if (thinking) pending.steps.push({ id: `${o.ts ?? t}-thought`, type: "thought", title: "Thinking", ts: t, content: thinking });
          for (const c of calls) {
            pending.callsById.set(c.id, c);
            pending.steps.push({ id: c.id || `${o.ts}-${c.name}`, type: "tool", title: prettyToolTitle(c.name, c.args, "processing"), ts: t, toolName: c.name });
          }
        } else if (o.role === "user") {
          if (texts.join("\n").trim()) pending.messages.push({ role: "user", content: texts.join("\n"), ts: t });
          for (const r of results) {
            pending.messages.push({ role: "tool", content: r.content, ts: t, ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}) });
            if (r.toolCallId) {
              const st = pending.steps.find((s) => s.type === "tool" && s.id === r.toolCallId);
              if (st) {
                st.output = r.content;
                const call = pending.callsById.get(r.toolCallId);
                if (call) st.title = prettyToolTitle(call.name, call.args, "done");
              }
            }
          }
        } else continue;
        if (t && (!pending.createdAt || t < pending.createdAt)) pending.createdAt = t;
        if (t && t > pending.updatedAt) pending.updatedAt = t;
      }
      const r = finishChat(pending, agentSlug, sink);
      chats++; messages += r.messages; bytes += r.bytes;
      done++;
      if (done % 5 === 0 || done === capped.length) onProgress?.(done, capped.length);
    }
  } else if (agent === "Continue") {
    const indexDates = new Map<string, number>();
    try {
      const idx = readJson(path.join(p.continueSessions, "sessions.json"));
      if (Array.isArray(idx)) {
        for (const e of idx) {
          if (!e || typeof e !== "object" || typeof (e as Record<string, unknown>).sessionId !== "string") continue;
          indexDates.set((e as Record<string, unknown>).sessionId as string, ts((e as Record<string, unknown>).dateCreated));
        }
      }
    } catch { }
    let files: string[] = [];
    try { files = (await fsp.readdir(p.continueSessions, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".json") && e.name !== "sessions.json").map((e) => path.join(p.continueSessions, e.name)); } catch { }
    const capped = files.slice(0, MAX_IMPORT_CHATS);
    let done = 0;
    for (const file of capped) {
      if (bytes >= MAX_IMPORT_BYTES) break;
      const v = readJson(file);
      if (!v || typeof v !== "object") { done++; continue; }
      const sess = v as Record<string, unknown>;
      if (!Array.isArray(sess.history)) { done++; continue; }
      const pending: PendingChat = { sessionId: String(sess.sessionId ?? path.basename(file, ".json")), title: typeof sess.title === "string" ? sess.title : undefined, createdAt: 0, updatedAt: 0, messages: [], steps: [], callsById: new Map() };
      const baseTs = indexDates.get(pending.sessionId) || ts(sess.dateCreated) || Date.now();
      let idx = 0;
      for (const item of sess.history) {
        if (!item || typeof item !== "object") { idx++; continue; }
        const o = (item as Record<string, unknown>).message && typeof (item as Record<string, unknown>).message === "object" ? (item as Record<string, unknown>).message as Record<string, unknown> : item as Record<string, unknown>;
        const role = o.role === "assistant" || o.role === "thinking" ? "assistant" : o.role === "user" || o.role === "tool" ? o.role : undefined;
        if (!role) { idx++; continue; }
        const t = ts((item as Record<string, unknown>).dateCreated) || baseTs + idx;
        const content = textBlocks(o.content);
        if (o.role === "thinking") {
          if (content.trim()) pending.steps.push({ id: `${pending.sessionId}-t${idx}`, type: "thought", title: "Thinking", ts: t, content });
        } else if (role === "assistant") {
          const toolCalls = Array.isArray(o.toolCalls) ? (o.toolCalls as Record<string, unknown>[]).map((c) => {
            const fn = c.function && typeof c.function === "object" ? c.function as Record<string, unknown> : {};
            let args: Record<string, unknown> = {};
            try { const p = JSON.parse(String(fn.arguments ?? "{}")); if (p && typeof p === "object") args = p as Record<string, unknown>; } catch { }
            const mapped = mapTool(String(fn.name ?? c.name ?? "tool"), args);
            return { id: String(c.id ?? ""), name: mapped.name, args: mapped.args };
          }).filter((c) => c.id) : undefined;
          pending.messages.push({ role, content, ts: t, ...(toolCalls?.length ? { toolCalls } : {}) });
          for (const c of toolCalls ?? []) {
            pending.callsById.set(c.id, c);
            pending.steps.push({ id: c.id, type: "tool", title: prettyToolTitle(c.name, c.args, "processing"), ts: t, toolName: c.name });
          }
        } else {
          const toolCallId = o.toolCallId ? String(o.toolCallId) : undefined;
          pending.messages.push({ role, content, ts: t, ...(toolCallId ? { toolCallId } : {}) });
          if (role === "tool" && toolCallId && content) {
            const st = pending.steps.find((s) => s.type === "tool" && s.id === toolCallId);
            if (st) {
              st.output = content;
              const call = pending.callsById.get(toolCallId);
              if (call) st.title = prettyToolTitle(call.name, call.args, "done");
            }
          }
        }
        if (t && (!pending.createdAt || t < pending.createdAt)) pending.createdAt = t;
        if (t && t > pending.updatedAt) pending.updatedAt = t;
        idx++;
      }
      const r = finishChat(pending, agentSlug, sink);
      chats++; messages += r.messages; bytes += r.bytes;
      done++;
      onProgress?.(done, capped.length);
    }
  } else {
    const dbPath = agent === "Kilo Code" ? p.kiloDb : agent === "ZCode" ? p.zcodeDb : agent === "OpenCode" ? p.opencodeDb : undefined;
    if (!dbPath) throw new Error(`Unknown agent: ${agent}`);
    const opened = openSqlite(dbPath);
    if (!opened) throw new Error(`SQLite is unavailable in this runtime; cannot import ${agent} chats.`);
    const { db, dispose } = opened;
    try {
      let sessions: { session_id: string; t: number }[] = [];
      try { sessions = db.prepare("SELECT session_id, MAX(time_created) t FROM message GROUP BY session_id ORDER BY t DESC").all().map((r) => ({ session_id: String(r.session_id), t: Number(r.t ?? 0) })); } catch { }
      const capped = sessions.slice(0, MAX_IMPORT_CHATS);
      const titles = new Map<string, string>();
      try {
        for (const r of db.prepare("SELECT id, title FROM session").all()) {
          const t = typeof r.title === "string" ? r.title : "";
          if (r.id && t && !/^(new|child) session - /i.test(t)) titles.set(String(r.id), t);
        }
      } catch { }
      let done = 0;
      for (const sess of capped) {
        if (bytes >= MAX_IMPORT_BYTES) break;
        const texts = new Map<string, string[]>();
        const thoughts = new Map<string, string[]>();
        const toolCalls = new Map<string, { calls: { id: string; name: string; args: Record<string, unknown> }[]; results: Map<string, string>; failed: Set<string> }>();
        try {
          for (const part of db.prepare(`SELECT message_id, data FROM part WHERE session_id = ? AND (data LIKE '%"type":"text"%' OR data LIKE '%"type":"reasoning"%' OR data LIKE '%"type":"tool"%') ORDER BY rowid`).iterate(sess.session_id)) {
            const parsed = tryParse(part.data);
            if (!parsed) continue;
            const parsedText = typeof parsed.text === "string" ? parsed.text : undefined;
            if (!parsedText && parsed.type !== "tool") continue;
            const mid = String(part.message_id);
            if (parsed.type === "reasoning") {
              const list = thoughts.get(mid) ?? [];
              if (list.length === 0 || list[list.length - 1] !== parsedText) list.push(parsedText!);
              thoughts.set(mid, list);
            } else if (parsed.type === "tool") {
              const state = parsed.state && typeof parsed.state === "object" ? parsed.state as Record<string, unknown> : {};
              const entry = toolCalls.get(mid) ?? { calls: [], results: new Map<string, string>(), failed: new Set<string>() };
              const callId = String(parsed.callID ?? `call-${mid}-${entry.calls.length}`);
              const mapped = mapTool(String(parsed.tool ?? "tool"), (state.input && typeof state.input === "object" ? state.input : {}) as Record<string, unknown>);
              entry.calls.push({ id: callId, name: mapped.name, args: mapped.args });
              if (typeof state.output === "string") entry.results.set(callId, state.output);
              else if (state.status === "error" && typeof state.error === "string") entry.results.set(callId, state.error);
              if (state.status === "error") entry.failed.add(callId);
              toolCalls.set(mid, entry);
            } else {
              const list = texts.get(mid) ?? [];
              if (list.length === 0 || list[list.length - 1] !== parsedText) list.push(parsedText!);
              texts.set(mid, list);
            }
          }
        } catch { }
        const pending: PendingChat = { sessionId: sess.session_id, title: titles.get(sess.session_id), createdAt: sess.t || 0, updatedAt: sess.t || 0, messages: [], steps: [], callsById: new Map() };
        try {
          for (const m of db.prepare("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created").iterate(sess.session_id)) {
            const meta = tryParse(m.data) ?? {};
            const role = meta.role === "assistant" ? "assistant" : meta.role === "user" ? "user" : undefined;
            if (!role) continue;
            const mid = String(m.id ?? "");
            const content = (texts.get(mid) ?? []).join("\n");
            const thinking = (thoughts.get(mid) ?? []).join("\n");
            const tcs = toolCalls.get(mid);
            const t = Number(m.time_created ?? 0);
            const tsMs = t > 0 ? Math.floor(t < 1e12 ? t * 1000 : t) : 0;
            const msg: ImportedMessage = { role, content, ts: tsMs };
            if (thinking) { msg.thinking = thinking; pending.steps.push({ id: `${mid}-thought`, type: "thought", title: "Thinking", ts: tsMs, content: thinking }); }
            if (tcs?.calls.length) msg.toolCalls = tcs.calls;
            pending.messages.push(msg);
            for (const [callId, output] of tcs?.results ?? []) {
              const call = tcs!.calls.find((c) => c.id === callId);
              pending.messages.push({ role: "tool", content: output, ts: tsMs, toolCallId: callId });
              pending.steps.push({ id: `${mid}-${callId}`, type: "tool", title: prettyToolTitle(call?.name ?? "tool", call?.args ?? {}, tcs!.failed.has(callId) ? "error" : "done"), ts: tsMs, output, toolName: call?.name });
            }
            if (t > 0) { const ms = t < 1e12 ? t * 1000 : t; if (!pending.createdAt || ms < pending.createdAt) pending.createdAt = ms; if (ms > pending.updatedAt) pending.updatedAt = ms; }
          }
        } catch { }
        const r = finishChat(pending, agentSlug, sink);
        chats++; messages += r.messages; bytes += r.bytes;
        done++;
        onProgress?.(done, capped.length);
      }
    } finally { void dispose(); }
  }
  return { chats, messages, bytes };
}