import type { ArcPrefs } from "./protocol/protocol.js";
let current: ArcPrefs = {};
export function setRuntimePrefs(prefs: ArcPrefs): void {
  current = { ...(prefs ?? {}) };
}
export function getRuntimePrefs(): ArcPrefs {
  return current;
}
export function debugOverrideActive(): boolean {
  return current.backendDebugOverride === true && typeof current.backendDebugAgreedAt === "string" && current.backendDebugAgreedAt.length > 0;
}