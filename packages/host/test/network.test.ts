import { describe, it, expect } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch, readBodyLimited } from "../src/security/network";
function startPlaintext(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pong");
    });
    server.listen(0, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: async () => { await new Promise<void>((r) => server.close(() => r())); },
      });
    });
  });
}
describe("safeFetch pinned lookup", () => {
  it("fetches a hostname over plaintext loopback (custom lookup array mode)", async () => {
    const srv = await startPlaintext();
    try {
      const res = await safeFetch(`http://localhost:${srv.port}/ping`, { signal: AbortSignal.timeout(10_000) }, { allowPrivate: true, allowHttpLoopback: true });
      expect(res.status).toBe(200);
      expect(await readBodyLimited(res)).toBe("pong");
    } finally {
      await srv.close();
    }
  });
  it("still blocks private destinations by default", async () => {
    await expect(
      safeFetch("http://127.0.0.1:9/", { signal: AbortSignal.timeout(10_000) }),
    ).rejects.toThrow(/private|reserved/i);
  });
});