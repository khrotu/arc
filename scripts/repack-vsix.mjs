import { statSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const store = join(ROOT, "node_modules", ".pnpm");
const yauzlDir = readdirSync(store).find((d) => /^yauzl@3\./.test(d));
const yauzl = createRequire(join(store, yauzlDir, "node_modules", "yauzl", "package.json"))("yauzl");
const zopfli = createRequire(import.meta.url)("@gfx/zopfli");
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
};
async function readEntries(path) {
  const zip = await yauzl.openPromise(path, { lazyEntries: true });
  return await new Promise((res, rej) => {
    const entries = [];
    zip.on("entry", (e) => {
      const meta = { name: e.fileName, dosTime: 0, dosDate: 0x21, attrs: 0, madeBy: e.versionMadeBy, crc: e.crc32 };
      if (/\/$/.test(e.fileName)) {
        entries.push({ ...meta, dir: true, data: Buffer.alloc(0) });
        zip.readEntry();
        return;
      }
      zip.openReadStreamPromise(e).then((stream) => {
        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          entries.push({ ...meta, dir: false, data: Buffer.concat(chunks) });
          zip.readEntry();
        });
        stream.on("error", rej);
      }, rej);
    });
    zip.on("end", () => {
      zip.close();
      res(entries);
    });
    zip.on("error", rej);
    zip.readEntry();
  });
}
async function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const flags = /[^\x00-\x7F]/.test(e.name) ? 0x800 : 0;
    let method = 8;
    let data = e.dir ? Buffer.alloc(0) : await zopfli.deflateAsync(e.data, { numiterations: 30 });
    if (!e.dir && data.length >= e.data.length) {
      method = 0;
      data = e.data;
    }
    const crc = crc32(e.data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(e.dosTime, 10);
    lfh.writeUInt16LE(e.dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    parts.push(lfh, name, data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(e.madeBy, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(e.dosTime, 12);
    cdh.writeUInt16LE(e.dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(e.attrs, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}
async function verify(path, src) {
  const out = await readEntries(path);
  if (out.length !== src.length) throw new Error(`entry count mismatch: ${out.length} != ${src.length}`);
  for (let i = 0; i < src.length; i++) {
    if (out[i].name !== src[i].name || out[i].data.length !== src[i].data.length || crc32(out[i].data) !== src[i].crc) {
      throw new Error(`verify failed at ${src[i].name}`);
    }
  }
}
const target = process.argv[2];
if (typeof target !== "string" || !target.endsWith(".vsix") || target.includes("\0") || /[<>:"|?*]/.test(target.split(/[\\/]/).pop() ?? "")) {
  throw new Error("usage: repack-vsix.mjs <package.vsix>");
}
const TEXT_EXTS = new Set([".md", ".json", ".xml", ".txt", ".js", ".cjs", ".mjs", ".css", ".svg", ".html", ".vsixmanifest", ".tokens"]);
const before = statSync(target).size;
const src = (await readEntries(target))
  .map((e) => {
    if (e.dir || !TEXT_EXTS.has(extname(e.name).toLowerCase())) return { ...e, madeBy: 20, attrs: e.dir ? 0x10 << 16 : 0x20 << 16 };
    let text;
    try {
      text = e.data.toString("utf8");
      Buffer.from(text, "utf8");
    } catch {
      return { ...e, madeBy: 20, attrs: e.dir ? 0x10 << 16 : 0x20 << 16 };
    }
    const data = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
    return { ...e, data, crc: crc32(data), madeBy: 20, attrs: e.dir ? 0x10 << 16 : 0x20 << 16 };
  })
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const tmp = target + ".repack";
try {
  writeFileSync(tmp, await buildZip(src));
  await verify(tmp, src);
  renameSync(tmp, target);
} catch (e) {
  const { rmSync: rmTmp } = await import("node:fs");
  try { rmTmp(tmp, { force: true }); } catch {}
  throw e;
}
console.log(`repacked: ${(before / 1024).toFixed(2)} KB -> ${(statSync(target).size / 1024).toFixed(2)} KB (${src.length} entries)`);