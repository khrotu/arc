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
let fallbackAppId = "Microsoft.VisualStudioCode";
const NOTIFICATION_PATH = "/notification";
export { NOTIFICATION_PATH };
export function notificationUri(extensionId: string, scheme?: string): string {
  const s = (scheme || "vscode").trim().toLowerCase() || "vscode";
  return `${s}://${extensionId}${NOTIFICATION_PATH}`;
}
function openLaunchTarget(uri: string): void {
  const opener = process.platform === "linux" ? "xdg-open" : process.platform === "darwin" ? "open" : undefined;
  if (!opener) return;
  const child = spawn(opener, [uri], { stdio: "ignore", shell: false });
  child.on("error", () => undefined);
  child.unref();
}
function showNative(title: string, body: string, logoPath: string | undefined, launch: string): void {
  const { platform } = process;
  try {
    let child;
    if (platform === "linux") {
      child = spawn("notify-send", [title, body, "--icon=dialog-information", "--urgency=normal", "--action=default=Open", "--wait"], { stdio: ["ignore", "pipe", "ignore"], shell: false });
      child.stdout?.on("data", (buf: Buffer) => {
        if (buf.toString().trim()) openLaunchTarget(launch);
      });
    } else if (platform === "win32") {
      const xml = buildWinToast(title, body, logoPath, fallbackAppId, launch);
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
export function makeVSCodeNotifier(logoPath?: string, extensionId?: string): Notifier {
  try {
    fallbackAppId = resolveHostAppId(vscode.env.appName, vscode.env.uriScheme);
  } catch {
    fallbackAppId = "Microsoft.VisualStudioCode";
  }
  let launchScheme = "vscode";
  try {
    launchScheme = vscode.env.uriScheme || "vscode";
  } catch {
    launchScheme = "vscode";
  }
  const launch = notificationUri(extensionId ?? "khrotu.arc-code", launchScheme);
  return {
    notify(_kind, message) {
      const cfg = vscode.workspace.getConfiguration("arc.notifications");
      if (cfg.get("enabled") === false) return;
      if (vscode.window.state.focused) return;
      if (process.platform === "darwin") {
        void vscode.window.showInformationMessage(message, "Open").then((choice) => {
          if (choice === "Open") void vscode.commands.executeCommand("arc.openSidebar");
        });
        return;
      }
      showNative("Arc", message, logoPath, launch);
    },
  };
}