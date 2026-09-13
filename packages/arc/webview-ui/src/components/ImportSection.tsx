import { useEffect, useState } from "react";
import type { RpcClient, HostEvent } from "../rpc";
import type { ProviderKind } from "@arc/host/protocol";
type ImportAgentSummaryPreview = {
  agent: string;
  via: string;
  chats: number;
  messages: number;
  credentials: { key: string; provider: string; label: string; baseUrl?: string; kind: ProviderKind; keyPreview: string }[];
};
type ImportStatus = { kind: "idle" | "scanning" | "importing" | "done" | "error"; text?: string; pct?: number };
type ImportItem = { id: string; kind: "chats" | "cred"; label: string; meta: string; key?: string };
function ImportSection({ client }: { client: RpcClient }) {
  const [agents, setAgents] = useState<ImportAgentSummaryPreview[] | undefined>(undefined);
  const [selected, setSelected] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [importedKeys, setImportedKeys] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<ImportStatus>({ kind: "idle" });
  useEffect(() => {
    const off = client.on((e: HostEvent) => {
      if (e.type === "import/scanResult") {
        setAgents(e.agents);
        setStatus({ kind: "idle" });
      } else if (e.type === "import/chatProgress") {
        const pct = e.total > 0 ? Math.round((e.done / e.total) * 100) : 0;
        setStatus({ kind: "importing", text: `Importing chats: ${e.done} / ${e.total}`, pct });
      } else if (e.type === "import/chatDone") {
        setStatus(e.error
          ? { kind: "error", text: e.error }
          : { kind: "done", text: `Imported ${e.chats} chat${e.chats === 1 ? "" : "s"} (${e.messages} message${e.messages === 1 ? "" : "s"})`, pct: 100 });
      }
    });
    return off;
  }, [client]);
  useEffect(() => {
    setStatus({ kind: "scanning" });
    client.send({ type: "import/scan" });
  }, [client]);
  const agent = agents?.find((a) => a.agent === selected);
  const items: ImportItem[] = agent
    ? [
        ...(agent.chats > 0 ? [{ id: `${agent.agent}|chats`, kind: "chats" as const, label: "chat history", meta: `(${agent.chats} chat${agent.chats === 1 ? "" : "s"}, ${agent.messages} message${agent.messages === 1 ? "" : "s"})` }] : []),
        ...agent.credentials.map((c) => ({ id: `${agent.agent}|${c.key}`, kind: "cred" as const, label: c.label, meta: `[${c.keyPreview}]`, key: c.key })),
      ]
    : [];
  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setChecked(next);
  };
  const importing = status.kind === "importing";
  const doImport = () => {
    if (!agent) return;
    const wantChats = checked.has(`${agent.agent}|chats`);
    const keys = agent.credentials.filter((c) => checked.has(`${agent.agent}|${c.key}`) && !importedKeys.has(`${agent.agent}|${c.key}`)).map((c) => c.key);
    if (wantChats && keys.length) {
      setStatus({ kind: "importing", text: "Starting import", pct: 0 });
      client.send({ type: "import/credentials", agent: agent.agent, keys });
      client.send({ type: "import/chats", agent: agent.agent });
    } else if (wantChats) {
      setStatus({ kind: "importing", text: "Starting chat import", pct: 0 });
      client.send({ type: "import/chats", agent: agent.agent });
    } else if (keys.length) {
      client.send({ type: "import/credentials", agent: agent.agent, keys });
      setStatus({ kind: "done", text: `Imported ${keys.length} credential${keys.length === 1 ? "" : "s"}` });
      setImportedKeys((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.add(`${agent.agent}|${k}`);
        return next;
      });
    }
  };
  const pending = items.filter((i) => i.kind === "chats" || !importedKeys.has(i.id));
  const allSelected = pending.length > 0 && pending.every((i) => checked.has(i.id));
  const toggleAll = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const i of pending) next.delete(i.id);
      } else {
        for (const i of pending) next.add(i.id);
      }
      return next;
    });
  };
  return (
    <section className="arc-section">
      {status.kind === "scanning" && <p className="arc-section-desc">Scanning for other agentic extensions...</p>}
      {status.kind === "error" && <p className="arc-section-desc" style={{ color: "var(--vscode-errorForeground)" }}>{status.text}</p>}
      {agents?.length === 0 && <p className="arc-section-desc">No other agentic extension data found on this machine.</p>}
      {agents !== undefined && agents.length > 0 && (
        <>
          <div className="arc-row-main" style={{ marginBottom: 8 }}>
            <span className="arc-row-label">Import data from...</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={selected} onChange={(e) => { setSelected(e.target.value); setChecked(new Set()); }} disabled={importing} style={{ maxWidth: 220 }}>
              <option value="">Select an extension</option>
              {agents.map((a) => <option key={a.agent} value={a.agent}>{a.agent}</option>)}
            </select>
          </div>
          {agent && pending.length > 0 && (
            <>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
                <button className="arc-btn" style={{ fontSize: 11, padding: "2px 10px" }} onClick={toggleAll} disabled={importing}>{allSelected ? "Deselect all" : "Select all"}</button>
              </div>
              <ul className="arc-rows">
                {pending.map((i) => (
                  <li key={i.id} className="arc-row">
                    <div className="arc-row-main">
                      <span className="arc-row-label">{i.label}</span>
                      <span className="arc-row-meta">{i.meta}</span>
                      <span className="arc-spacer" />
                      <input type="checkbox" checked={checked.has(i.id)} onChange={() => toggle(i.id)} disabled={importing} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {agent && pending.length === 0 && <p className="arc-section-desc">Nothing left to import from {agent.agent}.</p>}
          {status.kind === "importing" && (
            <div className="arc-progress-wrap">
              <div className="arc-progress-bar"><div className="arc-progress-fill" style={{ width: `${status.pct ?? 0}%` }} /></div>
              <p className="arc-progress-text">{status.text}</p>
            </div>
          )}
          {status.kind === "done" && <p className="arc-section-desc" style={{ color: "var(--vscode-charts-green, var(--vscode-descriptionForeground))" }}>{status.text}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button className="arc-btn" disabled={importing || checked.size === 0 || !agent} onClick={doImport}>Import selected</button>
          </div>
        </>
      )}
    </section>
  );
}
export { ImportSection };