import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { scanAgentImports, importAgentChats, importAgentCredentials, credentialTarget, maskKey } from "../src/import/import";
import type { ImportedChat } from "../src/import/import";
let home: string;
let chats: ImportedChat[];
function makeSqlite(dbPath: string) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)");
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, data TEXT, time_created INTEGER)");
  db.exec("CREATE TABLE part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT, data TEXT)");
  db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
  return db;
}
function kiloSession(db: unknown, sessionId: string, count: number, startTs: number) {
  const d = db as { prepare(sql: string): { run(...p: unknown[]): unknown } };
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const mid = `${sessionId}-m${i}`;
    const ts = startTs + i * 1000;
    d.prepare("INSERT INTO message (id, session_id, role, data, time_created) VALUES (?, ?, ?, ?, ?)").run(mid, sessionId, role, JSON.stringify({ role }), ts);
    d.prepare("INSERT INTO part (message_id, session_id, data) VALUES (?, ?, ?)").run(mid, sessionId, JSON.stringify({ type: "text", text: `${role} says ${i}` }));
    if (role === "assistant") {
      d.prepare("INSERT INTO part (message_id, session_id, data) VALUES (?, ?, ?)").run(mid, sessionId, JSON.stringify({ type: "reasoning", text: `thinking ${i}` }));
      d.prepare("INSERT INTO part (message_id, session_id, data) VALUES (?, ?, ?)").run(mid, sessionId, JSON.stringify({ type: "tool", callID: `${mid}-call`, tool: i === 1 ? "read" : "glob", state: i === 3 ? { status: "error", input: { pattern: "**/*.ts" }, error: `boom ${i}` } : { status: "completed", input: { filepath: "src/a.ts" }, output: `listing ${i}` } }));
    }
  }
}
beforeAll(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "arc-import-test-"));
  const appData = path.join(home, "AppData", "Roaming");
  const kilo = makeSqlite(path.join(home, ".local", "share", "kilo", "kilo.db"));
  for (let s = 0; s < 3; s++) kiloSession(kilo, `sess-${s}`, 4, 1700000000000 + s * 100000);
  kilo.prepare("INSERT INTO session (id, title) VALUES (?, ?)").run("sess-0", "Kilo auto-titled chat");
  kilo.prepare("INSERT INTO session (id, title) VALUES (?, ?)").run("sess-1", "New session - 2026-01-01T00:00:00.000Z");
  kilo.prepare("INSERT INTO credential (integration_id, value) VALUES (?, ?)").run("kilocode", JSON.stringify({ type: "key", key: "kilo-key-abcdefgh" }));
  kilo.prepare("INSERT INTO credential (integration_id, value) VALUES (?, ?)").run("anthropic", JSON.stringify({ type: "oauth", refresh: "r", access: "a", expires: 1 }));
  kilo.prepare("INSERT INTO credential (integration_id, value) VALUES (?, ?)").run("openai", JSON.stringify({ type: "key", key: "opencode-oauth-dummy-key" }));
  kilo.prepare("INSERT INTO credential (integration_id, value) VALUES (?, ?)").run(null, JSON.stringify({ type: "key", key: "orphan-key-123456" }));
  kilo.close();
  const taskDir = path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks", "task-1");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "api_conversation_history.json"), JSON.stringify([
    { role: "user", content: [{ type: "text", text: "hello cline" }], ts: 1700000001000 },
    { role: "assistant", content: [{ type: "text", text: "hi there" }], ts: 1700000002000 },
  ]));
  const taskDir2 = path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks", "task-2");
  fs.mkdirSync(taskDir2, { recursive: true });
  fs.writeFileSync(path.join(taskDir2, "api_conversation_history.json"), JSON.stringify([
    { role: "user", content: [{ type: "text", text: "use a tool" }], ts: 1700000003000 },
    { role: "assistant", content: [{ type: "thinking", thinking: "I will read the file" }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } }], ts: 1700000004000 },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents here" }], ts: 1700000005000 },
    { role: "assistant", content: [{ type: "text", text: "The file says hi" }], ts: 1700000006000 },
  ]));
  fs.mkdirSync(path.join(home, ".cline", "data"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cline", "data", "secrets.json"), JSON.stringify({
    "anthropicApiKey": "sk-ant-cline-key-12345678",
    "openRouterApiKey": "sk-or-cline-key-87654321",
    "openAiNativeApiKey": "sk-oai-cline-key-11223344",
    "clineAccountId": "should-be-skipped",
    "awsSessionToken": "should-be-skipped-too",
    "mcpOAuthSecrets": "{}",
    "authNonce": "nope",
  }));
  fs.mkdirSync(path.join(home, ".continue", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, ".continue", "sessions", "s1.json"), JSON.stringify({
    sessionId: "cont-1", title: "continue chat",
    history: [{ message: { role: "user", content: "continue q" } }, { message: { role: "assistant", content: "continue a" } }],
  }));
  fs.writeFileSync(path.join(home, ".continue", "sessions", "s2.json"), JSON.stringify({
    sessionId: "cont-2", title: "agent mode chat",
    history: [
      { message: { role: "user", content: [{ type: "text", text: "run ls" }] } },
      { message: { role: "assistant", content: "", toolCalls: [{ id: "call-1", type: "function", function: { name: "ls", arguments: "{\"dirPath\":\"/\"}" } }] } },
      { message: { role: "thinking", content: "I should list files first", reasoning_details: [] } },
      { message: { role: "tool", toolCallId: "call-1", content: "file1\nfile2" } },
      { message: { role: "assistant", content: "", toolCalls: [{ id: "call-2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] } },
      { message: { role: "thinking", content: "now I can answer" } },
      { message: { role: "assistant", content: "here is the listing" } },
    ],
  }));
  fs.writeFileSync(path.join(home, ".continue", "sessions", "sessions.json"), JSON.stringify([
    { sessionId: "cont-1", title: "continue chat", dateCreated: "1700000100000" },
    { sessionId: "cont-2", title: "agent mode chat", dateCreated: 1700000200000 },
  ]));
  fs.writeFileSync(path.join(home, ".continue", "config.yaml"), [
    "name: local assistant",
    "models:",
    "  - model: claude-x",
    "    provider: anthropic",
    "    apiKey: sk-continue-key-abcdef",
  ].join("\n"));
  const opencode = makeSqlite(path.join(home, ".local", "share", "opencode", "opencode.db"));
  kiloSession(opencode, "oc-1", 2, 1700000050000);
  opencode.close();
  fs.mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ "openai": { apiKey: "sk-openai-opencode-9999" } }));
  chats = [];
});
afterAll(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});
describe("maskKey", () => {
  it("masks short keys fully and long keys with head+tail", () => {
    expect(maskKey("shortkey")).toBe("\u2022\u2022\u2022");
    const masked = maskKey("sk-ant-very-long-api-key-value");
    expect(masked.startsWith("sk-a")).toBe(true);
    expect(masked.endsWith("alue")).toBe(true);
    expect(masked).not.toContain("very-long");
  });
});
describe("scanAgentImports", () => {
  it("detects all five agents with chat and credential counts", async () => {
    const summaries = await scanAgentImports(home);
    const byAgent = new Map(summaries.map((s) => [s.agent, s]));
    expect(byAgent.get("Kilo Code")?.chats).toBe(3);
    expect(byAgent.get("Kilo Code")?.messages).toBe(12);
    expect(byAgent.get("Kilo Code")?.credentials.length).toBe(1);
    expect(byAgent.get("Cline")?.chats).toBe(2);
    expect(byAgent.get("Cline")?.credentials.length).toBe(3);
    expect(byAgent.get("Continue")?.chats).toBe(2);
    expect(byAgent.get("Continue")?.credentials.length).toBe(1);
    expect(byAgent.get("OpenCode")?.chats).toBe(1);
    expect(byAgent.get("OpenCode")?.credentials.length).toBe(1);
    expect(byAgent.has("ZCode")).toBe(false);
  });
});
describe("importAgentCredentials", () => {
  it("returns only the requested keys with mapped kinds and no raw keys in previews", async () => {
    const summaries = await scanAgentImports(home);
    const kilo = summaries.find((s) => s.agent === "Kilo Code")!;
    const creds = await importAgentCredentials(summaries, "Kilo Code", [kilo.credentials[0].key]);
    expect(creds.length).toBe(1);
    expect(creds[0].apiKey).toBe("kilo-key-abcdefgh");
    expect(creds[0].kind).toBe("openai-compatible");
    expect(await importAgentCredentials(summaries, "Kilo Code", [])).toEqual([]);
  });
});
describe("credentialTarget", () => {
  const cred = { key: "k|openrouter|abcd1234", agent: "Cline", provider: "openrouter", label: "OpenRouter", kind: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-new-key" };
  it("creates a provider when none matches kind and baseUrl", () => {
    expect(credentialTarget([], cred)).toEqual({ action: "create" });
    expect(credentialTarget([{ id: "p1", kind: "openrouter", baseUrl: "https://other/v1" }], cred)).toEqual({ action: "create" });
    expect(credentialTarget([{ id: "p1", kind: "anthropic" }], cred)).toEqual({ action: "create" });
  });
  it("appends the key to an existing matching provider at the next index", () => {
    const providers = [{ id: "mine", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-old", apiKeys: ["sk-old"] }];
    expect(credentialTarget(providers, cred)).toEqual({ action: "append", id: "mine", index: 1 });
    expect(credentialTarget([{ id: "mine", kind: "openrouter", apiKey: "sk-old" }], { ...cred, baseUrl: undefined })).toEqual({ action: "append", id: "mine", index: 1 });
  });
  it("skips when the provider already holds the same key", () => {
    expect(credentialTarget([{ id: "mine", kind: "openrouter", apiKey: "sk-new-key" }], cred)).toEqual({ action: "skip", id: "mine" });
  });
  it("never merges openai-compatible keys without an exact baseUrl match", () => {
    const compat = { ...cred, kind: "openai-compatible" as const, baseUrl: undefined };
    expect(credentialTarget([{ id: "any", kind: "openai-compatible" }], compat)).toEqual({ action: "create" });
    expect(credentialTarget([{ id: "any", kind: "openai-compatible", baseUrl: "http://x/v1" }], { ...compat, baseUrl: "http://x/v1" })).toEqual({ action: "append", id: "any", index: 0 });
  });
});
describe("importAgentChats", () => {
  it("imports Kilo chats with content, thinking, and tool chains from part rows", async () => {
    const r = await importAgentChats("Kilo Code", home, (c) => chats.push(c));
    expect(r.chats).toBe(3);
    expect(r.messages).toBe(18);
    const sess2 = chats.find((c) => c.id.includes("sess-2"));
    expect(chats.find((c) => c.id.includes("sess-0"))?.title).toBe("Kilo auto-titled chat");
    expect(chats.find((c) => c.id.includes("sess-1"))?.title).toBe("user says 0");
    expect(sess2?.messages[0].content).toBe("user says 0");
    expect(sess2?.messages[0].role).toBe("user");
    const a1 = sess2?.messages[1];
    expect(a1?.content).toBe("assistant says 1");
    expect(a1?.thinking).toBe("thinking 1");
    expect(a1?.toolCalls).toEqual([{ id: "sess-2-m1-call", name: "file.read", args: { path: "src/a.ts" } }]);
    expect(sess2?.steps?.find((s) => s.type === "thought")?.content).toBe("thinking 1");
    const toolStep = sess2?.steps?.find((s) => s.type === "tool" && s.toolName === "file.read");
    expect(toolStep?.title).toBe("Read src/a.ts");
    expect(toolStep?.output).toBe("listing 1");
    expect(sess2?.steps?.find((s) => s.type === "tool" && s.toolName === "file.glob")?.title).toBe("Glob failed: **/*.ts");
    expect(sess2?.steps?.find((s) => s.type === "tool" && s.toolName === "file.glob")?.output).toBe("boom 3");
  });
  it("imports Cline chats from task JSON", async () => {
    const out: ImportedChat[] = [];
    await importAgentChats("Cline", home, (c) => out.push(c));
    expect(out.length).toBe(2);
    const simple = out.find((c) => c.id.includes("task-1"))!;
    expect(simple.messages.map((m) => m.content)).toEqual(["hello cline", "hi there"]);
    expect(simple.title).toBe("hello cline");
    const toolChat = out.find((c) => c.id.includes("task-2"))!;
    expect(toolChat.messages.map((m) => `${m.role}: ${m.content}`)).toEqual([
      "user: use a tool",
      "assistant: ",
      "tool: file contents here",
      "assistant: The file says hi",
    ]);
    const callMsg = toolChat.messages[1];
    expect(callMsg.toolCalls).toEqual([{ id: "toolu_1", name: "file.read", args: { path: "a.txt" } }]);
    expect(callMsg.thinking).toBe("I will read the file");
    expect(toolChat.messages[2].toolCallId).toBe("toolu_1");
    const step = toolChat.steps?.find((s) => s.id === "toolu_1");
    expect(step?.title).toBe("Read a.txt");
    expect(step?.output).toBe("file contents here");
    expect(toolChat.steps?.find((s) => s.type === "thought")?.content).toBe("I will read the file");
  });
  it("imports Continue chats and OpenCode chats", async () => {
    const cont: ImportedChat[] = [];
    await importAgentChats("Continue", home, (c) => cont.push(c));
    expect(cont.length).toBe(2);
    expect(cont.find((c) => c.id.includes("cont-1"))?.messages.length).toBe(2);
    expect(cont.find((c) => c.id.includes("cont-1"))?.createdAt).toBe(1700000100000);
    const agent = cont.find((c) => c.id.includes("cont-2"))!;
    expect(agent.messages.map((m) => `${m.role}: ${m.content}`)).toEqual([
      "user: run ls",
      "assistant: ",
      "tool: file1\nfile2",
      "assistant: ",
      "assistant: here is the listing",
    ]);
    expect(agent.messages[1].toolCalls).toEqual([{ id: "call-1", name: "file.glob", args: { pattern: "/" } }]);
    expect(agent.messages[2].toolCallId).toBe("call-1");
    expect(agent.messages[2].ts).toBeGreaterThan(agent.messages[1].ts);
    const lsStep = agent.steps?.find((s) => s.id === "call-1");
    expect(lsStep?.title).toBe("Globbed /");
    expect(lsStep?.output).toBe("file1\nfile2");
    expect(agent.steps?.filter((s) => s.type === "thought").map((s) => s.content)).toEqual(["I should list files first", "now I can answer"]);
    expect(agent.createdAt).toBe(1700000200000);
    expect(agent.updatedAt).toBe(1700000200006);
    const oc: ImportedChat[] = [];
    await importAgentChats("OpenCode", home, (c) => oc.push(c));
    expect(oc.length).toBe(1);
    expect(oc[0].messages[0].content).toBe("user says 0");
    expect(oc[0].messages[1].thinking).toBe("thinking 1");
  });
  it("imports every chat and message without caps", async () => {
    const out: ImportedChat[] = [];
    const r = await importAgentChats("Kilo Code", home, (c) => out.push(c));
    expect(out.length).toBe(3);
    expect(out.every((c) => c.messages.length === 6)).toBe(true);
    expect(r.messages).toBe(18);
  });
  it("throws for unknown agents", async () => {
    await expect(importAgentChats("Nope", home, () => {})).rejects.toThrow("Unknown agent");
  });
});