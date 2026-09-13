import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { Agent, type AgentEventSink } from "../../src/agent/agent";
import { ModelRegistry } from "../../src/routing/registry";
import { CheckpointStore } from "../../src/checkpoint/store";
import { McpAggregator } from "../../src/mcp/mcp";
import { buildToolSpecs } from "../../src/agent/tool-specs";
import { tools as builtinTools } from "../../src/agent/tools";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ChatMessage, ToolCall, ToolSpec } from "../../src/protocol/protocol";
import type { AddressInfo } from "node:net";
import { McpClient } from "../../src/mcp/client";
function startFakeMcp(): Promise<{ url: string; close: () => Promise<void>; toolList: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]; callLog: { name: string; args: Record<string, unknown> }[]; }> {
  const toolList = [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
  const callLog: { name: string; args: Record<string, unknown> }[] = [];
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.headers.accept?.includes("text/event-stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const port = (server.address() as AddressInfo).port;
        res.write(`event: endpoint\ndata: http://127.0.0.1:${port}/msg\n\n`);
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const j = JSON.parse(body);
          if (j.method === "initialize") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } }));
            return;
          }
          if (j.method === "notifications/initialized") {
            res.writeHead(202).end();
            return;
          }
          if (j.method === "tools/list") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { tools: toolList } }));
            return;
          }
          if (j.method === "tools/call") {
            callLog.push({ name: j.params.name, args: j.params.arguments ?? {} });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { content: [{ type: "text", text: `echo:${j.params.arguments?.text}` }] } }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: {} }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/sse`,
        close: async () => { await new Promise<void>((r) => server.close(() => r())); },
        toolList,
        callLog,
      });
    });
  });
}
describe("MCP tool spec injection + dispatcher routing", () => {
  it("buildToolSpecs emits mcp__<server>__<tool> specs from the aggregator", async () => {
    const fake = await startFakeMcp();
    const agg = new McpAggregator();
    const client = new McpClient({ name: "fs", enabled: true, transport: { type: "http", url: fake.url } }, { healthIntervalMs: 0 });
    agg.setPersistence(async () => {});
    await agg.addServer({ name: "fs", enabled: true, transport: { type: "http", url: fake.url } });
    const { specs } = buildToolSpecs(new Set(["mcp.call"]), agg.listTools());
    expect(specs.find((s) => s.name === "mcp__fs__echo")).toBeDefined();
    await agg.dispose();
    await fake.close();
  });
  it("builtin tools include mcp.create, mcp.remove, mcp.toggle, mcp.resources/*, mcp.prompts/*", () => {
    for (const name of [
      "mcp.create", "mcp.remove", "mcp.toggle",
      "mcp.resources/list", "mcp.resources/read",
      "mcp.prompts/list", "mcp.prompts/get",
    ]) {
      expect(builtinTools[name]).toBeDefined();
    }
  });
}, 30000);