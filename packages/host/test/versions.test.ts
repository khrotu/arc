import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { parseOpencodeVer, refreshOpencodeVer, VERSIONS_FILE } from "../src/providers/versions";
import { OPENCODE_UA, OPENCODE_VER_DEFAULT, setOpencodeVer } from "../src/providers/attribution";
describe("versions cache", () => {
  it("parses release tag names", () => {
    expect(parseOpencodeVer({ tag_name: "v1.18.31" })).toBe("1.18.31");
    expect(parseOpencodeVer({ tag_name: "1.2.3" })).toBe("1.2.3");
    expect(parseOpencodeVer({ name: "v2.0.0" })).toBe("2.0.0");
    expect(parseOpencodeVer({})).toBeUndefined();
    expect(parseOpencodeVer({ tag_name: "not-a-version" })).toBeUndefined();
  });
  it("fetches releases and caches to versions file", async () => {
    const dir = await import("node:fs").then((fs) => fs.promises.mkdtemp(path.join(os.tmpdir(), "arc-ver-")));
    const cachePath = path.join(dir, VERSIONS_FILE);
    const fetchImpl = (async () => new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 })) as typeof fetch;
    const ver = await refreshOpencodeVer({ fetchImpl, cachePath, ttlMs: 60_000 });
    expect(ver).toBe("9.9.9");
    expect(OPENCODE_UA).toBe("opencode/9.9.9");
    const cached = await refreshOpencodeVer({ fetchImpl: (async () => { throw new Error("no network"); }) as typeof fetch, cachePath, ttlMs: 60_000 });
    expect(cached).toBe("9.9.9");
    setOpencodeVer(OPENCODE_VER_DEFAULT);
  });
});