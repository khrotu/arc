import * as path from "node:path";
import * as vm from "node:vm";
import { resolveAuthorizedPath } from "../security/path-policy.js";
export interface BrowserAdapter {
  navigate(url: string, tabId?: string): Promise<{ ok: boolean; output: string }>;
  click(selector: string, tabId?: string): Promise<{ ok: boolean; output: string }>;
  type(selector: string, text: string, tabId?: string): Promise<{ ok: boolean; output: string }>;
  screenshot(outPath?: string, fullPage?: boolean, type?: "png" | "jpeg", tabId?: string): Promise<{ ok: boolean; output: string }>;
  evaluate(script: string, tabId?: string): Promise<{ ok: boolean; output: string }>;
  readDom(tabId?: string): Promise<{ ok: boolean; output: string }>;
  readPage(tabId?: string): Promise<{ ok: boolean; output: string }>;
  hover(selector: string, tabId?: string): Promise<{ ok: boolean; output: string }>;
  scroll(pixels?: number, selector?: string, tabId?: string): Promise<{ ok: boolean; output: string }>;
  waitFor(selector?: string, urlPattern?: string, state?: "networkidle" | "load" | "domcontentloaded", tabId?: string): Promise<{ ok: boolean; output: string }>;
  drag(fromSelector: string, toSelector: string, tabId?: string): Promise<{ ok: boolean; output: string }>;
  dialog(accept: boolean, promptText?: string, tabId?: string): Promise<{ ok: boolean; output: string }>;
  runCode(code: string, tabId?: string): Promise<{ ok: boolean; output: string }>;
  close(): Promise<void>;
  consoleLog(tabId?: string): string[];
  networkLog(tabId?: string): string[];
  domSnapshot(tabId?: string): string;
  newTab(url?: string): Promise<{ ok: boolean; output: string; tabId?: string }>;
  switchTab(tabId: string): Promise<{ ok: boolean; output: string }>;
  closeTab(tabId: string): Promise<{ ok: boolean; output: string }>;
  listTabs(): Promise<{ ok: boolean; output: string; tabs?: { id: string; url: string; active: boolean }[] }>;
  intercept(pattern: string, mock?: { status?: number; body?: string; contentType?: string; block?: boolean }): Promise<{ ok: boolean; output: string }>;
  unintercept(pattern: string): Promise<{ ok: boolean; output: string }>;
}
export type BrowserKind = "chromium" | "firefox";
interface ConsoleEntry { level: string; text: string; location: string; ts: number }
interface NetworkEntry { url: string; method: string; status: number; timing: number; ts: number }
interface MinimalPlaywright {
  chromium?: { launch: (opts: { headless?: boolean }) => Promise<PlaywrightBrowser> };
  firefox?: { launch: (opts: { headless?: boolean }) => Promise<PlaywrightBrowser> };
}
interface PlaywrightRoute {
  request(): { url(): string };
  abort(): Promise<void>;
  fulfill(opts: { status?: number; contentType?: string; body?: string }): Promise<void>;
  continue(): Promise<void>;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  route(pattern: string, handler: (route: PlaywrightRoute) => unknown): Promise<void>;
  unroute(pattern: string): Promise<void>;
}
interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  click(selector: string, opts: { timeout: number }): Promise<unknown>;
  fill(selector: string, text: string, opts: { timeout: number }): Promise<unknown>;
  hover(selector: string, opts: { timeout: number }): Promise<unknown>;
  dragAndDrop(selector: string, targetSelector: string, opts: { timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, opts: { state: string; timeout: number }): Promise<unknown>;
  waitForURL(url: string | RegExp, opts: { timeout: number }): Promise<unknown>;
  waitForLoadState(state: string): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  screenshot(opts: { path: string; fullPage?: boolean; type?: string }): Promise<unknown>;
  accessibility: { snapshot(): Promise<unknown> };
  content(): Promise<string>;
  on(event: string, fn: (...args: unknown[]) => void): void;
  url(): string;
  close(): Promise<void>;
}
const MAX_LOG_ENTRIES = 50;
function assertSafeNavigationUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to navigate to invalid URL '${url}'.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing to navigate to non-http(s) URL '${parsed.protocol}//...'.`);
  }
}
interface TabState { id: string; page: PlaywrightPage; consoleLog: ConsoleEntry[]; networkLog: NetworkEntry[] }
export async function createBrowser(kind: BrowserKind = "chromium", headless = true, workspaceRoot = process.cwd()): Promise<BrowserAdapter> {
  let pw: MinimalPlaywright;
  try {
    pw = (await import("playwright")) as unknown as MinimalPlaywright;
  } catch {
    return stubAdapter("Playwright is not installed. Run: pnpm add -D playwright");
  }
  const launcher = (kind === "firefox" ? pw.firefox : pw.chromium);
  if (!launcher) return stubAdapter("Requested browser launcher is not present in the installed Playwright bundle.");
  const browser = await launcher.launch({ headless });
  const ctx = await browser.newContext();
  const tabs = new Map<string, TabState>();
  const interceptRules = new Map<string, { status?: number; body?: string; contentType?: string; block?: boolean }>();
  let activeTabId = "";
  let tabSeq = 0;
  let dialogAction: { accept: boolean; promptText?: string } | null = null;
  function attachTab(page: PlaywrightPage): TabState {
    const id = `tab-${++tabSeq}`;
    const tab: TabState = { id, page, consoleLog: [], networkLog: [] };
    page.on("dialog", (d: any) => {
      const action = dialogAction ?? { accept: false };
      dialogAction = null;
      if (action.accept) {
        if (action.promptText !== undefined) d.accept(action.promptText);
        else d.accept();
      } else {
        d.dismiss();
      }
    });
    page.on("console", (msg: any) => {
      if (tab.consoleLog.length >= MAX_LOG_ENTRIES) tab.consoleLog.shift();
      tab.consoleLog.push({
        level: msg.type() ?? "log",
        text: msg.text()?.slice(0, 500) ?? "",
        location: msg.location()?.url ?? "",
        ts: Date.now(),
      });
    });
    page.on("requestfinished", (req: any) => {
      void (async () => {
        if (tab.networkLog.length >= MAX_LOG_ENTRIES) tab.networkLog.shift();
        const timing = req.timing() ?? {};
        const res = await req.response().catch(() => null);
        tab.networkLog.push({
          url: req.url()?.slice(0, 300) ?? "",
          method: req.method() ?? "GET",
          status: res?.status() ?? 0,
          timing: timing.responseEnd ?? timing.startTime ?? 0,
          ts: Date.now(),
        });
      })();
    });
    tabs.set(id, tab);
    return tab;
  }
  const firstPage = await ctx.newPage();
  const firstTab = attachTab(firstPage);
  activeTabId = firstTab.id;
  function resolveTab(tabId?: string): TabState | undefined {
    if (tabId) return tabs.get(tabId);
    return tabs.get(activeTabId);
  }
  function captureSummary(tab: TabState): string {
    const parts: string[] = [];
    if (tab.consoleLog.length) {
      parts.push("--- Console (last " + tab.consoleLog.length + ") ---");
      for (const c of tab.consoleLog) parts.push(`[${c.level}] ${c.text}${c.location ? " (" + c.location + ")" : ""}`);
    }
    if (tab.networkLog.length) {
      parts.push("--- Network (last " + tab.networkLog.length + ") ---");
      for (const n of tab.networkLog) parts.push(`${n.method} ${n.status} ${n.url} ${n.timing}ms`);
    }
    return parts.join("\n");
  }
  const adapter: BrowserAdapter = {
    async navigate(url, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        assertSafeNavigationUrl(url);
        await tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        const cap = captureSummary(tab);
        return { ok: true, output: `Navigated to ${url}${cap ? "\n\n" + cap : ""}` };
      } catch (e) { return { ok: false, output: `Navigation failed: ${(e as Error).message}` }; }
    },
    async click(selector, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        await tab.page.click(selector, { timeout: 5_000 });
        const cap = captureSummary(tab);
        return { ok: true, output: `Clicked ${selector}${cap ? "\n\n" + cap : ""}` };
      } catch (e) { return { ok: false, output: `Click failed: ${(e as Error).message}` }; }
    },
    async type(selector, text, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        await tab.page.fill(selector, text, { timeout: 5_000 });
        const cap = captureSummary(tab);
        return { ok: true, output: `Typed into ${selector}${cap ? "\n\n" + cap : ""}` };
      } catch (e) { return { ok: false, output: `Type failed: ${(e as Error).message}` }; }
    },
    async screenshot(outPath, fullPage, type, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        const p = outPath ? resolveAuthorizedPath(workspaceRoot, outPath) : path.join(workspaceRoot, `arc-shot-${Date.now()}.${type || "png"}`);
        await tab.page.screenshot({ path: p, fullPage: fullPage ?? false, type: type || "png" });
        const cap = captureSummary(tab);
        return { ok: true, output: `Saved ${p}${cap ? "\n\n" + cap : ""}` };
      } catch (e) { return { ok: false, output: `Screenshot failed: ${(e as Error).message}` }; }
    },
    async evaluate(script, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        const result = await tab.page.evaluate(script);
        return { ok: true, output: typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? String(result) };
      } catch (e) { return { ok: false, output: `Eval failed: ${(e as Error).message}` }; }
    },
    async readDom(tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      let snapshotError = "";
      try {
        const snapshot = tab.page.accessibility ? await tab.page.accessibility.snapshot() : undefined;
        if (snapshot) return { ok: true, output: JSON.stringify(snapshot, null, 2) };
        snapshotError = "accessibility snapshot unavailable";
      } catch (e) { snapshotError = (e as Error).message; }
      try {
        const html = await tab.page.evaluate("document.documentElement ? document.documentElement.outerHTML : ''");
        const text = typeof html === "string" ? html : "";
        if (!text) return { ok: false, output: `Accessibility snapshot failed (${snapshotError}) and the page has no document.` };
        const capped = text.length > 20_000 ? `${text.slice(0, 20_000)}\n... (DOM truncated from ${text.length} chars)` : text;
        return { ok: true, output: `(accessibility snapshot unavailable [${snapshotError}]; DOM fallback)\n${capped}` };
      } catch (e) { return { ok: false, output: `Accessibility snapshot failed (${snapshotError}); DOM fallback also failed: ${(e as Error).message}` }; }
    },
    async hover(selector, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        await tab.page.hover(selector, { timeout: 5_000 });
        return { ok: true, output: `Hovered ${selector}` };
      } catch (e) { return { ok: false, output: `Hover failed: ${(e as Error).message}` }; }
    },
    async scroll(pixels, selector, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        if (selector) {
          if (typeof selector !== "string" || !selector || selector.length > 1000) {
            return { ok: false, output: "Scroll failed: selector must be a non-empty string up to 1000 chars" };
          }
          await tab.page.evaluate(`(function(){const el=document.querySelector(${JSON.stringify(selector)});if(el)el.scrollIntoView({behavior:"smooth",block:"center"});})()`);
          return { ok: true, output: `Scrolled to ${selector}` };
        }
        await tab.page.evaluate(`window.scrollBy(0, ${Number.isFinite(pixels) ? pixels : 300})`);
        return { ok: true, output: `Scrolled by ${Number.isFinite(pixels) ? pixels : 300}px` };
      } catch (e) { return { ok: false, output: `Scroll failed: ${(e as Error).message}` }; }
    },
    async waitFor(selector, urlPattern, state, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        if (selector) {
          await tab.page.waitForSelector(selector, { state: "visible", timeout: 10_000 });
          return { ok: true, output: `Selector "${selector}" appeared` };
        }
        if (urlPattern) {
          await tab.page.waitForURL(urlPattern, { timeout: 10_000 });
          return { ok: true, output: `URL matched "${urlPattern}"` };
        }
        await tab.page.waitForLoadState(state ?? "networkidle");
        return { ok: true, output: `Page reached state "${state ?? "networkidle"}"` };
      } catch (e) { return { ok: false, output: `Wait failed: ${(e as Error).message}` }; }
    },
    async drag(fromSelector, toSelector, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        await tab.page.dragAndDrop(fromSelector, toSelector, { timeout: 10_000 });
        return { ok: true, output: `Dragged ${fromSelector} onto ${toSelector}` };
      } catch (e) { return { ok: false, output: `Drag failed: ${(e as Error).message}` }; }
    },
    async dialog(accept, promptText) {
      dialogAction = { accept, promptText };
      return { ok: true, output: accept ? (promptText !== undefined ? `Dialog will be accepted with "${promptText}".` : "Dialog will be accepted.") : "Dialog will be dismissed." };
    },
    async runCode(code, tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        type QueuedOp = { method: string; args: unknown[] };
        const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
        const bootstrap = new vm.Script(`
          "use strict";
          globalThis.__ops = [];
          const __queue = (method, args) => { globalThis.__ops.push({ method, args }); return undefined; };
          const page = Object.freeze({
            goto: (...args) => __queue("goto", args),
            click: (...args) => __queue("click", args),
            fill: (...args) => __queue("fill", args),
            hover: (...args) => __queue("hover", args),
            dragAndDrop: (...args) => __queue("dragAndDrop", args),
            waitForSelector: (...args) => __queue("waitForSelector", args),
            waitForURL: (...args) => __queue("waitForURL", args),
            waitForLoadState: (...args) => __queue("waitForLoadState", args),
            evaluate: (...args) => __queue("evaluate", args),
            screenshot: (...args) => __queue("screenshot", args),
            content: (...args) => __queue("content", args),
            url: (...args) => __queue("url", args)
          });
        `);
        bootstrap.runInContext(context, { timeout: 1000 });
        const synchronousCode = code.replace(/\bawait\s+(?=page\.)/g, "");
        if (/\b(?:await|async|import|require|process|globalThis|constructor|prototype|__proto__|__ops|__queue)\b/.test(synchronousCode)) {
          throw new Error("Only synchronous page.* Playwright operations are allowed in browser.runCode.");
        }
        const script = new vm.Script(`(() => { ${synchronousCode}\n})()`);
        script.runInContext(context, { timeout: 1000 });
        const queued = (context as unknown as { __ops: QueuedOp[] }).__ops;
        const results: unknown[] = [];
        for (const op of queued) {
          switch (op.method) {
            case "goto": {
              const target = String(op.args[0]);
              assertSafeNavigationUrl(target);
              results.push(await tab.page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 }));
              break;
            }
            case "click": results.push(await tab.page.click(String(op.args[0]), { timeout: 5_000 })); break;
            case "fill": results.push(await tab.page.fill(String(op.args[0]), String(op.args[1] ?? ""), { timeout: 5_000 })); break;
            case "hover": results.push(await tab.page.hover(String(op.args[0]), { timeout: 5_000 })); break;
            case "dragAndDrop": results.push(await tab.page.dragAndDrop(String(op.args[0]), String(op.args[1]), { timeout: 10_000 })); break;
            case "waitForSelector": results.push(await tab.page.waitForSelector(String(op.args[0]), { state: "visible", timeout: 10_000 })); break;
            case "waitForURL": results.push(await tab.page.waitForURL(String(op.args[0]), { timeout: 10_000 })); break;
            case "waitForLoadState": results.push(await tab.page.waitForLoadState(String(op.args[0] ?? "networkidle"))); break;
            case "evaluate": {
              throw new Error("page.evaluate is not allowed in browser.runCode. Enable and use the browser.evaluate tool instead.");
            }
            case "screenshot": {
              const options = (op.args[0] && typeof op.args[0] === "object" ? op.args[0] : {}) as { path?: string; fullPage?: boolean; type?: string };
              const out = options.path ? resolveAuthorizedPath(workspaceRoot, options.path) : path.join(workspaceRoot, `arc-shot-${Date.now()}.${options.type === "jpeg" ? "jpeg" : "png"}`);
              results.push(await tab.page.screenshot({ path: out, fullPage: !!options.fullPage, type: options.type === "jpeg" ? "jpeg" : "png" }));
              break;
            }
            case "content": results.push(await tab.page.content()); break;
            case "url": results.push(tab.page.url()); break;
            default: throw new Error(`Unsupported Playwright operation: ${op.method}`);
          }
        }
        return { ok: true, output: JSON.stringify(results, null, 2) ?? "(completed)" };
      } catch (e) { return { ok: false, output: `Playwright code failed: ${(e as Error).message}` }; }
    },
    async readPage(tabId) {
      const tab = resolveTab(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      try {
        const html = await tab.page.content() as string;
        const text = (await tab.page.evaluate("document.body?.innerText ?? ''")) as string;
        return { ok: true, output: (text || html).slice(0, 4000) };
      } catch (e) { return { ok: false, output: `Read page failed: ${(e as Error).message}` }; }
    },
    async close() { await browser.close().catch(() => undefined); },
    consoleLog(tabId) { const tab = resolveTab(tabId); return tab ? tab.consoleLog.map((c) => `[${c.level}] ${c.text}`) : []; },
    networkLog(tabId) { const tab = resolveTab(tabId); return tab ? tab.networkLog.map((n) => `${n.method} ${n.status} ${n.url} ${n.timing}ms`) : []; },
    domSnapshot(tabId) { const tab = resolveTab(tabId); return tab ? captureSummary(tab) : ""; },
    async newTab(url) {
      try {
        if (url) assertSafeNavigationUrl(url);
        const page = await ctx.newPage();
        const tab = attachTab(page);
        activeTabId = tab.id;
        if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        return { ok: true, output: `Opened new tab '${tab.id}'${url ? ` at ${url}` : ""}.`, tabId: tab.id };
      } catch (e) { return { ok: false, output: `Failed to open tab: ${(e as Error).message}` }; }
    },
    async switchTab(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      activeTabId = tabId;
      return { ok: true, output: `Switched to tab '${tabId}'.` };
    },
    async closeTab(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) return { ok: false, output: `Unknown tab '${tabId}'.` };
      await tab.page.close().catch(() => undefined);
      tabs.delete(tabId);
      if (activeTabId === tabId) {
        const next = tabs.keys().next().value as string | undefined;
        if (next) activeTabId = next;
      }
      return { ok: true, output: `Closed tab '${tabId}'.` };
    },
    async listTabs() {
      const list = [...tabs.values()].map((t) => ({ id: t.id, url: t.page.url(), active: t.id === activeTabId }));
      const output = list.length ? list.map((t) => `${t.active ? "*" : " "} ${t.id} ${t.url}`).join("\n") : "(no open tabs)";
      return { ok: true, output, tabs: list };
    },
    async intercept(pattern, mock) {
      try {
        const rule = mock ?? {};
        interceptRules.set(pattern, rule);
        await ctx.route(pattern, async (route: PlaywrightRoute) => {
          const active = interceptRules.get(pattern);
          if (!active) { await route.continue(); return; }
          if (active.block) { await route.abort(); return; }
          await route.fulfill({ status: active.status ?? 200, contentType: active.contentType ?? "application/json", body: active.body ?? "" });
        });
        return { ok: true, output: `Intercepting requests matching '${pattern}'${rule.block ? " (blocking)" : ""}.` };
      } catch (e) { return { ok: false, output: `Intercept failed: ${(e as Error).message}` }; }
    },
    async unintercept(pattern) {
      if (!interceptRules.has(pattern)) return { ok: false, output: `No active interception for '${pattern}'.` };
      try {
        interceptRules.delete(pattern);
        await ctx.unroute(pattern);
        return { ok: true, output: `Stopped intercepting '${pattern}'.` };
      } catch (e) { return { ok: false, output: `Unintercept failed: ${(e as Error).message}` }; }
    },
  };
  return adapter;
}
function stubAdapter(message: string): BrowserAdapter {
  return {
    async navigate() { return { ok: false, output: message }; },
    async click() { return { ok: false, output: message }; },
    async type() { return { ok: false, output: message }; },
    async screenshot() { return { ok: false, output: message }; },
    async evaluate() { return { ok: false, output: message }; },
    async readDom() { return { ok: false, output: message }; },
    async readPage() { return { ok: false, output: message }; },
    async hover() { return { ok: false, output: message }; },
    async scroll() { return { ok: false, output: message }; },
    async waitFor() { return { ok: false, output: message }; },
    async drag() { return { ok: false, output: message }; },
    async dialog() { return { ok: false, output: message }; },
    async runCode() { return { ok: false, output: message }; },
    async close() {},
    consoleLog() { return []; },
    networkLog() { return []; },
    domSnapshot() { return message; },
    async newTab() { return { ok: false, output: message }; },
    async switchTab() { return { ok: false, output: message }; },
    async closeTab() { return { ok: false, output: message }; },
    async listTabs() { return { ok: false, output: message, tabs: [] }; },
    async intercept() { return { ok: false, output: message }; },
    async unintercept() { return { ok: false, output: message }; },
  };
}