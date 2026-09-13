import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { McpAggregator } from "../../src/mcp/mcp";
interface FakeMcpServer {
  url: string;
  close: () => Promise<void>;
  push: (data: string) => void;
  responseLog: { id: number | string; result?: unknown; error?: { code: number; message: string } }[];
}
function startFakeMcp(): Promise<FakeMcpServer> {
  const state: FakeMcpServer = { url: "", close: async () => {}, push: () => {}, responseLog: [] };
  return new Promise<FakeMcpServer>((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.headers.accept?.includes("text/event-stream")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const port = (server.address() as AddressInfo).port;
        res.write(`event: endpoint\ndata: http://127.0.0.1:${port}/msg\n\n`);
        state.push = (data: string) => { res.write(`event: message\ndata: ${data}\n\n`); };
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const j = JSON.parse(body);
          if (!j.method) {
            state.responseLog.push({ id: j.id, result: j.result, error: j.error });
            res.writeHead(202).end();
            return;
          }
          let result: unknown = {};
          if (j.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} } };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      state.url = `http://127.0.0.1:${port}/sse`;
      state.close = async () => { await new Promise<void>((r) => server.close(() => r())); };
      resolve(state);
    });
  });
}
describe("MCP roots + sampling (server -> client requests)", () => {  let fake: FakeMcpServer;
  let agg: McpAggregator;
  beforeEach(async () => {
    fake = await startFakeMcp();
    agg = new McpAggregator();
    agg.setPersistence(async () => {});
  });
  afterEach(async () => {
    await agg.dispose();
    await fake.close();
  });
  it("answers roots/list requests from the server with configured roots", async () => {
    agg.setRoots([{ uri: "file:///workspace", name: "workspace" }]);
    await agg.addServer({ name: "fs", enabled: true, transport: { type: "http", url: fake.url } });
    fake.push(JSON.stringify({ jsonrpc: "2.0", id: 501, method: "roots/list" }));
    await new Promise((r) => setTimeout(r, 100));
    const entry = fake.responseLog.find((r) => r.id === 501);
    expect(entry).toBeDefined();
    expect(entry?.result).toEqual({ roots: [{ uri: "file:///workspace", name: "workspace" }] });
  });
  it("routes sampling/createMessage requests through the sampling handler with a permission gate", async () => {
    const seen: { server: string; params: unknown }[] = [];
    agg.setSamplingHandler(async (server, params) => {
      seen.push({ server, params });
      return { role: "assistant", content: { type: "text", text: "hi from handler" }, model: "test-model" };
    });
    await agg.addServer({ name: "fs", enabled: true, transport: { type: "http", url: fake.url } });
    fake.push(JSON.stringify({ jsonrpc: "2.0", id: 502, method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "hello" } }] } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(1);
    expect(seen[0].server).toBe("fs");
    const entry = fake.responseLog.find((r) => r.id === 502);
    expect(entry?.result).toEqual({ role: "assistant", content: { type: "text", text: "hi from handler" }, model: "test-model" });
  });
  it("responds with an error for unsupported methods and when no sampling handler is set", async () => {
    await agg.addServer({ name: "fs", enabled: true, transport: { type: "http", url: fake.url } });
    fake.push(JSON.stringify({ jsonrpc: "2.0", id: 503, method: "sampling/createMessage", params: {} }));
    await new Promise((r) => setTimeout(r, 100));
    const entry = fake.responseLog.find((r) => r.id === 503);
    expect(entry?.error).toBeDefined();
    fake.push(JSON.stringify({ jsonrpc: "2.0", id: 504, method: "logging/setLevel", params: {} }));
    await new Promise((r) => setTimeout(r, 100));
    const entry2 = fake.responseLog.find((r) => r.id === 504);
    expect(entry2?.error?.code).toBe(-32000);
  });
}, 30000);