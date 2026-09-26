import { useEffect, useState } from "react";
import { X } from "./icons";
import type { RpcClient, HostEvent } from "../rpc";
import type { ArcPrefs } from "@arc/host/protocol";
function ExperimentalSection({ client }: { client: RpcClient }) {
  const [enabled, setEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [agreement, setAgreement] = useState("");
  useEffect(() => {
    const off = client.on((e: HostEvent) => {
      if (e.type === "prefs/state") setEnabled(e.prefs.backendDebugOverride === true && typeof e.prefs.backendDebugAgreedAt === "string");
    });
    return off;
  }, [client]);
  useEffect(() => {
    client.send({ type: "prefs/get" });
  }, [client]);
  const flip = (next: boolean) => {
    if (next) {
      setAgreement("");
      setModalOpen(true);
    } else {
      client.send({ type: "prefs/set", prefs: { backendDebugOverride: false } satisfies ArcPrefs });
    }
  };
  const confirm = () => {
    if (agreement !== "I agree") return;
    client.send({ type: "prefs/set", prefs: { backendDebugOverride: true, backendDebugAgreedAt: new Date().toISOString() } satisfies ArcPrefs });
    setModalOpen(false);
    setAgreement("");
  };
  return (
    <section className="arc-section">
      <div className="arc-row-main" style={{ marginBottom: 8 }}>
        <span className="arc-row-label">Experimental</span>
      </div>
      <ul className="arc-rows">
        <li className="arc-row"><div className="arc-row-main">
          <span className="arc-row-label">Enable OpenCode Zen backend debugging override</span>
          <span className="arc-spacer" />
          <button className={`arc-toggle ${enabled ? "is-on" : ""}`} role="switch" aria-checked={enabled} onClick={() => flip(!enabled)}>
            <span className="arc-toggle-knob" />
          </button>
        </div></li>
      </ul>
      {modalOpen && (
        <div className="arc-modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="arc-modal" style={{ width: 480, maxWidth: "calc(100vw - 48px)", height: "auto", maxHeight: "calc(100vh - 96px)" }} onClick={(e) => e.stopPropagation()}>
            <header className="arc-modal-head">
              <h2>Backend debugging override</h2>
              <button className="arc-iconbtn" onClick={() => setModalOpen(false)}><X size={15} /></button>
            </header>
            <div className="arc-modal-body" style={{ padding: "12px 18px 0", textAlign: "left" }}>
              <p className="arc-section-desc" style={{ textAlign: "left" }}>This override is experimental and may break at any time. Responses may be rate-limited or be of lower quality than paid tiers, and behavior can break or degrade without notice.</p>
              <p className="arc-section-desc" style={{ textAlign: "left" }}>You are responsible for complying with the terms of service that apply to your model usage. The terms of service may change at any time; if they do, turn this override off.</p>
              <p className="arc-section-desc" style={{ textAlign: "left" }}>To continue, type <strong>I agree</strong> below.</p>
              <input className="arc-input" style={{ width: "100%", boxSizing: "border-box", marginTop: 8 }} type="text" placeholder="I agree" value={agreement} onChange={(e) => setAgreement(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px" }}>
              <button className="arc-btn-ghost" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="arc-btn" disabled={agreement !== "I agree"} onClick={confirm}>I agree, enable</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
export { ExperimentalSection };