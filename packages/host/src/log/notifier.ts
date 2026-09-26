import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { buildWinToast, resolveHostAppId } from "./win-toast.js";
export interface Notifier {
  notify(kind: "done" | "awaiting" | "handoff" | "error", message: string): void;
}
let _notifier: Notifier | undefined;
export function setNotifier(n: Notifier): void {
  _notifier = n;
}
export function notify(kind: "done" | "awaiting" | "handoff" | "error", message: string): void {
  _notifier?.notify(kind, message);
}
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}
let fallbackAppId = "Microsoft.VisualStudioCode";
function showNative(title: string, body: string, logoPath?: string): void {
  const { platform } = process;
  try {
    let child;
    if (platform === "darwin") {
      child = spawn("osascript", ["-e", `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`], { stdio: "ignore", shell: false });
    } else if (platform === "linux") {
      child = spawn("notify-send", [title, body, "--icon=dialog-information", "--urgency=normal"], { stdio: "ignore", shell: false });
    } else if (platform === "win32") {
      const xml = buildWinToast(title, body, logoPath, fallbackAppId);
      const encoded = Buffer.from(xml, "utf-16le").toString("base64");
      child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], { stdio: "ignore", shell: false });
    } else {
      return;
    }
    child.on("error", () => undefined);
    if (typeof child.unref === "function") child.unref();
  } catch {
  }
}
export function makeVSCodeNotifier(logoPath?: string): Notifier {
  try {
    fallbackAppId = resolveHostAppId(vscode.env.appName, vscode.env.uriScheme);
  } catch {
    fallbackAppId = "Microsoft.VisualStudioCode";
  }
  return {
    notify(_kind, message) {
      const cfg = vscode.workspace.getConfiguration("arc.notifications");
      if (cfg.get("enabled") === false) return;
      if (vscode.window.state.focused) return;
      showNative("Arc", message, logoPath);
    },
  };
}