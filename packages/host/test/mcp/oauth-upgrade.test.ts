import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { McpClient } from "../../src/mcp/client";
import { McpAggregator } from "../../src/mcp/mcp";
interface Fake {
  url: string;
  close: () => Promise<void>;
  seenAuth: (string | undefined)[];
  challenge?: string;
}
function startFakeOAuthMcp(challenge?: string): Promise<Fake> {
  const seenAuth: (string | undefined)[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seenAuth.push(req.headers.authorization);
        if (req.headers.authorization !== "Bearer tok123") {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (challenge) headers["www-authenticate"] = challenge;
          res.writeHead(401, headers);
          res.end(JSON.stringify({ message: "Unauthorized" }));
          return;
        }
        const j = JSON.parse(body);
        if (j.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (j.method === "initialize") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }));
        } else if (j.method === "tools/list") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { tools: [] } }));
        } else {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: {} }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: async () => { await new Promise<void>((r) => server.close(() => r())); },
        seenAuth,
        challenge,
      });
    });
  });
}
const CHALLENGE = 'Bearer error="invalid_token", error_description="No access token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
describe("MCP opportunistic OAuth upgrade", () => {
  it("plain http transport runs the OAuth flow on a Bearer 401 and retries with the token", async () => {
    const fake = await startFakeOAuthMcp(CHALLENGE);
    closers.push(fake.close);
    let stored: string | undefined;
    let seenChallenge: string | undefined;
    const client = new McpClient(
      { name: "supa", enabled: true, transport: { type: "http", url: fake.url } },
      {
        healthIntervalMs: 0,
        tokenProvider: async () => stored,
        onAuthRequired: async (c) => {
          seenChallenge = c;
          stored = "tok123";
          return "tok123";
        },
      },
    );
    try {
      await client.start();
      expect(seenChallenge).toBe(CHALLENGE);
      expect(client.getLastAuthChallenge()).toBe(CHALLENGE);
      expect(fake.seenAuth).toContain("Bearer tok123");
      const tools = await client.listTools();
      expect(tools).toEqual([]);
    } finally {
      await client.stop();
    }
  }, 30000);
  it("does not invoke OAuth for a 401 without a Bearer challenge", async () => {
    const fake = await startFakeOAuthMcp(undefined);
    closers.push(fake.close);
    let calls = 0;
    const client = new McpClient(
      { name: "plain", enabled: true, transport: { type: "http", url: fake.url } },
      {
        healthIntervalMs: 0,
        onAuthRequired: async () => {
          calls++;
          return "tok123";
        },
      },
    );
    try {
      await expect(client.start()).rejects.toThrow(/authorization/i);
      expect(calls).toBe(0);
      expect(client.getLastAuthChallenge()).toBeUndefined();
    } finally {
      await client.stop();
    }
  }, 30000);
  it("setTransportAuthOAuth upgrades a plain http server and persists", async () => {
    const agg = new McpAggregator();
    try {
      let persisted = 0;
      agg.setPersistence(async () => { persisted++; });
      await agg.addServer({ name: "x", enabled: false, transport: { type: "http", url: "https://example.com/mcp" } });
      expect(await agg.setTransportAuthOAuth("x")).toBe(true);
      const info = agg.listServers().find((s) => s.name === "x");
      expect(info?.transport).toMatchObject({ type: "http", auth: "oauth" });
      expect(persisted).toBeGreaterThan(0);
      expect(await agg.setTransportAuthOAuth("missing")).toBe(false);
    } finally {
      await agg.dispose();
    }
  });
});