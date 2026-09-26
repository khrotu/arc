import { useEffect, useState } from "react";
import type { RpcClient, HostEvent } from "../rpc";
type DeleteTarget = { id: "chats" | "keys" | "checkpoints" | "agentState"; label: string; meta: string };
const TARGETS: DeleteTarget[] = [
  { id: "chats", label: "Chat history", meta: "all saved chats" },
  { id: "keys", label: "Provider keys", meta: "stored API keys and MCP secrets" },
  { id: "checkpoints", label: "Checkpoints", meta: "saved file-restore points" },
  { id: "agentState", label: "Agent state", meta: "persisted agent snapshots" },
];
function DeleteDataSection({ client }: { client: RpcClient }) {
  const [checked, setChecked] = useState<Set<string>>(new Set(TARGETS.map((t) => t.id)));
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "done" | "error"; text?: string }>({ kind: "idle" });
  useEffect(() => {
    const off = client.on((e: HostEvent) => {
      if (e.type === "data/deleteResult") {
        if (e.error) setStatus({ kind: "error", text: e.error });
        else if (!e.deleted.length) setStatus({ kind: "idle" });
        else setStatus({ kind: "done", text: `Deleted: ${e.deleted.join(", ")}` });
        setConfirming(false);
      }
    });
    return off;
  }, [client]);
  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setChecked(next);
    setConfirming(false);
  };
  const toggleAll = () => {
    setChecked((prev) => (prev.size === TARGETS.length ? new Set() : new Set(TARGETS.map((t) => t.id))));
    setConfirming(false);
  };
  const startDelete = () => {
    if (!checked.size) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setStatus({ kind: "working", text: "Deleting selected data..." });
    client.send({
      type: "data/delete",
      targets: {
        chats: checked.has("chats"),
        keys: checked.has("keys"),
        checkpoints: checked.has("checkpoints"),
        agentState: checked.has("agentState"),
      },
    });
  };
  return (
    <section className="arc-section">
      <div className="arc-row-main" style={{ marginBottom: 8 }}>
        <span className="arc-row-label">Delete user data</span>
        <span className="arc-spacer" />
        <button className="arc-btn" style={{ fontSize: 11, padding: "2px 10px" }} onClick={toggleAll}>{checked.size === TARGETS.length ? "Deselect all" : "Select all"}</button>
      </div>
      <ul className="arc-rows">
        {TARGETS.map((t) => (
          <li key={t.id} className="arc-row">
            <div className="arc-row-main">
              <span className="arc-row-label">{t.label}</span>
              <span className="arc-row-meta">{t.meta}</span>
              <span className="arc-spacer" />
              <input type="checkbox" checked={checked.has(t.id)} onChange={() => toggle(t.id)} disabled={status.kind === "working"} />
            </div>
          </li>
        ))}
      </ul>
      {status.kind === "error" && <p className="arc-section-desc" style={{ color: "var(--vscode-errorForeground)" }}>{status.text}</p>}
      {status.kind === "done" && <p className="arc-section-desc" style={{ color: "var(--vscode-charts-green, var(--vscode-descriptionForeground))" }}>{status.text}</p>}
      {status.kind === "working" && <p className="arc-section-desc">{status.text}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button className="arc-btn" style={confirming ? { borderColor: "var(--vscode-errorForeground)", color: "var(--vscode-errorForeground)" } : undefined} disabled={status.kind === "working" || checked.size === 0} onClick={startDelete}>{confirming ? "Confirm delete" : "Delete selected"}</button>
      </div>
    </section>
  );
}
export { DeleteDataSection };