import type { HostMsg, WebviewMsg } from "@arc/host/protocol";
export type HostEvent = HostMsg;
type WebviewRequest = WebviewMsg;
export type Listener = (e: HostEvent) => void;
export interface RpcClient {
  send(msg: WebviewRequest): void;
  on(listener: Listener): () => void;
  request<T = unknown>(key: string): Promise<T | undefined>;
}
declare function acquireVsCodeApi(): {
  postMessage: (m: unknown) => void;
  getState: () => unknown;
  setState: (s: unknown) => void;
};
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
export function createClient(): RpcClient {
  const listeners = new Set<Listener>();
  const pending = new Map<string, (v: unknown) => void>();
  window.addEventListener("message", (ev: MessageEvent) => {
    if (!ev.data || typeof ev.data !== "object") return;
    const msg = ev.data as HostEvent;
    if (typeof (msg as { type?: unknown }).type !== "string") return;
    if (msg && (msg as { type?: string }).type === "config/get" && (msg as { inReplyTo?: string }).inReplyTo) {
      const cb = pending.get((msg as { inReplyTo: string }).inReplyTo);
      if (cb) {
        cb((msg as { value: unknown }).value);
        pending.delete((msg as { inReplyTo: string }).inReplyTo);
        return;
      }
    }
    for (const l of listeners) l(msg);
  });
  const client: RpcClient = {
    send(msg) {
      if (vscode) vscode.postMessage(msg);
      else console.debug("[arc] send", msg);
    },
    on(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    request<T>(key: string): Promise<T | undefined> {
      const id = `req-${Math.random().toString(36).slice(2, 10)}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve(undefined);
        }, 10_000);
        pending.set(id, (v) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(v as T);
        });
        if (vscode) vscode.postMessage({ type: "config/get", key, id });
        else { clearTimeout(timer); pending.delete(id); resolve(undefined); }
      });
    },
  };
  (window as unknown as { __ARC_ATTACH?: () => void }).__ARC_ATTACH = () => {
    vscode?.postMessage({ type: "ui/attachSelection" });
  };
  (window as unknown as { __ARC_ATTACH_FILE?: () => void }).__ARC_ATTACH_FILE = () => {
    vscode?.postMessage({ type: "ui/attachFile" });
  };
  (window as unknown as { __ARC_ATTACH_PROBLEMS?: () => void }).__ARC_ATTACH_PROBLEMS = () => {
    vscode?.postMessage({ type: "ui/attachProblems" });
  };
  (window as unknown as { __ARC_ATTACH_ALL_PROBLEMS?: () => void }).__ARC_ATTACH_ALL_PROBLEMS = () => {
    vscode?.postMessage({ type: "ui/attachAllProblems" });
  };
  (window as unknown as { __ARC_ATTACH_FILE_PROBLEMS?: () => void }).__ARC_ATTACH_FILE_PROBLEMS = () => {
    vscode?.postMessage({ type: "ui/attachFileProblems" });
  };
  (window as unknown as { __ARC_ATTACH_CURRENT_FILE?: () => void }).__ARC_ATTACH_CURRENT_FILE = () => {
    vscode?.postMessage({ type: "ui/attachCurrentFile" });
  };
  (window as unknown as { __ARC_ATTACH_GIT_DIFF?: () => void }).__ARC_ATTACH_GIT_DIFF = () => {
    vscode?.postMessage({ type: "ui/attachGitDiff" });
  };
  (window as unknown as { __ARC_ATTACH_GIT_STAGED?: () => void }).__ARC_ATTACH_GIT_STAGED = () => {
    vscode?.postMessage({ type: "ui/attachGitStaged" });
  };
  (window as unknown as { __ARC_ATTACH_CHANGED_FILES?: () => void }).__ARC_ATTACH_CHANGED_FILES = () => {
    vscode?.postMessage({ type: "ui/attachChangedFiles" });
  };
  (window as unknown as { __ARC_ATTACH_PR?: () => void }).__ARC_ATTACH_PR = () => {
    vscode?.postMessage({ type: "ui/attachPullRequest" });
  };
  return client;
}