import { McpClient, type McpServerConfig, type McpTransport, type McpClientStatus, type McpServerNotification, type McpTrafficEntry, type McpTokenProvider, type McpOAuthTokens } from "./client.js";
export interface McpTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
export interface McpResource {
  server: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}
export interface McpPrompt {
  server: string;
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}
export interface McpServerInfo {
  name: string;
  enabled: boolean;
  tools: McpTool[];
  toolCount: number;
  resources: McpResource[];
  prompts: McpPrompt[];
  transport: McpTransport;
  status: McpClientStatus;
}
interface ServerEntry {
  config: McpServerConfig;
  client?: McpClient;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}
export type McpListener = () => void;
export type McpPersistence = () => void | Promise<void>;
export type McpTrafficListener = (entry: McpTrafficEntry & { server: string }) => void;
export interface McpRoot { uri: string; name?: string }
export type McpSamplingHandler = (serverName: string, params: unknown) => Promise<unknown>;
export interface McpAuthDelegate {
  tokenProvider: McpTokenProvider;
  onAuthRequired: (wwwAuthenticate?: string) => Promise<McpOAuthTokens | undefined>;
  onTokenRefreshed?: (tokens: McpOAuthTokens) => void;
}
export class McpAggregator {
  private servers = new Map<string, ServerEntry>();
  private listeners = new Set<McpListener>();
  private notificationSubs = new Set<(n: McpServerNotification) => void>();
  private persist?: McpPersistence;
  private roots: McpRoot[] = [];
  private samplingHandler?: McpSamplingHandler;
  private removeHandler?: (serverName: string) => void | Promise<void>;
  private trafficListeners = new Set<McpTrafficListener>();
  private authDelegate?: (serverName: string) => McpAuthDelegate | undefined;
  constructor(private clientOptions: import("./client.js").McpClientOptions = {}) {}
  setAuthDelegate(delegate: (serverName: string) => McpAuthDelegate | undefined): void {
    this.authDelegate = delegate;
  }
  onTraffic(fn: McpTrafficListener): () => void {
    this.trafficListeners.add(fn);
    return () => this.trafficListeners.delete(fn);
  }
  async authenticate(server: string): Promise<boolean> {
    const entry = this.resolveServer(server);
    if (!entry || !entry.client) return false;
    const delegate = this.authDelegate?.(entry.config.name);
    if (!delegate) return false;
    const tokens = await delegate.onAuthRequired(entry.client.getLastAuthChallenge());
    if (!tokens) return false;
    delegate.onTokenRefreshed?.(tokens);
    await entry.client.stop();
    entry.client = undefined;
    entry.tools = [];
    entry.resources = [];
    entry.prompts = [];
    if (entry.config.enabled) await this.startServer(entry);
    this.notify();
    return true;
  }
  async setTransportAuthOAuth(server: string): Promise<boolean> {
    const entry = this.resolveServer(server);
    if (!entry) return false;
    const t = entry.config.transport;
    if (t.type !== "http" && t.type !== "sse") return false;
    if (t.auth === "oauth") return true;
    entry.config.transport = { ...t, auth: "oauth" };
    this.notify();
    await this.persistNow();
    return true;
  }
  setRoots(roots: McpRoot[]): void {
    this.roots = roots;
  }
  setSamplingHandler(handler: McpSamplingHandler): void {
    this.samplingHandler = handler;
  }
  setRemoveHandler(handler: (serverName: string) => void | Promise<void>): void {
    this.removeHandler = handler;
  }
  private async handleServerRequest(entry: ServerEntry, method: string, params: unknown): Promise<unknown> {
    if (method === "roots/list") {
      return { roots: this.roots.map((r) => ({ uri: r.uri, ...(r.name ? { name: r.name } : {}) })) };
    }
    if (method === "sampling/createMessage") {
      if (!this.samplingHandler) throw new Error("Sampling is not supported by this client.");
      return this.samplingHandler(entry.config.name, params);
    }
    throw new Error(`Method not supported: ${method}`);
  }
  private resolveServer(name: string): ServerEntry | undefined {
    const direct = this.servers.get(name);
    if (direct) return direct;
    const lower = name.toLowerCase();
    for (const [key, entry] of this.servers) {
      if (key.toLowerCase() === lower) return entry;
    }
    return undefined;
  }
  setPersistence(fn: McpPersistence) {
    this.persist = fn;
  }
  private async persistNow() {
    try {
      await this.persist?.();
    } catch {
    }
  }
  async addServer(config: McpServerConfig) {
    const existing = this.servers.get(config.name);
    if (existing) {
      await existing.client?.stop();
      this.servers.delete(config.name);
    }
    const entry: ServerEntry = { config, tools: [], resources: [], prompts: [] };
    this.servers.set(config.name, entry);
    if (config.enabled) {
      try {
        await this.startServer(entry);
      } catch {
        entry.config.enabled = false;
      }
    }
    this.notify();
    await this.persistNow();
  }
  async removeServer(name: string) {
    const s = this.servers.get(name);
    if (!s) return;
    await s.client?.stop();
    this.servers.delete(name);
    await this.removeHandler?.(name);
    this.notify();
    await this.persistNow();
  }
  async enableServer(name: string, enabled: boolean) {
    const s = this.servers.get(name);
    if (!s) return;
    if (enabled && !s.client) {
      s.config.enabled = true;
      await this.startServer(s);
    } else if (!enabled && s.client) {
      await s.client.stop();
      s.client = undefined;
      s.tools = [];
      s.resources = [];
      s.prompts = [];
      s.config.enabled = false;
    } else {
      s.config.enabled = enabled;
    }
    this.notify();
    await this.persistNow();
  }
  listServers(): McpServerInfo[] {
    return [...this.servers.values()].map((s) => ({
      name: s.config.name,
      enabled: s.config.enabled,
      tools: s.tools,
      toolCount: s.tools.length,
      resources: s.resources,
      prompts: s.prompts,
      transport: s.config.transport,
      status: s.client?.getStatus() ?? "idle",
    }));
  }
  private trafficSinkFor(name: string) {
    return (entry: McpTrafficEntry) => {
      for (const l of this.trafficListeners) {
        try { l({ ...entry, server: name }); } catch {}
      }
    };
  }
  listTools(): McpTool[] {
    const out: McpTool[] = [];
    for (const s of this.servers.values()) {
      if (s.config.enabled) out.push(...s.tools);
    }
    return out;
  }
  listResources(): McpResource[] {
    const out: McpResource[] = [];
    for (const s of this.servers.values()) {
      if (s.config.enabled) out.push(...s.resources);
    }
    return out;
  }
  listPrompts(): McpPrompt[] {
    const out: McpPrompt[] = [];
    for (const s of this.servers.values()) {
      if (s.config.enabled) out.push(...s.prompts);
    }
    return out;
  }
  async call(server: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: unknown }> {
    const s = this.resolveServer(server);
    if (!s) return { ok: false, output: `Unknown MCP server '${server}'` };
    if (!s.config.enabled) return { ok: false, output: `MCP server '${server}' is disabled.` };
    if (!s.client) return { ok: false, output: `MCP server '${server}' is not started.` };
    try {
      const out = await s.client.callTool(tool, args);
      return { ok: true, output: out };
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  }
  async readResource(server: string, uri: string): Promise<{ ok: boolean; output: unknown }> {
    const s = this.resolveServer(server);
    if (!s) return { ok: false, output: `Unknown MCP server '${server}'` };
    if (!s.client) return { ok: false, output: `MCP server '${server}' is not started.` };
    try {
      const out = await s.client.readResource(uri);
      return { ok: true, output: out };
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  }
  async getPrompt(server: string, name: string, args?: Record<string, unknown>): Promise<{ ok: boolean; output: unknown }> {
    const s = this.resolveServer(server);
    if (!s) return { ok: false, output: `Unknown MCP server '${server}'` };
    if (!s.client) return { ok: false, output: `MCP server '${server}' is not started.` };
    try {
      const out = await s.client.getPrompt(name, args);
      return { ok: true, output: out };
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  }
  onChange(fn: McpListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onNotification(fn: (n: McpServerNotification) => void): () => void {
    const wrap = (n: McpServerNotification) => fn(n);
    this.notificationSubs.add(wrap);
    for (const s of this.servers.values()) s.client?.on("notification", wrap);
    return () => {
      this.notificationSubs.delete(wrap);
      for (const s of this.servers.values()) s.client?.off("notification", wrap);
    };
  }
  private notify() {
    for (const l of this.listeners) l();
  }
  private async startServer(entry: ServerEntry) {
    const delegate = this.authDelegate?.(entry.config.name);
    const client = new McpClient(entry.config, {
      ...this.clientOptions,
      trafficSink: this.trafficSinkFor(entry.config.name),
      tokenProvider: delegate?.tokenProvider,
      onAuthRequired: delegate ? async (challenge) => {
        const tokens = await delegate.onAuthRequired(challenge);
        if (!tokens) return undefined;
        delegate.onTokenRefreshed?.(tokens);
        return tokens.accessToken;
      } : undefined,
    });
    client.on("notification", (n) => {
      void this.handleNotification(entry, n);
    });
    for (const sub of this.notificationSubs) client.on("notification", sub);
    client.on("status", () => this.notify());
    client.on("unhealthy", () => this.notify());
    client.on("exit", () => this.notify());
    client.setRequestHandler((method, params) => this.handleServerRequest(entry, method, params));
    await client.start();
    entry.client = client;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const refreshed = await Promise.race([
        this.refreshEntry(entry).catch(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), remaining)),
      ]);
      if (refreshed || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  private async refreshEntry(entry: ServerEntry): Promise<boolean> {
    if (!entry.client) return false;
    let ok = true;
    try {
      entry.tools = (await entry.client.listTools()).map((t) => ({ ...t, server: entry.config.name }));
    } catch {
      entry.tools = [];
      ok = false;
    }
    try {
      entry.resources = (await entry.client.listResources()).map((r) => ({ ...r, server: entry.config.name }));
    } catch {
      entry.resources = [];
      ok = false;
    }
    try {
      entry.prompts = (await entry.client.listPrompts()).map((p) => ({ ...p, server: entry.config.name }));
    } catch {
      entry.prompts = [];
      ok = false;
    }
    return ok;
  }
  private async handleNotification(entry: ServerEntry, n: McpServerNotification): Promise<void> {
    if (n.method === "notifications/tools/list_changed") {
      await this.refreshEntry(entry);
      this.notify();
    } else if (n.method === "notifications/resources/list_changed") {
      await this.refreshEntry(entry);
      this.notify();
    } else if (n.method === "notifications/prompts/list_changed") {
      await this.refreshEntry(entry);
      this.notify();
    }
  }
  async dispose() {
    for (const s of this.servers.values()) await s.client?.stop();
    this.servers.clear();
    this.listeners.clear();
  }
}