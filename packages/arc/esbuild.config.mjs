import esbuild from "esbuild";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));
const ARC_VERSION = typeof pkgJson.version === "string" && pkgJson.version ? pkgJson.version : "0.0.0-dev";
const watch = process.argv.includes("--watch");
const isProd = !watch && process.env.NODE_ENV !== "development";
const wantMetafile = !!process.env.ARC_METAFILE;
const hostSrc = resolve(__dirname, "../host/src");
await mkdir(resolve(__dirname, "dist"), { recursive: true });
const host = {
  entryPoints: [resolve(__dirname, "src/extension/host-entry.ts")],
  bundle: true,
  metafile: wantMetafile,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: resolve(__dirname, "dist/extension.js"),
  external: ["vscode", "playwright", "playwright-core", "playwright-firefox", "undici", "@img/*", "canvas"],
  define: { "process.env.ARC_VERSION": JSON.stringify(ARC_VERSION), "process.env.NODE_ENV": JSON.stringify(isProd ? "production" : "development") },
  charset: "utf8",
  sourcemap: !isProd,
  minify: isProd,
  minifyIdentifiers: isProd,
  minifySyntax: isProd,
  minifyWhitespace: isProd,
  treeShaking: true,
  legalComments: isProd ? "none" : "inline",
  logLevel: "info",
  ...(isProd ? { drop: ["console", "debugger"] } : {}),
  plugins: [
    {
      name: "keep-native-requires-external",
      setup(b) {
        b.onResolve({ filter: /^playwright/ }, (args) => ({ path: args.path, external: true }));
        b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
        b.onResolve({ filter: /^undici$/ }, (args) => ({ path: args.path, external: true }));
      },
    },
    {
      name: "host-ts-source",
      setup(b) {
        b.onResolve({ filter: /^@arc\/host$/ }, () => ({ path: resolve(hostSrc, "index.ts") }));
        b.onResolve({ filter: /^@arc\/host\/(.*)$/ }, (args) => {
          const sub = args.path.replace(/^@arc\/host\//, "");
          if (sub === "catalog") return { path: resolve(hostSrc, "providers/catalog.ts") };
          if (sub === "protocol") return { path: resolve(hostSrc, "protocol/index.ts") };
          if (sub === "util") return { path: resolve(hostSrc, "util/index.ts") };
          return { path: resolve(hostSrc, `${sub}.ts`) };
        });
      },
    },
  ],
};
const webview = {
  entryPoints: [resolve(__dirname, "webview-ui/src/entry.tsx")],
  bundle: true,
  metafile: wantMetafile,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: resolve(__dirname, "dist/webview.js"),
  jsx: "automatic",
  charset: "utf8",
  loader: { ".svg": "text", ".png": "dataurl" },
  alias: {
    "react": "preact/compat",
    "react-dom": "preact/compat",
    "react-dom/client": resolve(__dirname, "webview-ui/src/react-dom-client.ts"),
    "react/jsx-runtime": "preact/jsx-runtime",
  },
  define: { "process.env.NODE_ENV": JSON.stringify(isProd ? "production" : "development") },
  sourcemap: !isProd,
  minify: isProd,
  minifyIdentifiers: isProd,
  minifySyntax: isProd,
  minifyWhitespace: isProd,
  treeShaking: true,
  legalComments: isProd ? "none" : "inline",
  logLevel: "info",
  ...(isProd ? { drop: ["console", "debugger"] } : {}),
  plugins: [
    {
      name: "css",
      setup(b) {
        b.onEnd(async (r) => {
          if (r.errors.length) return;
          const cssSrc = resolve(__dirname, "webview-ui/src/styles.css");
          if (existsSync(cssSrc)) {
            const raw = await readFile(cssSrc, "utf-8");
            if (isProd) {
              const minified = await esbuild.transform(raw, { loader: "css", minify: true });
              await cssWrite(minified.code);
            } else {
              await cssWrite(raw);
            }
          }
        });
      },
    },
  ],
};
const atomic = !watch;
const hostOutfile = resolve(__dirname, "dist/extension.js");
const webviewOutfile = resolve(__dirname, "dist/webview.js");
const cssOutfile = resolve(__dirname, "dist/styles.css");
if (atomic) {
  host.outfile = `${hostOutfile}.tmp`;
  webview.outfile = `${webviewOutfile}.tmp`;
}
const cssWrite = async (code) => writeFile(atomic ? `${cssOutfile}.tmp` : cssOutfile, code);
const ctx1 = await esbuild.context(host);
const ctx2 = await esbuild.context(webview);
if (watch) {
  await ctx1.watch();
  await ctx2.watch();
  const fs = await import("node:fs");
  fs.watch(resolve(__dirname, "webview-ui/src/styles.css"), async () => {
    const cssSrc = resolve(__dirname, "webview-ui/src/styles.css");
    if (existsSync(cssSrc)) {
      const raw = await readFile(cssSrc, "utf-8");
      if (isProd) {
        const minified = await esbuild.transform(raw, { loader: "css", minify: true });
        await cssWrite(minified.code);
      } else {
        await cssWrite(raw);
      }
    }
  });
  console.log("[arc] watching...");
} else {
  const r1 = await ctx1.rebuild();
  const r2 = await ctx2.rebuild();
  try {
    const cssSrc = resolve(__dirname, "webview-ui/src/styles.css");
    if (existsSync(cssSrc)) {
      const raw = await readFile(cssSrc, "utf-8");
      const code = isProd ? (await esbuild.transform(raw, { loader: "css", minify: true })).code : raw;
      await cssWrite(code);
    }
  } catch (e) {
    process.stderr.write(`[arc] css write failed: ${e.message}\n`);
    throw e;
  }
  if (wantMetafile) {
    await writeFile(resolve(__dirname, "dist/meta.json"), JSON.stringify(r1.metafile));
    await writeFile(resolve(__dirname, "dist/meta-webview.json"), JSON.stringify(r2.metafile));
  }
  if (isProd && !process.env.ARC_NO_TERSER) {
    try {
      const { minify } = await import("terser");
      for (const name of ["extension.js.tmp", "webview.js.tmp"]) {
        const out = resolve(__dirname, "dist", name);
        const res = await minify(await readFile(out, "utf-8"), {
          compress: { passes: 3, ecma: 2022 },
          mangle: { toplevel: true, reserved: ["activate", "deactivate"] },
          format: { ecma: 2022 },
        });
        if (res.code) await writeFile(out, res.code);
      }
      console.log("[arc] terser post-pass done");
    } catch (e) {
      process.stderr.write(`[arc] terser post-pass skipped: ${e.message}\n`);
    }
  }
  await rename(`${hostOutfile}.tmp`, hostOutfile);
  await rename(`${webviewOutfile}.tmp`, webviewOutfile);
  try {
    await rename(`${cssOutfile}.tmp`, cssOutfile);
  } catch (e) {
    throw new Error(`missing dist/styles.css after build: ${e.message}`);
  }
  await ctx1.dispose();
  await ctx2.dispose();
}