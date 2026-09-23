import { ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { assertSafeUrl, isPrivateAddress, readBodyLimited, safeFetch } from "../security/network.js";
import { redactSecrets } from "../security/redact.js";
import { spawnBounded, terminateProcessTree } from "../util/process.js";
import type { SandboxProfile } from "../sandbox/sandbox.js";
export type McpTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string>; auth?: "oauth" }
  | { type: "sse"; url: string; headers?: Record<string, string>; auth?: "oauth" };
export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: McpTransport;
}
export interface McpTrafficEntry {
  ts: number;
  dir: "in" | "out";
  info: string;
}
export type McpTrafficSink = (entry: McpTrafficEntry) => void;
export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}
export type McpTokenProvider = () => Promise<string | undefined>;
function isBearerChallenge(header?: string): boolean {
  return !!header && /^\s*Bearer(\s|,|$)/i.test(header);
}
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}
type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
export interface McpServerNotification {
  server: string;
  method: string;
  params?: unknown;
}
export type McpRequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type McpClientStatus = "idle" | "starting" | "ready" | "reconnecting" | "stopped" | "error";
export interface McpClientOptions {
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  workspaceRoot?: string;
  sandboxProfile?: SandboxProfile;
  trafficSink?: McpTrafficSink;
  tokenProvider?: McpTokenProvider;
  onAuthRequired?: (wwwAuthenticate?: string) => Promise<string | undefined>;
}
export class McpClient extends EventEmitter {
  private id = 0;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private proc?: ChildProcessByStdio<Writable, Readable, Readable>;
  private lastStderr = "";
  private httpAbort?: AbortController;
  private httpEndpoint?: string;
  private httpSessionId?: string;
  private httpReady = false;
  private status: McpClientStatus = "idle";
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private healthInflight: number | string | undefined;
  private shouldRun = false;
  private opts: Required<Pick<McpClientOptions, "reconnectInitialMs" | "reconnectMaxMs" | "healthIntervalMs" | "healthTimeoutMs">>;
  private requestHandler?: McpRequestHandler;
  private httpAllowPrivate = false;
  private workspaceRoot?: string;
  private sandboxProfile?: SandboxProfile;
  private trafficSink?: McpTrafficSink;
  private tokenProvider?: McpTokenProvider;
  private onAuthRequired?: (wwwAuthenticate?: string) => Promise<string | undefined>;
  private oauthPrompted = false;
  private lastAuthChallenge?: string;
  constructor(public config: McpServerConfig, options: McpClientOptions = {}) {
    super();
    this.opts = {
      reconnectInitialMs: options.reconnectInitialMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      healthIntervalMs: options.healthIntervalMs ?? 60_000,
      healthTimeoutMs: options.healthTimeoutMs ?? 10_000,
    };
    this.workspaceRoot = options.workspaceRoot;
    this.sandboxProfile = options.sandboxProfile;
    this.trafficSink = options.trafficSink;
    this.tokenProvider = options.tokenProvider;
    this.onAuthRequired = options.onAuthRequired;
  }
  private traffic(dir: "in" | "out", info: string): void {
    if (!this.trafficSink) return;
    try {
      this.trafficSink({ ts: Date.now(), dir, info: info.slice(0, 200) });
    } catch {}
  }
  getServerName(): string {
    return this.config.name;
  }
  getLastAuthChallenge(): string | undefined {
    return this.lastAuthChallenge;
  }
  getStatus(): McpClientStatus {
    return this.status;
  }
  setRequestHandler(handler: McpRequestHandler): void {
    this.requestHandler = handler;
  }
  private setStatus(next: McpClientStatus) {
    if (this.status === next) return;
    this.status = next;
    this.emit("status", next);
  }
  async start() {
    this.shouldRun = true;
    this.oauthPrompted = false;
    this.setStatus("starting");
    if (this.config.transport.type === "stdio") {
      await this.startStdio();
    } else {
      await this.startHttp();
    }
    try {
      await this.send({ method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: { roots: { listChanged: false }, sampling: {} }, clientInfo: { name: "arc", version: "0.1.0" } } });
      this.sendNotification("notifications/initialized");
      this.setStatus("ready");
      this.reconnectAttempts = 0;
      this.scheduleHealth();
    } catch (e) {
      this.setStatus("error");
      throw e;
    }
  }
  async stop() {
    this.shouldRun = false;
    this.clearReconnect();
    this.clearHealth();
    if (this.healthInflight !== undefined) {
      const p = this.pending.get(this.healthInflight);
      this.pending.delete(this.healthInflight);
      this.healthInflight = undefined;
      p?.reject(new Error("MCP client stopped"));
    }
    if (this.proc) terminateProcessTree(this.proc);
    this.httpAbort?.abort();
    this.proc = undefined;
    this.httpAbort = undefined;
    this.httpEndpoint = undefined;
    this.httpSessionId = undefined;
    this.httpReady = false;
    this.setStatus("stopped");
    const reason = "client stopped";
    for (const [id, p] of this.pending) {
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
  async listTools(): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]> {
    const r = await this.send({ method: "tools/list" });
    const tools = (r as { tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] })?.tools ?? [];
    return tools;
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const r = await this.send({ method: "tools/call", params: { name, arguments: args } });
    return (r as { content?: unknown }).content ?? r;
  }
  async listResources(): Promise<{ uri: string; name?: string; description?: string; mimeType?: string }[]> {
    const r = await this.send({ method: "resources/list" });
    return (r as { resources?: { uri: string; name?: string; description?: string; mimeType?: string }[] })?.resources ?? [];
  }
  async readResource(uri: string): Promise<unknown> {
    const r = await this.send({ method: "resources/read", params: { uri } });
    return (r as { contents?: unknown }).contents ?? r;
  }
  async listPrompts(): Promise<{ name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }[]> {
    const r = await this.send({ method: "prompts/list" });
    return (r as { prompts?: { name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }[] })?.prompts ?? [];
  }
  async getPrompt(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const r = await this.send({ method: "prompts/get", params: { name, ...(args ? { arguments: args } : {}) } });
    return r;
  }
  private async send(req: Omit<JsonRpcRequest, "jsonrpc" | "id"> & { id?: number | string }): Promise<unknown> {
    const id = req.id ?? ++this.id;
    const full: JsonRpcRequest = { jsonrpc: "2.0", id, method: req.method, params: req.params };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request '${req.method}' timed out`));
        }
      }, 60_000);
      if (typeof (timer as unknown as { unref?: () => void }).unref === "function") (timer as unknown as { unref: () => void }).unref();
      this.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
    });
    if (this.config.transport.type === "stdio") {
      if (!this.proc) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        throw new Error("MCP stdio process is not running");
      }
      this.traffic("out", describeJsonRpc(full));
      try {
        this.proc.stdin.write(JSON.stringify(full) + "\n");
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.reject(err);
        }
        throw err;
      }
    } else {
      if (!this.httpReady || !this.httpEndpoint) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        throw new Error("MCP HTTP transport is not connected");
      }
      this.sendHttp(full).catch((e) => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    }
    return promise;
  }
  private async authHeaders(): Promise<Record<string, string>> {
    const t = this.config.transport;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(t.type === "stdio" ? {} : t.headers),
    };
    if (t.type !== "stdio") {
      let token = this.tokenProvider ? await this.tokenProvider() : undefined;
      if (!token && t.auth === "oauth" && this.onAuthRequired) {
        token = await this.challengeAuth(undefined);
      }
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }
  private async challengeAuth(wwwAuthenticate?: string): Promise<string | undefined> {
    const t = this.config.transport;
    if (t.type === "stdio") return undefined;
    if (t.auth !== "oauth" && !isBearerChallenge(wwwAuthenticate)) return undefined;
    if (!this.onAuthRequired || this.oauthPrompted) return undefined;
    if (wwwAuthenticate) this.lastAuthChallenge = wwwAuthenticate;
    this.oauthPrompted = true;
    this.traffic("out", "oauth authorization required");
    try {
      return await this.onAuthRequired(wwwAuthenticate);
    } catch (e) {
      this.traffic("in", `oauth failed: ${(e as Error).message}`);
      return undefined;
    }
  }
  private async sendHttp(req: JsonRpcRequest, retried = false): Promise<void> {
    if (!this.httpEndpoint) throw new Error("MCP HTTP endpoint not set");
    const t = this.config.transport;
    if (t.type !== "http" && t.type !== "sse") throw new Error("MCP transport is not HTTP-based");
    const endpoint = this.httpEndpoint;
    const headers = await this.authHeaders();
    if (this.httpSessionId) headers["mcp-session-id"] = this.httpSessionId;
    this.traffic("out", describeJsonRpc(req));
    const res = await safeFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
      signal: this.httpAbort?.signal,
    }, { allowPrivate: this.httpAllowPrivate, allowHttpLoopback: true, sameOrigin: t.url });
    if (res.status === 401) {
      await res.body?.cancel().catch(() => undefined);
      if (retried) throw new Error("MCP server rejected the refreshed credentials (401). Use Tools > MCP > Authenticate.");
      const token = await this.challengeAuth(res.headers.get("www-authenticate") ?? undefined);
      if (!token) throw new Error("MCP server requires authorization and no token is available. Use Tools > MCP > Authenticate.");
      return this.sendHttp(req, true);
    }
    if (!res.ok) {
      throw new Error(`MCP HTTP error ${res.status}: ${await readBodyLimited(res)}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.httpSessionId = sid;
      await this.consumeSseResponse(res.body, req.id);
      return;
    }
    const json = JSON.parse(await readBodyLimited(res)) as JsonRpcResponse;
    this.traffic("in", describeJsonRpc(json));
    if (json.error) throw new Error(json.error.message);
    const p = this.pending.get(req.id);
    if (p) {
      this.pending.delete(req.id);
      p.resolve(json.result);
    }
  }
  private async consumeSseResponse(stream: ReadableStream<Uint8Array> | null, expectedId: number | string): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error("MCP SSE event exceeded 1 MiB.");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseSseBlock(block);
        if (!parsed) continue;
        for (const { data } of parsed) {
          const msg = safeJsonParse(data);
          if (!msg) continue;
          this.traffic("in", describeJsonRpc(msg));
          if ("id" in msg && msg.id !== undefined && msg.id !== null) {
            const id = msg.id as number | string;
            if (id === expectedId) {
              const r = msg as JsonRpcResponse;
              const p = this.pending.get(id);
              if (p) {
                this.pending.delete(id);
                if (r.error) p.reject(new Error(r.error.message));
                else p.resolve(r.result);
              }
            } else {
              this.handleMessage(msg as JsonRpcResponse);
            }
          } else {
            this.handleMessage(msg);
          }
        }
      }
    }
  }
  private sendNotification(method: string, params?: unknown) {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.traffic("out", describeJsonRpc(msg));
    if (this.config.transport.type === "stdio") {
      this.proc?.stdin.write(JSON.stringify(msg) + "\n");
    } else {
      this.postHttp(msg);
    }
  }
  private postHttp(msg: unknown) {
    if (!this.httpReady || !this.httpEndpoint) return;
    const t = this.config.transport;
    if (t.type !== "http" && t.type !== "sse") return;
    const endpoint = this.httpEndpoint;
    this.traffic("out", describeJsonRpc(msg));
    void this.authHeaders().then((headers) => {
      if (this.httpSessionId) headers["mcp-session-id"] = this.httpSessionId;
      return safeFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
        signal: this.httpAbort?.signal,
      }, { allowPrivate: this.httpAllowPrivate, allowHttpLoopback: true, sameOrigin: t.url }).then(async (res) => {
        if (res.status === 401) await this.challengeAuth(res.headers.get("www-authenticate") ?? undefined);
        try { await res.body?.cancel(); } catch {}
      });
    }).catch(() => {});
  }
  private sendResponse(id: number | string, result?: unknown, error?: { code: number; message: string }) {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, ...(error ? { error } : { result }) };
    this.traffic("out", describeJsonRpc(msg));
    if (this.config.transport.type === "stdio") {
      this.proc?.stdin.write(JSON.stringify(msg) + "\n");
    } else {
      this.postHttp(msg);
    }
  }
  private async handleIncomingRequest(req: JsonRpcRequest) {
    if (!this.requestHandler) {
      this.sendResponse(req.id, undefined, { code: -32601, message: `Method not supported: ${req.method}` });
      return;
    }
    try {
      const result = await this.requestHandler(req.method, req.params);
      this.sendResponse(req.id, result);
    } catch (e) {
      this.sendResponse(req.id, undefined, { code: -32000, message: (e as Error).message });
    }
  }
  private handleMessage(msg: JsonRpcMessage) {
    if ("method" in msg && msg.method) {
      if ("id" in msg && msg.id !== undefined && msg.id !== null) {
        void this.handleIncomingRequest(msg as JsonRpcRequest);
      } else {
        const notif = msg as JsonRpcNotification;
        this.emit("notification", { server: this.config.name, method: notif.method, params: notif.params } satisfies McpServerNotification);
      }
      return;
    }
    const r = msg as JsonRpcResponse;
    if (r.id === undefined || r.id === null) return;
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    if (r.error) p.reject(new Error(r.error.message));
    else p.resolve(r.result);
  }
  private async startStdio() {
    const t = this.config.transport;
    if (t.type !== "stdio") return;
    this.proc = spawnBounded(t.command, t.args ?? [], {
      cwd: this.workspaceRoot ?? process.cwd(),
      workspaceRoot: this.workspaceRoot,
      sandboxProfile: this.sandboxProfile,
      env: mcpEnvironment(t.env),
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
    const failAll = (reason: string) => {
      for (const [id, p] of this.pending) { p.reject(new Error(reason)); this.pending.delete(id); }
      this.proc = undefined;
      this.emit("exit", { code: -1, reason });
    };
    let stdoutBuffer = "";
    this.proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      if (stdoutBuffer.length > 1024 * 1024) {
        if (this.proc) terminateProcessTree(this.proc);
        failAll("MCP stdio message exceeded 1 MiB.");
        return;
      }
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          this.traffic("in", describeJsonRpc(msg));
          this.handleMessage(msg);
        } catch {}
      }
    });
    this.proc.stderr.on("data", (d: Buffer) => {
      try {
        const cur = (this.lastStderr ?? "") + d.toString("utf-8");
        this.lastStderr = cur.slice(-4000);
      } catch {}
    });
    this.proc.on("error", (err) => {
      failAll(`MCP process error: ${err.message}`);
      if (this.shouldRun) this.scheduleReconnect();
    });
    this.proc.on("exit", (code) => {
      const detail = this.lastStderr ? `: ${redactSecrets(this.lastStderr.slice(-500))}` : "";
      const reason = code !== 0 ? `MCP process exited with code ${code}${detail}` : "MCP process exited";
      failAll(reason);
      if (this.shouldRun) this.scheduleReconnect();
    });
  }
  private async startHttp(): Promise<void> {
    const t = this.config.transport;
    if (t.type !== "http" && t.type !== "sse") return;
    this.httpAbort = new AbortController();
    const parsedUrl = new URL(t.url);
    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "");
    this.httpAllowPrivate = hostname === "localhost" || (net.isIP(hostname) > 0 && isPrivateAddress(hostname));
    const url = await assertSafeUrl(parsedUrl, { allowPrivate: this.httpAllowPrivate, allowHttpLoopback: true });
    const headers = await this.authHeaders();
    let res: Response;
    try {
      const timeoutId = setTimeout(() => this.httpAbort?.abort(), 10_000);
      try {
        res = await safeFetch(url, { method: "GET", headers, signal: this.httpAbort!.signal }, { allowPrivate: this.httpAllowPrivate, allowHttpLoopback: true, sameOrigin: t.url });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      this.clearReconnect();
      throw new Error(`Failed to open MCP SSE stream: ${(e as Error).message}`);
    }
    if (res.status === 401) {
      res.body?.cancel();
      const token = await this.challengeAuth(res.headers.get("www-authenticate") ?? undefined);
      if (token) return this.startHttp();
      throw new Error("MCP server requires authorization and the OAuth flow failed or was cancelled.");
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.httpSessionId = sid;
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || !ct.includes("text/event-stream")) {
      res.body?.cancel();
      if (t.type === "sse") throw new Error(`MCP SSE endpoint did not return an event stream (HTTP ${res.status}).`);
      this.traffic("in", `http ${res.status} (stateless post mode)`);
      this.httpEndpoint = t.url;
      this.httpReady = true;
      return;
    }
    this.traffic("in", `sse stream open ${t.url}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = async (): Promise<void> => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error("MCP SSE event exceeded 1 MiB.");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseBlock(block);
          if (!parsed) continue;
        for (const { event, data } of parsed) {
          const text = data;
          if (event === "endpoint" && text.trim()) {
            let endpoint: URL;
            try {
              endpoint = new URL(text.trim(), t.url);
            } catch {
              continue;
            }
            if (!/^https?:$/.test(endpoint.protocol)) continue;
            if (t.url && endpoint.origin !== new URL(t.url).origin) continue;
            const safe = await assertSafeUrl(endpoint.toString(), { allowPrivate: this.httpAllowPrivate, allowHttpLoopback: true, sameOrigin: t.url });
            this.httpEndpoint = safe.toString();
            this.httpReady = true;
            this.traffic("in", `endpoint ${this.httpEndpoint}`);
            continue;
          }
          const msg = safeJsonParse(text);
          if (!msg) continue;
          this.traffic("in", describeJsonRpc(msg));
          this.handleMessage(msg);
        }
        }
      }
    };
    const consumeTask = consume().catch((e) => {
      this.httpReady = false;
      this.httpEndpoint = undefined;
      this.emit("exit", { code: -1, reason: (e as Error).message });
      if (this.shouldRun) this.scheduleReconnect();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for MCP endpoint event")), 15_000);
        const check = () => {
          if (this.httpReady) { clearTimeout(timer); resolve(); }
          else if (!this.shouldRun) { clearTimeout(timer); reject(new Error("stopped")); }
          else setTimeout(check, 25);
        };
        check();
      });
    } catch (e) {
      try { this.httpAbort?.abort(); } catch {}
      try { await reader.cancel(); } catch {}
      await consumeTask.catch(() => undefined);
      throw e;
    }
  }
  private scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) return;
    this.setStatus("reconnecting");
    const delay = Math.min(this.opts.reconnectMaxMs, this.opts.reconnectInitialMs * 2 ** Math.min(this.reconnectAttempts, 6));
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (!this.shouldRun) return;
      this.httpAbort?.abort();
      this.httpAbort = undefined;
      if (this.proc) terminateProcessTree(this.proc);
      this.proc = undefined;
      this.httpEndpoint = undefined;
      this.httpReady = false;
      try {
        await this.start();
      } catch {
      }
    }, delay);
  }
  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
  }
  private scheduleHealth() {
    this.clearHealth();
    if (this.opts.healthIntervalMs <= 0) return;
    this.healthTimer = setInterval(() => {
      void this.ping();
    }, this.opts.healthIntervalMs);
    const t = this.healthTimer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }
  private clearHealth() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }
  async ping(): Promise<boolean> {
    if (this.status !== "ready") return false;
    if (this.healthInflight !== undefined) return false;
    const id = ++this.id;
    this.healthInflight = id;
    let pingTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      pingTimer = setTimeout(() => resolve("timeout"), this.opts.healthTimeoutMs);
      if (typeof (pingTimer as unknown as { unref?: () => void }).unref === "function") (pingTimer as unknown as { unref: () => void }).unref();
    });
    try {
      const result = await Promise.race([
        this.send({ id, method: "ping" }),
        timeout,
      ]);
      if (pingTimer) clearTimeout(pingTimer);
      this.healthInflight = undefined;
      if (result === "timeout") {
        this.emit("unhealthy", { reason: "timeout" });
        return false;
      }
      return true;
    } catch {
      if (pingTimer) clearTimeout(pingTimer);
      this.healthInflight = undefined;
      this.emit("unhealthy", { reason: "error" });
      return false;
    }
  }
}
function mcpEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const allowedBase = ["HOME", "USERPROFILE", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT", "PSModulePath", "LOCALAPPDATA", "APPDATA", "LANG"];
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? process.env.Path };
  for (const key of allowedBase) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const blocked = /^(?:PATH|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_|PYTHONPATH|PYTHONHOME|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|JAVA_TOOL_OPTIONS|GIT_SSH_COMMAND|BASH_ENV|ENV|ZDOTDIR|PS1)/i;
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!blocked.test(key)) env[key] = value;
  }
  return env;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
function describeJsonRpc(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "message";
  const m = msg as Record<string, unknown>;
  if (typeof m.method !== "string") {
    if (m.error) return `response ${JSON.stringify(m.id)} error: ${String((m.error as { message?: unknown }).message ?? "")}`;
    if ("result" in m) {
      let size = 0;
      try { size = JSON.stringify(m.result ?? null)?.length ?? 0; } catch {}
      return `response ${JSON.stringify(m.id)} ok (~${size}B)`;
    }
    return `message ${JSON.stringify(m.id ?? "")}`;
  }  let detail = "";
  const params = m.params as Record<string, unknown> | undefined;
  if (params && typeof params === "object") {
    if (typeof params.name === "string") detail = ` ${params.name}`;
    else if (typeof params.uri === "string") detail = ` ${params.uri}`;
    else if (m.method === "tools/call" && typeof params.arguments === "object" && params.arguments !== null) {
      try { detail = ` ${JSON.stringify(params.arguments).slice(0, 80)}`; } catch {}
    }
  }
  return `${m.method}${detail}`;
}
function safeJsonParse(s: string): JsonRpcResponse | JsonRpcNotification | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function parseSseBlock(block: string): { event: string; data: string }[] | null {
  const out: { event: string; data: string }[] = [];
  const lines = block.split("\n");
  let cur = "";
  let evt = "";
  const flush = (): void => {
    if (cur) out.push({ event: evt, data: cur });
    cur = "";
    evt = "";
  };
  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      cur = cur ? cur + "\n" + value : value;
    } else if (field === "event") {
      if (cur) flush();
      evt = value;
    }
  }
  flush();
  return out.length ? out : null;
}