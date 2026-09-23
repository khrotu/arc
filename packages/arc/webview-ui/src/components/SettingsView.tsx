import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Plug, X, Check, Info, Play, RefreshCw, CircleDot, AlertTriangle, Pencil, ChevronDown, ChevronRight } from "./icons";
import { Expand, RotateArrow } from "./anim";
import { ImportSection } from "./ImportSection";
import type { RpcClient, HostEvent } from "../rpc";
import type { ModelCatalogEntry, ModelDescriptor, ModelTier, ProviderKind, ProviderSummary } from "@arc/host/protocol";
import { UI_FONT_OPTIONS, MONO_FONT_OPTIONS, applyFonts } from "../fonts";
type ProviderSpec = { kind: ProviderKind; label: string; tags: string[]; defaultBaseUrl?: string };
type ToolSpec = { name: string; category: string; description: string };
type Props = {
  client: RpcClient;
  onClose: () => void;
  models: ModelDescriptor[];
  providers: ProviderSummary[];
  monoLogoText: string;
  version: string;
  providerCatalog: ProviderSpec[];
  toolCatalog: ToolSpec[];
  onUseChat?: (text: string) => void;
  serverStates: Record<string, { running: boolean; pid?: number; error?: string; starting?: boolean }>;
  setServerStates: React.Dispatch<React.SetStateAction<Record<string, { running: boolean; pid?: number; error?: string; starting?: boolean }>>>;
};
const TIERS: ModelTier[] = ["heavy", "default", "light", "free"];
const TIER_ORDER: Record<ModelTier, number> = { heavy: 0, default: 1, light: 2, free: 3 };
const stopKbd = (e: { stopPropagation(): void }) => e.stopPropagation();
const SET = "config/set";
const MD = "model default";
const T_CACHE_R = "Cache-read (hit) price per 1M tokens; falls back to the input price when empty";
const T_CACHE_W = "Cache-write (miss) price per 1M tokens; falls back to the input price when empty";
const BTN_SM = { padding: "3px 10px", fontSize: 11 } as const;
const DD_BG = "var(--vscode-dropdown-background, var(--vscode-input-background, #2d2d2d))";
type Tab = "models" | "providers" | "agent" | "tools" | "workspace" | "about";
const TABS: { value: Tab; label: string }[] = [
  { value: "models", label: "Models" },
  { value: "providers", label: "Providers" },
  { value: "agent", label: "Agent" },
  { value: "tools", label: "Tools" },
  { value: "workspace", label: "Workspace" },
  { value: "about", label: "About" },
];
export default function SettingsModal({ client, onClose, models, providers, monoLogoText, version, providerCatalog, toolCatalog, onUseChat, serverStates, setServerStates }: Props) {
  const [tab, setTab] = useState<Tab>("models");
  const logoTextUri = monoLogoText;
  return (
    <div className="arc-modal-overlay" onClick={onClose}>
      <div className="arc-modal" onClick={(e) => e.stopPropagation()}>
        <header className="arc-modal-head">
          <nav className="arc-settings-tabs">
            {TABS.map((t) => (
              <button key={t.value} className={`arc-tab ${tab === t.value ? "is-active" : ""}`} onClick={() => setTab(t.value)}>
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <button className="arc-iconbtn" onClick={onClose} title="Close"><X size={16} /></button>
        </header>
        <main className="arc-modal-body">
          <div className="arc-settings-inner" key={tab}>
            {tab === "models" && <ModelsTab client={client} providers={providers} models={models} providerCatalog={providerCatalog} onSwitchTab={setTab} />}
            {tab === "providers" && <ProvidersTab client={client} providers={providers} models={models} providerCatalog={providerCatalog} serverStates={serverStates} setServerStates={setServerStates} />}
            {tab === "agent" && <AgentTab client={client} models={models} />}
            {tab === "tools" && <ToolsTab client={client} toolCatalog={toolCatalog} onUseChat={onUseChat} />}
            {tab === "workspace" && <WorkspaceTab client={client} models={models} />}
            {tab === "about" && <AboutSection logoTextUri={logoTextUri} version={version} client={client} />}
          </div>
        </main>
      </div>
    </div>
  );
}
function Section({ title, description, action, titleExtra, children, collapsible, nested }: { title: string; description?: string; action?: React.ReactNode; titleExtra?: React.ReactNode; children: React.ReactNode; collapsible?: boolean; nested?: boolean }) {
  const [open, setOpen] = useState(true);
  if (!collapsible) {
    return (
      <section className="arc-section">
        <div className="arc-section-head">
          <div>
            <h2>{title}{titleExtra}</h2>
            {description && <p className="arc-section-desc">{description}</p>}
          </div>
          {action}
        </div>
        {children}
      </section>
    );
  }
  return (
    <section className={`arc-section${nested ? " arc-section-nested" : ""}`}>
      <div className="arc-section-head">
        <button className="arc-cat-toggle" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? "Collapse" : "Expand"}><RotateArrow open={open} size={12} /></button>
        <div>
          <h2>{title}{titleExtra}</h2>
          {description && <p className="arc-section-desc">{description}</p>}
        </div>
        {action}
      </div>
      <Expand open={open} style={{ paddingLeft: 32 }}>{children}</Expand>
    </section>
  );
}
function TierDot({ tier }: { tier: ModelTier }) {
  return <span className={`arc-tier-dot arc-tier-${tier}`} />;
}
function ModelMultimodalCheckbox({ modelId, client }: { modelId: string; client: RpcClient }) {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    void client.request("arc.model.multimodalIds").then((v) => {
      const ids = Array.isArray(v) ? v as string[] : [];
      setChecked(ids.includes(modelId));
    });
  }, [client, modelId]);
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => {
        const v = e.currentTarget.checked;
        setChecked(v);
        client.send({ type: SET, key: "arc.model.multimodal.toggle", value: { modelId, enabled: v } });
      }}
    />
  );
}
function ModelsTab({ client, providers, models, providerCatalog, onSwitchTab }: { client: RpcClient; providers: ProviderSummary[]; models: ModelDescriptor[]; providerCatalog: ProviderSpec[]; onSwitchTab: (t: Tab) => void }) {
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(null);
  const [catalogReloading, setCatalogReloading] = useState(false);
  const [catalogReloadError, setCatalogReloadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<ModelTier>("default");
  const [ctx, setCtx] = useState<number | "">("");
  const [maxOut, setMaxOut] = useState<number | "">("");
  const [costIn, setCostIn] = useState<number | undefined>(undefined);
  const [costOut, setCostOut] = useState<number | undefined>(undefined);
  const [costCacheRead, setCostCacheRead] = useState<number | undefined>(undefined);
  const [costCacheWrite, setCostCacheWrite] = useState<number | undefined>(undefined);
  const [multimodal, setMultimodal] = useState(false);
  const [bindIds, setBindIds] = useState<string[]>([]);
  const [slugs, setSlugs] = useState<Record<string, string>>({});
  const [ovrs, setOvrs] = useState<Record<string, { costIn: string; costOut: string; cacheRead: string; cacheWrite: string; ctx: string; maxOut: string; image?: boolean }>>({});
  const [ovrOpen, setOvrOpen] = useState<Set<string>>(new Set());
  const [provAdding, setProvAdding] = useState(false);
  const [provSearch, setProvSearch] = useState("");
  const [provKind, setProvKind] = useState<ProviderKind>("openai");
  const [provLabel, setProvLabel] = useState("");
  const [provBaseUrl, setProvBaseUrl] = useState("");
  const [provKey, setProvKey] = useState("");
  useEffect(() => {
    if (!adding || catalog !== null) return;
    client.send({ type: "model/catalog", query: "" });
  }, [adding, catalog, client]);
  useEffect(() => {
    const off = client.on((e: HostEvent) => {
      if (e.type === "model/catalogResult") {
        setCatalog(e.entries);
        setCatalogReloading(false);
        setCatalogReloadError(e.reloadError ?? null);
      }
    });
    return off;
  }, [client]);
  const reloadCatalog = () => {
    setCatalogReloading(true);
    setCatalogReloadError(null);
    client.send({ type: "model/catalog", query: "", reload: true });
  };
  const openAdd = () => {
    setSelectedKey(null); setLabel(""); setTier("default"); setCtx(""); setMaxOut(""); setCostIn(undefined); setCostOut(undefined); setCostCacheRead(undefined); setCostCacheWrite(undefined);
    setMultimodal(false); setBindIds([]); setSlugs({}); setOvrs({}); setOvrOpen(new Set());
    setQuery(""); setProvAdding(false); setAdding(true);
  };
  const toggleOvr = (key: string) => {
    setOvrOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const dedupeCatalogProviders = (list: { providerId: string; slug: string }[]) => {
    const seen = new Set<string>();
    const out: { providerId: string; slug: string }[] = [];
    for (const p of list) {
      const prov = providers.find((x) => x.id === p.providerId);
      const base = ((prov?.baseUrl || "") as string).trim().replace(/\/$/, "").toLowerCase();
      const ident = prov && base ? `${prov.kind}|${base}` : undefined;
      const key = ident ?? `id:${p.providerId}|${p.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  };
  const selectEntry = (e: ModelCatalogEntry) => {
    setSelectedKey(e.key);
    const uniqProviders = dedupeCatalogProviders(e.providers);
    const existingModel = e.existingModelId ? models.find((m) => m.id === e.existingModelId) : undefined;
    if (existingModel) {
      setLabel(existingModel.label);
      setTier(existingModel.tier);
      setCtx(existingModel.contextWindow || e.contextLength || "");
      setMaxOut(existingModel.maxOutputTokens || e.maxOutputTokens || "");
      setCostIn(existingModel.costPer1mIn || e.priceIn);
      setCostOut(existingModel.costPer1mOut || e.priceOut);
      setCostCacheRead(existingModel.costPer1mCacheRead || e.priceCacheRead);
      setCostCacheWrite(existingModel.costPer1mCacheWrite || e.priceCacheWrite);
      void client.request("arc.model.multimodalIds").then((v) => {
        const ids = Array.isArray(v) ? v as string[] : [];
        setMultimodal(ids.includes(existingModel.id));
      });
      const nextSlugs: Record<string, string> = {};
      const nextOvrs: Record<string, { costIn: string; costOut: string; cacheRead: string; cacheWrite: string; ctx: string; maxOut: string; image?: boolean }> = {};
      const opened = new Set<string>([`base:${existingModel.id}`]);
      for (const ref of existingModel.providers) {
        nextSlugs[ref.id] = ref.remoteModel ?? "";
        nextOvrs[ref.id] = {
          costIn: ref.costPer1mIn != null ? String(ref.costPer1mIn) : "",
          costOut: ref.costPer1mOut != null ? String(ref.costPer1mOut) : "",
          cacheRead: ref.costPer1mCacheRead != null ? String(ref.costPer1mCacheRead) : "",
          cacheWrite: ref.costPer1mCacheWrite != null ? String(ref.costPer1mCacheWrite) : "",
          ctx: ref.contextWindow != null ? String(ref.contextWindow) : "",
          maxOut: ref.maxOutputTokens != null ? String(ref.maxOutputTokens) : "",
          image: ref.imageInput ?? undefined,
        };
        if (ref.costPer1mIn != null || ref.costPer1mOut != null || ref.costPer1mCacheRead != null || ref.costPer1mCacheWrite != null || ref.contextWindow != null || ref.maxOutputTokens != null || ref.imageInput != null) opened.add(`add:${ref.id}`);
      }
      for (const p of uniqProviders) {
        if (!(p.providerId in nextSlugs)) nextSlugs[p.providerId] = p.slug;
      }
      setSlugs(nextSlugs);
      setOvrs(nextOvrs);
      const order = existingModel.providers.map((r) => r.id);
      for (const p of uniqProviders) if (!order.includes(p.providerId)) order.push(p.providerId);
      setBindIds(order);
      setOvrOpen(opened);
      setQuery("");
      return;
    }
    setLabel(e.label);
    setCtx(e.contextLength ?? "");
    setMaxOut(e.maxOutputTokens ?? "");
    setCostIn(e.priceIn);
    setCostOut(e.priceOut);
    setCostCacheRead(e.priceCacheRead);
    setCostCacheWrite(e.priceCacheWrite);
    setMultimodal(e.imageInput ?? false);
    const next: Record<string, string> = {};
    for (const p of uniqProviders) next[p.providerId] = p.slug;
    setSlugs(next);
    setBindIds(uniqProviders.map((p) => p.providerId));
    setQuery("");
  };
  const filtered = useMemo(() => searchCatalog(catalog ?? [], query), [catalog, query]);
  const selected = catalog?.find((e) => e.key === selectedKey) ?? null;
  const enabledProviders = providers.filter((p) => p.enabled);
  const availableInAdd = enabledProviders.filter((p) => !bindIds.includes(p.id));
  const add = () => {
    const existingModel = selected?.existingModelId ? models.find((m) => m.id === selected.existingModelId) : undefined;
    if (existingModel) {
      const parseOvr = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
      const ovrOf = (pid: string) => {
        const o = ovrs[pid];
        if (o) return o;
        const before = existingModel.providers.find((r) => r.id === pid);
        return {
          costIn: before?.costPer1mIn != null ? String(before.costPer1mIn) : "",
          costOut: before?.costPer1mOut != null ? String(before.costPer1mOut) : "",
          cacheRead: before?.costPer1mCacheRead != null ? String(before.costPer1mCacheRead) : "",
          cacheWrite: before?.costPer1mCacheWrite != null ? String(before.costPer1mCacheWrite) : "",
          ctx: before?.contextWindow != null ? String(before.contextWindow) : "",
          maxOut: before?.maxOutputTokens != null ? String(before.maxOutputTokens) : "",
          image: before?.imageInput ?? undefined,
        };
      };
      const refs = bindIds.map((pid, i) => {
        const prov = providers.find((p) => p.id === pid);
        const before = existingModel.providers.find((r) => r.id === pid);
        const o = ovrOf(pid);
        return {
          id: pid,
          kind: prov?.kind ?? before?.kind ?? "openai-compatible",
          priority: i,
          remoteModel: slugs[pid]?.trim() || undefined,
          ...(parseOvr(o.costIn) !== undefined ? { costPer1mIn: parseOvr(o.costIn) } : {}),
          ...(parseOvr(o.costOut) !== undefined ? { costPer1mOut: parseOvr(o.costOut) } : {}),
          ...(parseOvr(o.cacheRead) !== undefined ? { costPer1mCacheRead: parseOvr(o.cacheRead) } : {}),
          ...(parseOvr(o.cacheWrite) !== undefined ? { costPer1mCacheWrite: parseOvr(o.cacheWrite) } : {}),
          ...(parseOvr(o.ctx) !== undefined ? { contextWindow: parseOvr(o.ctx) } : {}),
          ...(parseOvr(o.maxOut) !== undefined ? { maxOutputTokens: parseOvr(o.maxOut) } : {}),
          ...(o.image !== undefined ? { imageInput: o.image } : before?.imageInput !== undefined ? { imageInput: before.imageInput } : {}),
        };
      });
      client.send({ type: "model/remove", modelId: existingModel.id });
      client.send({
        type: "model/add",
        model: {
          ...existingModel,
          label: label.trim() || existingModel.label,
          tier,
          contextWindow: ctx === "" ? 0 : ctx,
          maxOutputTokens: maxOut === "" ? 0 : maxOut,
          costPer1mIn: costIn ?? 0,
          costPer1mOut: costOut ?? 0,
          costPer1mCacheRead: costCacheRead,
          costPer1mCacheWrite: costCacheWrite,
          providers: refs,
        },
      });
      void client.request("arc.model.multimodalIds").then((v) => {
        const ids = Array.isArray(v) ? v as string[] : [];
        const has = ids.includes(existingModel.id);
        if (multimodal && !has) client.send({ type: SET, key: "arc.model.multimodal.toggle", value: { modelId: existingModel.id, enabled: true } });
        else if (!multimodal && has) client.send({ type: SET, key: "arc.model.multimodal.toggle", value: { modelId: existingModel.id, enabled: false } });
      });
      setLabel(""); setCtx(""); setMaxOut(""); setCostIn(undefined); setCostOut(undefined); setCostCacheRead(undefined); setCostCacheWrite(undefined);
      setMultimodal(false); setBindIds([]); setSlugs({}); setOvrs({}); setOvrOpen(new Set()); setSelectedKey(null); setAdding(false);
      return;
    }
    if (!label.trim()) return;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36);
    const parseOvr = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
    const refs = bindIds.map((pid, i) => {
      const prov = providers.find((p) => p.id === pid);
      const o = ovrs[pid];
      return {
        id: pid,
        kind: prov?.kind ?? "openai-compatible",
        priority: i,
        remoteModel: slugs[pid]?.trim() || undefined,
        ...(o && parseOvr(o.costIn) !== undefined ? { costPer1mIn: parseOvr(o.costIn) } : {}),
        ...(o && parseOvr(o.costOut) !== undefined ? { costPer1mOut: parseOvr(o.costOut) } : {}),
        ...(o && parseOvr(o.cacheRead) !== undefined ? { costPer1mCacheRead: parseOvr(o.cacheRead) } : {}),
        ...(o && parseOvr(o.cacheWrite) !== undefined ? { costPer1mCacheWrite: parseOvr(o.cacheWrite) } : {}),
        ...(o && parseOvr(o.ctx) !== undefined ? { contextWindow: parseOvr(o.ctx) } : {}),
        ...(o && parseOvr(o.maxOut) !== undefined ? { maxOutputTokens: parseOvr(o.maxOut) } : {}),
        ...(o?.image !== undefined ? { imageInput: o.image } : {}),
      };
    });
    client.send({
      type: "model/add",
      model: {
        id,
        label,
        tier,
        contextWindow: ctx === "" ? 0 : ctx,
        maxOutputTokens: maxOut === "" ? 0 : maxOut,
        costPer1mIn: costIn ?? 0,
        costPer1mOut: costOut ?? 0,
        costPer1mCacheRead: costCacheRead,
        costPer1mCacheWrite: costCacheWrite,
        providers: refs,
      },
    });
    if (multimodal) {
      void client.request("arc.model.multimodalIds").then((v) => {
        const ids = Array.isArray(v) ? v as string[] : [];
        if (!ids.includes(id)) client.send({ type: SET, key: "arc.model.multimodal.toggle", value: { modelId: id, enabled: true } });
      });
    }
    setLabel(""); setCtx(""); setMaxOut(""); setCostIn(undefined); setCostOut(undefined); setCostCacheRead(undefined); setCostCacheWrite(undefined);
    setMultimodal(false); setBindIds([]); setSlugs({}); setOvrs({}); setSelectedKey(null); setAdding(false);
  };
  const bind = (model: ModelDescriptor, providerId: string) => {
    const provider = providers.find((p) => p.id === providerId);
    const has = model.providers.some((p) => p.id === providerId);
    if (has) {
      const updated: ModelDescriptor = { ...model, providers: model.providers.filter((p) => p.id !== providerId) };
      client.send({ type: "model/remove", modelId: model.id });
      client.send({ type: "model/add", model: updated });
      return;
    }
    const updated: ModelDescriptor = {
      ...model,
      providers: [...model.providers, {
        id: providerId,
        kind: provider?.kind ?? "openai-compatible",
        priority: model.providers.length,
      }],
    };
    client.send({ type: "model/remove", modelId: model.id });
    client.send({ type: "model/add", model: updated });
  };
  const provSpec = providerCatalog.find((p) => p.kind === provKind);
  const filteredProv = provSearch
    ? providerCatalog.filter((p) => fuzzyMatch(provSearch, p.label) || fuzzyMatch(provSearch, p.kind) || (p.tags && p.tags.some((t) => fuzzyMatch(provSearch, t))))
    : providerCatalog;
  const addProviderInline = () => {
    if (!provLabel.trim()) return;
    const pid = provLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36);
    client.send({
      type: "provider/add",
      provider: { id: pid, kind: provKind, label: provLabel, baseUrl: provKind === "vscode-lm" ? undefined : (provBaseUrl || provSpec?.defaultBaseUrl || undefined), enabled: true },
      apiKey: provKind === "vscode-lm" ? undefined : (provKey.trim() || undefined),
    });
    setBindIds((prev) => [...prev, pid]);
    setProvAdding(false); setProvLabel(""); setProvBaseUrl(""); setProvKey(""); setProvSearch("");
  };
  return (
    <Section
      title="Models"
      action={!adding && <button className="arc-btn" onClick={openAdd}><Plus size={14} /> Add model</button>}
      titleExtra={
        <button
          className="arc-iconbtn"
          onClick={reloadCatalog}
          disabled={catalogReloading}
          title={catalogReloadError ? `Reload failed: ${catalogReloadError}. The cached model data is unchanged; check your network/proxy and try again.` : "Reload model data from your providers and OpenRouter (metadata)"}
          style={{ marginLeft: 4, verticalAlign: "middle", ...(catalogReloadError ? { color: "var(--arc-err, #f66)" } : {}) }}
        >
          {catalogReloadError ? <AlertTriangle size={13} /> : <RefreshCw size={13} style={catalogReloading ? { animation: "arc-spin 1.4s linear infinite" } : undefined} />}
        </button>
      }
    >
      {adding && (
        <div className="arc-form">
          <div className="arc-form-row">
            <div style={{ position: "relative", minWidth: 220 }}>
              <input className="arc-input" placeholder="search models..." value={query} onChange={(e) => setQuery(e.target.value)} autoFocus onKeyDown={stopKbd} style={{ width: "100%" }} />
              {query && filtered.length > 0 && (
                <ul className="arc-provider-menu" style={{ maxHeight: 240 }}>
                  {filtered.slice(0, 40).map((e) => (
                    <li key={e.key} role="option" className="arc-provider-opt" onClick={() => selectEntry(e)}>{e.label}</li>
                  ))}
                </ul>
              )}
            </div>
            <input className="arc-input" placeholder="model label" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          </div>
          {catalog !== null && catalog.length === 0 && <p className="arc-empty">No models found on the configured providers. Enter details manually.</p>}
          <div className="arc-form-row">
            <select className="arc-input" value={tier} onChange={(e) => setTier(e.target.value as ModelTier)}>
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="arc-input" type="number" placeholder="context window" value={ctx || ""} onChange={(e) => setCtx(Number(e.target.value))} onKeyDown={stopKbd} />
            <input className="arc-input" type="number" placeholder="max output tokens" value={maxOut || ""} onChange={(e) => setMaxOut(Number(e.target.value))} onKeyDown={stopKbd} />
          </div>
          <div className="arc-form-row">
            <input className="arc-input" type="number" step="0.0001" placeholder="$/1M input" value={costIn ?? ""} onChange={(e) => setCostIn(e.target.value === "" ? undefined : Number(e.target.value))} onKeyDown={stopKbd} />
            <input className="arc-input" type="number" step="0.0001" placeholder="$/1M output" value={costOut ?? ""} onChange={(e) => setCostOut(e.target.value === "" ? undefined : Number(e.target.value))} onKeyDown={stopKbd} />
            <input className="arc-input" type="number" step="0.00001" placeholder="$/1M cache hit (optional)" title={T_CACHE_R} value={costCacheRead ?? ""} onChange={(e) => setCostCacheRead(e.target.value === "" ? undefined : Number(e.target.value))} onKeyDown={stopKbd} />
            <input className="arc-input" type="number" step="0.00001" placeholder="$/1M cache write (optional)" title={T_CACHE_W} value={costCacheWrite ?? ""} onChange={(e) => setCostCacheWrite(e.target.value === "" ? undefined : Number(e.target.value))} onKeyDown={stopKbd} />
            <label className="arc-check" style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={multimodal} onChange={(e) => setMultimodal(e.target.checked)} />
              <span style={{ fontSize: 12 }}>multimodal</span>
            </label>
          </div>
          <ul className="arc-binds">
            {bindIds.map((pid) => {
              const prov = providers.find((p) => p.id === pid);
              const o = ovrs[pid] ?? { costIn: "", costOut: "", cacheRead: "", cacheWrite: "", ctx: "", maxOut: "", image: false };
              const setOvr = (patch: Partial<typeof o>) => setOvrs((prev) => ({ ...prev, [pid]: { ...o, ...patch } }));
              return (
                <li key={pid} className="arc-bind">
                  <div className="arc-bind-line">
                    <span className="arc-bind-name">{prov?.label ?? pid}</span>
                    <span className="arc-bind-kind">{prov?.kind ?? ""}</span>
                    <input
                      className="arc-input arc-input-sm arc-bind-slug"
                      placeholder="remote slug (e.g. gpt-4o)"
                      value={slugs[pid] ?? ""}
                      onChange={(e) => setSlugs((prev) => ({ ...prev, [pid]: e.target.value }))}
                      onKeyDown={stopKbd}
                    />
                    <button className="arc-iconbtn" onClick={() => toggleOvr(`add:${pid}`)} title={ovrOpen.has(`add:${pid}`) ? "Collapse" : "Expand"}>
                      {ovrOpen.has(`add:${pid}`) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <button
                      className="arc-iconbtn"
                      title="Unbind"
                      onClick={() => {
                        setBindIds((arr) => arr.filter((x) => x !== pid));
                        setSlugs((prev) => { const next = { ...prev }; delete next[pid]; return next; });
                        setOvrs((prev) => { const next = { ...prev }; delete next[pid]; return next; });
                      }}
                    ><Trash2 size={12} /></button>
                  </div>
                  {ovrOpen.has(`add:${pid}`) && (
                    <div className="arc-bind-ovrs">
                      <label className="arc-field" title="Image input for this provider">
                        <span className="arc-field-label">Modality</span>
                        <label className="arc-check">
                          <input type="checkbox" checked={o.image ?? false} onChange={(e) => setOvr({ image: e.target.checked })} />
                          <span style={{ fontSize: 12 }}>multimodal</span>
                        </label>
                      </label>
                      <label className="arc-field">
                        <span className="arc-field-label">Context window</span>
                        <input className="arc-input arc-input-sm" type="number" placeholder={MD} value={o.ctx} onChange={(e) => setOvr({ ctx: e.target.value })} onKeyDown={stopKbd} />
                      </label>
                      <label className="arc-field">
                        <span className="arc-field-label">Max output</span>
                        <input className="arc-input arc-input-sm" type="number" placeholder={MD} value={o.maxOut} onChange={(e) => setOvr({ maxOut: e.target.value })} onKeyDown={stopKbd} />
                      </label>
                      <label className="arc-field">
                        <span className="arc-field-label">$ / 1M in</span>
                        <input className="arc-input arc-input-sm" type="number" step="0.0001" placeholder={MD} value={o.costIn} onChange={(e) => setOvr({ costIn: e.target.value })} onKeyDown={stopKbd} />
                      </label>
                      <label className="arc-field">
                        <span className="arc-field-label">$ / 1M out</span>
                        <input className="arc-input arc-input-sm" type="number" step="0.0001" placeholder={MD} value={o.costOut} onChange={(e) => setOvr({ costOut: e.target.value })} onKeyDown={stopKbd} />
                      </label>
                      <label className="arc-field" title={T_CACHE_R}>
                        <span className="arc-field-label">$ / 1M cache hit</span>
                        <input className="arc-input arc-input-sm" type="number" step="0.00001" placeholder={MD} value={o.cacheRead} onChange={(e) => setOvr({ cacheRead: e.target.value })} onKeyDown={stopKbd} />
                      </label>
                      <label className="arc-field" title={T_CACHE_W}>
                        <span className="arc-field-label">$ / 1M cache write</span>
                        <input className="arc-input arc-input-sm" type="number" step="0.00001" placeholder={MD} value={o.cacheWrite} onChange={(e) => setOvr({ cacheWrite: e.target.value })} onKeyDown={stopKbd} />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
            <li className="arc-bind arc-bind-add">
              {enabledProviders.length === 0 ? (
                <span className="arc-bind-hint">No providers yet. Add one below or from the Providers tab.</span>
              ) : availableInAdd.length === 0 ? (
                <span className="arc-bind-hint">all providers bound</span>
              ) : (
                <select className="arc-input arc-input-sm" value="" onChange={(e) => e.target.value && setBindIds((arr) => [...arr, e.target.value])}>
                  <option value="">+ bind provider...</option>
                  {availableInAdd.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.kind})</option>)}
                </select>
              )}
            </li>
          </ul>
          {!provAdding && (
            <button className="arc-btn-ghost" style={{ alignSelf: "flex-start", padding: "3px 10px", fontSize: 11 }} onClick={() => setProvAdding(true)}><Plus size={12} /> Add provider</button>
          )}
          {provAdding && (
            <div className="arc-form" style={{ border: "1px solid var(--arc-line)", borderRadius: 6, padding: 8 }}>
              <div className="arc-form-row">
                <div style={{ position: "relative", minWidth: 200, flex: 1 }}>
                  <input className="arc-input" placeholder="search providers..." value={provSearch} onChange={(e) => setProvSearch(e.target.value)} style={{ width: "100%" }} onKeyDown={stopKbd} />
                  {provSearch && filteredProv.length > 0 && (
                    <ul style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, maxHeight: 180, overflowY: "auto", background: DD_BG, border: "1px solid var(--vscode-input-border, var(--arc-line))", borderRadius: 6, marginTop: 2, padding: "4px 0", listStyle: "none", margin: "2px 0 0 0" }}>
                      {filteredProv.slice(0, 30).map((p) => (
                        <li key={p.kind} role="option" className="arc-provider-opt"
                          onClick={() => { setProvKind(p.kind); setProvLabel(p.label); setProvBaseUrl(""); setProvSearch(""); }}>{p.label}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <input className="arc-input" placeholder={provSpec?.label ?? "label"} value={provLabel} onChange={(e) => setProvLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addProviderInline()} />
              </div>
              {provKind !== "vscode-lm" && (
                <input className="arc-input" placeholder={provSpec?.defaultBaseUrl || "https://..."} value={provBaseUrl} onChange={(e) => setProvBaseUrl(e.target.value)} onKeyDown={stopKbd} />
              )}
              {provKind !== "vscode-lm" && (
                <input className="arc-input" type="password" placeholder="api key (optional)" value={provKey} onChange={(e) => setProvKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addProviderInline()} />
              )}
              {provKind === "github-copilot" && (
                <span className="arc-row-meta" style={{ fontSize: 11 }}>Paste a GitHub token with Copilot access (OAuth gho_/ghu_ or PAT with Copilot scope). It is exchanged automatically for a short-lived Copilot token.</span>
              )}
              {provKind === "vscode-lm" && (
                <span className="arc-row-meta" style={{ fontSize: 11 }}>Uses models from the VS Code Copilot extension; VS Code will ask for consent on first use.</span>
              )}
              <div className="arc-form-actions">
                <button className="arc-btn" onClick={addProviderInline}><Check size={14} /> Add</button>
                <button className="arc-btn-ghost" onClick={() => setProvAdding(false)}>Cancel</button>
              </div>
            </div>
          )}
          <div className="arc-form-actions">
            <button className="arc-btn" onClick={add} disabled={!label.trim()}><Check size={14} /> Save</button>
            <button className="arc-btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {models.length === 0 && !adding && <p className="arc-empty">No models yet.</p>}
      <ul className="arc-rows">
        {[...models].sort((a, b) => (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99)).map((m) => {
          const available = providers.filter((p) => !m.providers.some((mp) => mp.id === p.id));
          return (
            <li key={m.id} className="arc-row">
              <div className="arc-row-main">
                <TierDot tier={m.tier} />
                {renamingId === m.id ? (
                  <input
                    className="arc-input arc-input-sm"
                    style={{ maxWidth: 180 }}
                    value={renameValue}
                    autoFocus
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => { if (renamingId === m.id && renameValue.trim() && renameValue.trim() !== m.label) { client.send({ type: "model/remove", modelId: m.id }); client.send({ type: "model/add", model: { ...m, label: renameValue.trim() } }); } setRenamingId(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenamingId(null); e.stopPropagation(); }}
                  />
                ) : (
                  <span className="arc-row-label">{m.label}</span>
                )}
                <select className="arc-input arc-input-sm" value={m.tier} onChange={(e) => { client.send({ type: "model/remove", modelId: m.id }); client.send({ type: "model/add", model: { ...m, tier: e.target.value as ModelTier } }); }}>
                  {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <span className="arc-spacer" />
                <button className="arc-iconbtn" onClick={() => toggleOvr(`base:${m.id}`)} title={ovrOpen.has(`base:${m.id}`) ? "Collapse model settings" : "Expand model settings"}>
                  {ovrOpen.has(`base:${m.id}`) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <button className="arc-iconbtn" onClick={() => { setRenamingId(m.id); setRenameValue(m.label); }} title="Rename model"><Pencil size={14} /></button>
                <button className="arc-iconbtn" onClick={() => client.send({ type: "model/remove", modelId: m.id })} title="Remove model"><Trash2 size={14} /></button>
              </div>
              {ovrOpen.has(`base:${m.id}`) && (
              <div className="arc-row-sub" key={`edit-${m.id}`}>
                <label className="arc-field arc-field-check" title="Accepts image input">
                  <span className="arc-field-label">Modality</span>
                  <label className="arc-check">
                    <ModelMultimodalCheckbox modelId={m.id} client={client} />
                    <span style={{ fontSize: 12 }}>multimodal</span>
                  </label>
                </label>
                <label className="arc-field">
                  <span className="arc-field-label">Context window</span>
                  <input className="arc-input arc-input-sm" type="number" placeholder="auto" defaultValue={m.contextWindow || ""} onBlur={(e) => { const v = Number(e.target.value); if (v && v !== m.contextWindow) { client.send({ type: "model/remove", modelId: m.id }); client.send({ type: "model/add", model: { ...m, contextWindow: v } }); } }} onKeyDown={stopKbd} />
                </label>
                <label className="arc-field">
                  <span className="arc-field-label">Max output</span>
                  <input className="arc-input arc-input-sm" type="number" placeholder="auto" defaultValue={m.maxOutputTokens ?? ""} onBlur={(e) => { const v = Number(e.target.value) || undefined; if (v !== (m.maxOutputTokens ?? undefined)) { client.send({ type: "model/remove", modelId: m.id }); client.send({ type: "model/add", model: { ...m, maxOutputTokens: v } }); } }} onKeyDown={stopKbd} />
                </label>
                <label className="arc-field">
                  <span className="arc-field-label">$ / 1M in</span>
                  <input className="arc-input arc-input-sm" type="number" step="0.0001" placeholder="0" defaultValue={m.costPer1mIn ?? ""} onBlur={(e) => { const v = Number(e.target.value); if (v !== m.costPer1mIn) { client.send({ type: "model/remove", modelId: m.id }); client.send({ type: "model/add", model: { ...m, costPer1mIn: v } }); } }} onKeyDown={stopKbd} />
                </label>
                <label className="arc-field">
                  <span className="arc-field-label">$ / 1M out</span>
                  <input className="arc-input arc-input-sm" type="number" step="0.0001" placeholder="0" defaultValue={m.costPer1mOut ?? ""} onBlur={(e) => { const v = Number(e.target.value); if (v !== m.costPer1mOut) { client.send({ type: "model/remove", modelId: m.id }); client.send({ type: "model/add", model: { ...m, costPer1mOut: v } }); } }} onKeyDown={stopKbd} />
                </label>
                <label className="arc-field" title={T_CACHE_R}>
                  <span className="arc-field-label">$ / 1M cache hit</span>
                  <input className="arc-input arc-input-sm" type="number" step="0.00001" placeholder="= in" defaultValue={m.costPer1mCacheRead ?? ""} onBlur={(e) => { const v = e.target.value === "" ? undefined : Number(e.target.value); if (v !== m.costPer1mCacheRead) { client.send({ type: "model/remove", modelId: m.id }); client.send({ type: "model/add", model: { ...m, costPer1mCacheRead: v } }); } }} onKeyDown={stopKbd} />
                </label>
                <label className="arc-field" title={T_CACHE_W}>
                  <span className="arc-field-label">$ / 1M cache write</span>
                  <input className="arc-input arc-input-sm" type="number" step="0.00001" placeholder="= in" defaultValue={m.costPer1mCacheWrite ?? ""} onBlur={(e) => { const v = e.target.value === "" ? undefined : Number(e.target.value); if (v !== m.costPer1mCacheWrite) { client.send({ type: "model/remove", modelId: m.id }); client.send({ type: "model/add", model: { ...m, costPer1mCacheWrite: v } }); } }} onKeyDown={stopKbd} />
                </label>
              </div>
              )}
              <ul className="arc-binds">
                {m.providers.map((p) => {
                  const prov = providers.find((x) => x.id === p.id);
                  const ovrKey = `${m.id}:${p.id}`;
                  return (
                    <li key={p.id} className="arc-bind">
                      <div className="arc-bind-line">
                        <span className="arc-bind-name">{prov?.label ?? p.id}</span>
                        <span className="arc-bind-kind">{prov?.kind ?? p.kind}</span>
                        <input
                          className="arc-input arc-input-sm arc-bind-slug"
                          placeholder="remote slug (e.g. gpt-4o)"
                          value={p.remoteModel ?? ""}
                          onBlur={(e) => client.send({ type: "model/bindUpdate", modelId: m.id, providerId: p.id, remoteModel: e.target.value.trim() || undefined })}
                        />
                        <button className="arc-iconbtn" onClick={() => toggleOvr(ovrKey)} title={ovrOpen.has(ovrKey) ? "Collapse" : "Expand"}>
                          {ovrOpen.has(ovrKey) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </button>
                        <button className="arc-iconbtn" onClick={() => bind(m, p.id)} title="Unbind"><Trash2 size={12} /></button>
                      </div>
                      {ovrOpen.has(ovrKey) && (
                        <div className="arc-bind-ovrs">
                          <label className="arc-field" title="Image input for this provider">
                            <span className="arc-field-label">Modality</span>
                            <label className="arc-check">
                              <input type="checkbox" defaultChecked={p.imageInput ?? false} onChange={(e) => client.send({ type: "model/bindUpdate", modelId: m.id, providerId: p.id, imageInput: e.target.checked })} />
                              <span style={{ fontSize: 12 }}>multimodal</span>
                            </label>
                          </label>
                          <label className="arc-field" key={`ovr-ctx-${p.id}-${p.contextWindow ?? ""}`}>
                            <span className="arc-field-label">Context window</span>
                            <input className="arc-input arc-input-sm" type="number" placeholder={MD} defaultValue={p.contextWindow ?? ""} onBlur={(e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (v !== (p.contextWindow ?? 0)) client.send({ type: "model/bindUpdate", modelId: m.id, providerId: p.id, contextWindow: v }); }} onKeyDown={stopKbd} />
                          </label>
                          <label className="arc-field" key={`ovr-max-${p.id}-${p.maxOutputTokens ?? ""}`}>
                            <span className="arc-field-label">Max output</span>
                            <input className="arc-input arc-input-sm" type="number" placeholder={MD} defaultValue={p.maxOutputTokens ?? ""} onBlur={(e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (v !== (p.maxOutputTokens ?? 0)) client.send({ type: "model/bindUpdate", modelId: m.id, providerId: p.id, maxOutputTokens: v }); }} onKeyDown={stopKbd} />
                          </label>
                          <label className="arc-field" key={`ovr-in-${p.id}-${p.costPer1mIn ?? ""}`}>
                            <span className="arc-field-label">$ / 1M in</span>
                            <input className="arc-input arc-input-sm" type="number" step="0.0001" placeholder={MD} defaultValue={p.costPer1mIn ?? ""} onBlur={(e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (v !== (p.costPer1mIn ?? 0)) client.send({ type: "model/bindUpdate", modelId: m.id, providerId: p.id, costPer1mIn: v }); }} onKeyDown={stopKbd} />
                          </label>
                          <label className="arc-field" key={`ovr-out-${p.id}-${p.costPer1mOut ?? ""}`}>
                            <span className="arc-field-label">$ / 1M out</span>
                            <input className="arc-input arc-input-sm" type="number" step="0.0001" placeholder={MD} defaultValue={p.costPer1mOut ?? ""} onBlur={(e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (v !== (p.costPer1mOut ?? 0)) client.send({ type: "model/bindUpdate", modelId: m.id, providerId: p.id, costPer1mOut: v }); }} onKeyDown={stopKbd} />
                          </label>
                          <label className="arc-field" key={`ovr-cr-${p.id}-${p.costPer1mCacheRead ?? ""}`} title={T_CACHE_R}>
                            <span className="arc-field-label">$ / 1M cache hit</span>
                            <input className="arc-input arc-input-sm" type="number" step="0.00001" placeholder={MD} defaultValue={p.costPer1mCacheRead ?? ""} onBlur={(e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (v !== (p.costPer1mCacheRead ?? 0)) client.send({ type: "model/bindUpdate", modelId: m.id, providerId: p.id, costPer1mCacheRead: v }); }} onKeyDown={stopKbd} />
                          </label>
                          <label className="arc-field" key={`ovr-cw-${p.id}-${p.costPer1mCacheWrite ?? ""}`} title={T_CACHE_W}>
                            <span className="arc-field-label">$ / 1M cache write</span>
                            <input className="arc-input arc-input-sm" type="number" step="0.00001" placeholder={MD} defaultValue={p.costPer1mCacheWrite ?? ""} onBlur={(e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (v !== (p.costPer1mCacheWrite ?? 0)) client.send({ type: "model/bindUpdate", modelId: m.id, providerId: p.id, costPer1mCacheWrite: v }); }} onKeyDown={stopKbd} />
                          </label>
                        </div>
                      )}
                    </li>
                  );
                })}
                <li className="arc-bind arc-bind-add">
                  {providers.length === 0 ? (
                    <button className="arc-link" onClick={() => onSwitchTab("providers")}>Add a provider first →</button>
                  ) : available.length === 0 ? (
                    <span className="arc-bind-hint">all providers bound</span>
                  ) : (
                    <select className="arc-input arc-input-sm" value="" onChange={(e) => e.target.value && bind(m, e.target.value)}>
                      <option value="">+ bind provider...</option>
                      {available.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.kind})</option>)}
                    </select>
                  )}
                </li>
              </ul>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
function ProvidersTab({ client, providers, models, providerCatalog, serverStates, setServerStates }: { client: RpcClient; providers: ProviderSummary[]; models: ModelDescriptor[]; providerCatalog: ProviderSpec[]; serverStates: Record<string, { running: boolean; pid?: number; error?: string; starting?: boolean }>; setServerStates: React.Dispatch<React.SetStateAction<Record<string, { running: boolean; pid?: number; error?: string; starting?: boolean }>>> }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeys, setApiKeys] = useState<string[]>([""]);
  const [startCommand, setStartCommand] = useState("");
  const [providerSearch, setProviderSearch] = useState("");
  const [internalSetup, setInternalSetup] = useState<{ phase: string; pct: number; error?: string } | null>(null);
  const hasInternal = providers.some((p) => p.label === "Internal" && p.enabled);
  const showBanner = !hasInternal || !!internalSetup;
  useEffect(() => {
    const off = client.on((e: HostEvent) => {
      if (e.type === "provider/internalSetupProgress") {
        setInternalSetup({ phase: e.phase, pct: e.pct, error: e.error });
      }
      if (e.type === "provider/list") {
        if (e.providers.some((p) => p.label === "Internal" && p.enabled)) {
          setInternalSetup((prev) => (prev && prev.pct < 100 ? prev : null));
        }
      }
      if (e.type === "provider/serverState") {
        setServerStates((prev) => ({ ...prev, [e.providerId]: { running: e.running, pid: e.pid, error: e.error, starting: false } }));
      }
    });
    client.send({ type: "provider/list" });
    return off;
  }, [client]);
  const setupInternal = () => {
    setInternalSetup({ phase: "Starting...", pct: 0 });
    client.send({ type: "provider/setupInternal" });
  };
  const spec = providerCatalog.find((p) => p.kind === kind);
  const add = () => {
    if (!label.trim()) return;
    const keys = kind === "vscode-lm" ? [] : apiKeys.map((k) => k.trim()).filter(Boolean);
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36);
    client.send({
      type: "provider/add",
      provider: { id, kind, label, baseUrl: kind === "vscode-lm" ? undefined : (baseUrl || spec?.defaultBaseUrl || undefined), startCommand: startCommand || undefined, enabled: true },
      apiKey: keys[0],
      apiKeys: keys.length ? keys : undefined,
    });
    setLabel(""); setBaseUrl(""); setApiKeys([""]); setStartCommand(""); setProviderSearch(""); setAdding(false);
  };
  const filteredProviders = providerSearch.length > 0
    ? providerCatalog.filter((p) => fuzzyMatch(providerSearch, p.label) || fuzzyMatch(providerSearch, p.kind) || (p.tags && p.tags.some((t) => fuzzyMatch(providerSearch, t))))
    : providerCatalog;
  return (
    <Section
      title="Providers"
      action={!adding && <button className="arc-btn" onClick={() => setAdding(true)}><Plus size={14} /> Add provider</button>}
    >
      {adding && (
        <div className="arc-form">
          <div className="arc-form-row">
            <div style={{ position: "relative", minWidth: 220 }}>
              <input className="arc-input" placeholder="search providers..." value={providerSearch} onChange={(e) => setProviderSearch(e.target.value)} autoFocus style={{ width: "100%" }} />
              {providerSearch && filteredProviders.length > 0 && (
                <ul style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, maxHeight: 200, overflowY: "auto", background: DD_BG, border: "1px solid var(--vscode-input-border, var(--arc-line))", borderRadius: 6, marginTop: 2, padding: "4px 0", listStyle: "none", margin: "2px 0 0 0" }}>
                  {filteredProviders.slice(0, 30).map((p) => (
                    <li key={p.kind} role="option" className="arc-provider-opt"
                      onClick={() => { setKind(p.kind); setLabel(p.label); setBaseUrl(""); setProviderSearch(""); }}>{p.label}</li>
                  ))}
                </ul>
              )}
            </div>
            <input className="arc-input" placeholder={spec?.label ?? "label"} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          {kind !== "vscode-lm" && (
            <input className="arc-input" placeholder={spec?.defaultBaseUrl || "https://..."} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          )}
          {kind !== "vscode-lm" && apiKeys.map((k, i) => (
            <div key={i} className="arc-form-row" style={{ gap: 6 }}>
              <input className="arc-input" type="password" placeholder={i === 0 ? "api key" : "additional api key (optional)"} value={k} onChange={(e) => setApiKeys((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))} onKeyDown={(e) => e.key === "Enter" && add()} />
              {i > 0 && <button className="arc-iconbtn" onClick={() => setApiKeys((arr) => arr.filter((_, j) => j !== i))} title="Discard"><X size={13} /></button>}
            </div>
          ))}
          {kind !== "vscode-lm" && (
            <button className="arc-btn-ghost" style={{ alignSelf: "flex-start", padding: "3px 10px", fontSize: 11 }} onClick={() => setApiKeys((arr) => [...arr, ""])}><Plus size={12} /> Add another key</button>
          )}
          {kind === "github-copilot" && (
            <span className="arc-row-meta" style={{ fontSize: 11 }}>Paste a GitHub token with Copilot access (OAuth gho_/ghu_ or PAT with Copilot scope). It is exchanged automatically for a short-lived Copilot token.</span>
          )}
          {kind === "vscode-lm" && (
            <span className="arc-row-meta" style={{ fontSize: 11 }}>Uses models from the VS Code Copilot extension; VS Code will ask for consent on first use.</span>
          )}
          {(baseUrl.startsWith("http://127.") || baseUrl.startsWith("http://localhost")) && (
            <input className="arc-input" placeholder="start command (runs from ~)" value={startCommand} onChange={(e) => setStartCommand(e.target.value)} />
          )}
          <div className="arc-form-actions">
            <button className="arc-btn" onClick={add}><Check size={14} /> Save</button>
            <button className="arc-btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {providers.length === 0 && !adding && !showBanner && <p className="arc-empty">No providers yet.</p>}
      {showBanner && (
        <div className="arc-provider-banner">
          <p className="arc-provider-banner-text">
            Limited-time offer: free access to the GLM 5.3 Flash model for all users. Set up in one click.
          </p>
          {!internalSetup || (internalSetup.error || internalSetup.pct >= 100) ? (
            <div className="arc-provider-banner-actions">
              {internalSetup?.error ? (
                <>
                  <span className="arc-provider-banner-error">{internalSetup.error}</span>
                  <button className="arc-btn" onClick={setupInternal}>Retry</button>
                </>
              ) : internalSetup && internalSetup.pct >= 100 ? (
                <span className="arc-provider-banner-done">Ready. See "Internal" provider below.</span>
              ) : (
                <button className="arc-btn" onClick={setupInternal}>Set up</button>
              )}
            </div>
          ) : (
            <div className="arc-provider-banner-progress">
              <div className="arc-progress-bar">
                <div className="arc-progress-fill" style={{ width: `${internalSetup.pct}%` }} />
              </div>
              <p className="arc-progress-text">{internalSetup.phase}</p>
            </div>
          )}
        </div>
      )}
      <ul className="arc-rows">
        {providers.map((p) => {
          const bound = models.filter((m) => m.providers.some((mp) => mp.id === p.id));
          if (editingId === p.id) {
            return <li key={p.id} className="arc-row"><EditProviderForm client={client} provider={p} onDone={() => setEditingId(null)} /></li>;
          }
          const ss = serverStates[p.id];
          return (
            <li key={p.id} className="arc-row">
              <div className="arc-row-main">
                <span className="arc-row-label">{p.label}</span>
                <span className="arc-row-meta">{p.kind}</span>
                {p.apiKeyCount > 0 && <span className="arc-row-meta">{p.apiKeyCount} key{p.apiKeyCount === 1 ? "" : "s"}</span>}
                {p.baseUrl && <code className="arc-row-code">{p.baseUrl}</code>}
                {p.startCommand && (
                  ss?.running
                    ? <button className="arc-btn" style={BTN_SM} onClick={() => { setServerStates((prev) => ({ ...prev, [p.id]: { running: false } })); client.send({ type: "provider/stopServer", providerId: p.id }); }}>Stop server</button>
                    : <button className="arc-btn-ghost" style={BTN_SM} onClick={() => { setServerStates((prev) => ({ ...prev, [p.id]: { running: false, starting: true } })); client.send({ type: "provider/startServer", providerId: p.id }); }}>Start server</button>
                )}
                <span className="arc-spacer" />
                <Toggle checked={p.enabled} onChange={(enabled) => client.send({ type: "provider/toggle", providerId: p.id, enabled })} />
                <button className="arc-iconbtn" onClick={() => setEditingId(p.id)} title="Edit"><Pencil size={14} /></button>
                <button className="arc-iconbtn" onClick={() => client.send({ type: "provider/remove", providerId: p.id })} title="Remove"><Trash2 size={14} /></button>
              </div>
              {ss?.error && <div className="arc-row-sub" style={{ color: "var(--vscode-errorForeground, #f48771)" }}>{ss.error}</div>}
              {ss?.starting && !ss?.error && <div className="arc-row-sub">Starting...</div>}
              {bound.length > 0 && <div className="arc-row-sub">bound to {bound.map((m) => m.label).join(", ")}</div>}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
function EditProviderForm({ client, provider, onDone }: { client: RpcClient; provider: ProviderSummary; onDone: () => void }) {
  const [label, setLabel] = useState(provider.label);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [replacements, setReplacements] = useState<Record<number, string>>({});
  const [added, setAdded] = useState<string[]>([""]);
  const [removed, setRemoved] = useState<number[]>([]);
  const [startCmd, setStartCmd] = useState(provider.startCommand ?? "");
  const isLocal = (baseUrl || provider.baseUrl || "").startsWith("http://127.") || (baseUrl || provider.baseUrl || "").startsWith("http://localhost");
  const save = () => {
    if (!label.trim()) return;
    const addApiKeys = added.map((k) => k.trim()).filter(Boolean);
    const replaceApiKeys = Object.entries(replacements).filter(([, v]) => v.trim()).map(([i, v]) => ({ index: Number(i), key: v.trim() }));
    client.send({
      type: "provider/update",
      providerId: provider.id,
      changes: { label, baseUrl, startCommand: isLocal ? (startCmd || undefined) : undefined },
      addApiKeys: addApiKeys.length ? addApiKeys : undefined,
      removeApiKeyIndices: removed.length ? removed : undefined,
      replaceApiKeys: replaceApiKeys.length ? replaceApiKeys : undefined,
    } as unknown as Parameters<typeof client.send>[0]);
    onDone();
  };
  const keyCount = provider.apiKeyCount ?? (provider.hasApiKey ? 1 : 0);
  return (
    <div className="arc-form" style={{ width: "100%" }}>
      <div className="arc-form-row">
        <input className="arc-input" placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
      </div>
      <input className="arc-input" placeholder="https://..." value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      {keyCount > 0 && Array.from({ length: keyCount }, (_, i) => {
        const isRm = removed.includes(i);
        const preview = provider.apiKeyPreviews?.[i];
        return (
          <div key={i} className="arc-form-row" style={{ gap: 6 }}>
            <input className="arc-input" type="password" placeholder={preview ?? `key ${i + 1}`} value={replacements[i] ?? ""} onChange={(e) => setReplacements((r) => ({ ...r, [i]: e.target.value }))} disabled={isRm} style={{ opacity: isRm ? 0.5 : 1 }} onKeyDown={(e) => e.key === "Enter" && save()} />
            <button className="arc-iconbtn" onClick={() => setRemoved((r) => r.includes(i) ? r.filter((x) => x !== i) : [...r, i])} title={isRm ? "Undo remove" : "Remove key"} style={{ opacity: isRm ? 1 : 0.6, color: isRm ? "var(--vscode-errorForeground)" : undefined }}><Trash2 size={13} /></button>
          </div>
        );
      })}
      {added.map((k, i) => (
        <div key={`new-${i}`} className="arc-form-row" style={{ gap: 6 }}>
          <input className="arc-input" type="password" placeholder={i === 0 && keyCount === 0 ? "api key" : "additional api key"} value={k} onChange={(e) => setAdded((arr) => arr.map((x, j) => j === i ? e.target.value : x))} onKeyDown={(e) => e.key === "Enter" && save()} />
          <button className="arc-iconbtn" onClick={() => setAdded((arr) => arr.filter((_, j) => j !== i))} title="Discard"><X size={13} /></button>
        </div>
      ))}
      <button className="arc-btn-ghost" style={{ alignSelf: "flex-start", padding: "3px 10px", fontSize: 11 }} onClick={() => setAdded((arr) => [...arr, ""])}><Plus size={12} /> Add another key</button>
      {keyCount > 1 && <span className="arc-row-meta" style={{ fontSize: 11 }}>keys rotate across requests and retry attempts</span>}
      {isLocal && (
        <input className="arc-input" placeholder="start command (runs from ~)" value={startCmd} onChange={(e) => setStartCmd(e.target.value)} />
      )}
      <div className="arc-form-actions">
        <button className="arc-btn" onClick={save}><Check size={14} /> Save</button>
        <button className="arc-btn-ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
function McpCategory({ client }: { client: RpcClient }) {
  const [servers, setServers] = useState<{ name: string; enabled: boolean; transport: "stdio" | "http" | "sse"; toolCount: number; status: string; oauth?: boolean }[]>([]);
  useEffect(() => {
    const off = client.on((e: HostEvent) => { if (e.type === "mcp/list") setServers(e.servers); });
    client.send({ type: "mcp/list" });
    return off;
  }, [client]);
  return (
    <>
      <Section collapsible title="MCP">
        <McpServersSection client={client} servers={servers} />
        <McpMarketplace client={client} existingServers={servers} />
      </Section>
    </>
  );
}
function McpServersSection({ client, servers }: { client: RpcClient; servers: { name: string; enabled: boolean; transport: "stdio" | "http" | "sse"; toolCount: number; status: string; oauth?: boolean }[] }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [transportType, setTransportType] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("npx -y @modelcontextprotocol/server-fetch");
  const [url, setUrl] = useState("https://example.com/mcp");
  const [auth, setAuth] = useState(false);
  const add = () => {
    if (!name.trim()) return;
    if (transportType === "stdio") {
      const parts = command.trim().split(/\s+/);
      client.send({ type: "mcp/addServer", name, transport: { type: "stdio", command: parts[0], args: parts.slice(1) } });
    } else {
      client.send({ type: "mcp/addServer", name, transport: { type: transportType, url, ...(auth ? { auth: "oauth" as const } : {}) } });
    }
    setName(""); setAuth(false); setAdding(false);
  };
  const toggle = (serverName: string, enabled: boolean) => {
    client.send({ type: "mcp/toggleServer", name: serverName, enabled });
  };
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const testCall = (serverName: string) => {
    setTesting(serverName); setTestResults((prev) => ({ ...prev, [serverName]: "Calling..." }));
    client.send({ type: "mcp/testCall", server: serverName, tool: "listResources" });
  };
  const authenticate = (serverName: string) => {
    setTestResults((prev) => ({ ...prev, [serverName]: "Authorizing..." }));
    client.send({ type: "mcp/authenticate", server: serverName });
  };
  const [logText, setLogText] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const off = client.on((e: any) => {
      if (e.type === "mcp/testResult") { setTestResults((prev) => ({ ...prev, [e.server ?? testing]: e.output ?? "(no response)" })); setTesting(null); }
      if (e.type === "mcp/traffic") { setLogText((prev) => (prev.length > 100_000 ? prev.slice(prev.indexOf("\n") + 1) : prev) + e.line + "\n"); }
    });
    return off;
  }, [client, testing]);
  useEffect(() => {
    if (showDebug && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logText, showDebug]);
  return (
      <Section collapsible nested title="Configured servers" description="MCP servers expose tools to the agent." action={!adding && <button className="arc-btn" onClick={() => setAdding(true)}><Plus size={14} /> Add server</button>}>
        {adding && (
          <div className="arc-form">
            <div className="arc-form-row">
              <input className="arc-input" placeholder="server name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
              <select className="arc-input" value={transportType} onChange={(e) => setTransportType(e.target.value as "stdio" | "http" | "sse")}>
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </div>
            {transportType === "stdio" ? (
              <input className="arc-input" placeholder="command + args" value={command} onChange={(e) => setCommand(e.target.value)} />
            ) : (
              <>
                <input className="arc-input" placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} />
                <label className="arc-check" style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={auth} onChange={(e) => setAuth(e.target.checked)} />
                  <span>OAuth authorization (sign in via browser)</span>
                </label>
              </>
            )}
            <div className="arc-form-actions">
              <button className="arc-btn" onClick={add}><Check size={14} /> Save</button>
              <button className="arc-btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}
        {servers.length === 0 && !adding && <p className="arc-empty">No servers configured.</p>}
        <ul className="arc-rows">
          {servers.map((s) => (
            <li key={s.name} className="arc-row">
              <div className="arc-row-main">
                <Plug size={14} className="arc-row-icon" />
                <span className="arc-row-label">{s.name}</span>
                <span className="arc-row-meta">{s.transport} · {s.toolCount} tool{s.toolCount === 1 ? "" : "s"}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={s.status}>
                  {s.enabled ? (s.toolCount > 0 ? <CircleDot size={12} style={{ color: "var(--arc-ok)" }} /> : <RefreshCw size={11} style={{ color: "var(--vscode-descriptionForeground)", opacity: 0.6, animation: "arc-spin 1.4s linear infinite" }} />) : <AlertTriangle size={12} style={{ color: "var(--arc-err)" }} />}
                  <span style={{ fontSize: 10, color: "var(--vscode-descriptionForeground)" }}>{s.enabled ? (s.toolCount > 0 ? "OK" : s.status) : "OFF"}</span>
                </span>
                <span className="arc-spacer" />
                <button className="arc-chip" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => testCall(s.name)} disabled={!s.enabled || testing === s.name}><Play size={11} /> Test</button>
                {s.transport !== "stdio" && <button className="arc-chip" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => authenticate(s.name)} disabled={!s.enabled}>Authenticate</button>}
                <Toggle checked={s.enabled} onChange={(enabled) => toggle(s.name, enabled)} />
                <button className="arc-iconbtn" onClick={() => client.send({ type: "mcp/removeServer", name: s.name })} title="Remove"><Trash2 size={14} /></button>
              </div>
              {testing === s.name && <p className="arc-empty">Testing {s.name}...</p>}
              {testResults[s.name] && <div className="arc-mcp-test-output">{testResults[s.name]}</div>}
            </li>
          ))}
        </ul>
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <button className="arc-chip" onClick={() => setShowDebug(!showDebug)} style={{ padding: "3px 8px", fontSize: 11 }}>
            {showDebug ? "Hide" : "Show"} traffic
          </button>
          {showDebug && <button className="arc-iconbtn" onClick={() => setLogText("")} title="Clear"><RefreshCw size={12} /></button>}
        </div>
        {showDebug && <pre className="arc-mcp-test-output" ref={logRef}>{logText || "No traffic yet. Monitoring..."}</pre>}
      </Section>
  );
}
function McpMarketplace({ client, existingServers }: { client: RpcClient; existingServers: { name: string }[] }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const installed = new Set(existingServers.map((s) => s.name));
  useEffect(() => {
    const off = client.on((e: any) => {
      if (e.type === "mcp/marketplaceResults") {
        setLoading(false);
        if (e.error) setError(e.error);
        else { setResults(e.results ?? []); setError(null); }
      }
    });
    client.send({ type: "mcp/marketplaceSearch", query: "" });
    return off;
  }, [client]);
  const search = () => {
    setLoading(true); setError(null);
    client.send({ type: "mcp/marketplaceSearch", query: query.trim() });
  };
  const install = (item: any) => {
    const srv = item.server ?? item;
    const name = srv.name;
    setInstalling(name);
    const pkg = srv.packages?.[0];
    const remote = srv.remotes?.[0];
    if (remote?.type === "http" && remote.url) {
      client.send({ type: "mcp/addServer", name, transport: { type: "http", url: remote.url } });
    } else if (pkg) {
      const version = pkg.version || srv.version;
      if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) { setInstalling(null); return; }
      const pinned = pkg.registryType === "pypi" ? `${pkg.identifier}==${version}` : `${pkg.identifier}@${version}`;
      const cmd = pkg.registryType === "pypi" ? `uvx ${pinned}` : `npx -y ${pinned}`;
      const parts = cmd.trim().split(/\s+/);
      client.send({ type: "mcp/addServer", name, transport: { type: "stdio", command: parts[0], args: parts.slice(1) } });
    }
    setTimeout(() => setInstalling(null), 3000);
  };
  const remoteType = (item: any) => {
    const r = item.server?.remotes?.[0];
    if (r?.type === "http") return "HTTP";
    return "stdio";
  };
  return (
    <Section collapsible nested title="Marketplace" description="Browse the official MCP registry for ready-to-install servers.">
      <div style={{ marginBottom: 12 }}>
        <input className="arc-input arc-input-grow" placeholder="filter by name..." value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
      </div>
      {loading && <p className="arc-empty">Loading marketplace...</p>}
      {error && <p className="arc-empty" style={{ color: "var(--arc-err)" }}>{error}</p>}
      {!loading && !error && results.length === 0 && <p className="arc-empty">No results.</p>}
      <div className="arc-mcp-cards">
        {results.map((item) => {
          const srv = item.server ?? item;
          const isInstalled = installed.has(srv.name);
          const isInstalling = installing === srv.name;
          const pkg = srv.packages?.[0];
          return (
            <div key={srv.name} className={`arc-mcp-card ${isInstalled ? "is-installed" : ""}`}>
              <div className="arc-mcp-card-head">
                <span className="arc-mcp-card-name">{srv.title || srv.name}</span>
              </div>
              <p className="arc-mcp-card-desc">{srv.description || ""}</p>
              <div className="arc-mcp-card-foot">
                {pkg ? <code>{pkg.identifier}</code> : <span>{remoteType(item)}</span>}
                {isInstalled ? (
                  <span style={{ color: "var(--arc-ok)", fontSize: 11, fontWeight: 500 }}>installed</span>
                ) : (
                  <button className="arc-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => install(item)} disabled={isInstalling}>
                    {isInstalling ? "..." : "Install"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
function VerificationSection({ client }: { client: RpcClient }) {
  const [verifyMode, setVerifyMode] = useState<"none" | "default" | "custom">("default");
  const [verifyMaxRetries, setVerifyMaxRetries] = useState(3);
  useEffect(() => {
    void client.request("arc.verify.mode").then((v) => setVerifyMode(v === "none" || v === "custom" ? v : "default"));
    void client.request("arc.verify.customMaxRetries").then((v) => setVerifyMaxRetries(typeof v === "number" ? v : 3));
  }, [client]);
  return (
      <Section collapsible title="Verification" description="Runs centralized ~/.arc workspace verification commands after edits and feeds failures back to the agent.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Retry strategy</span>
            <span className="arc-row-meta">how many times to retry after a failed verification</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={verifyMode} onChange={(e) => { const v = e.target.value as typeof verifyMode; setVerifyMode(v); client.send({ type: SET, key: "arc.verify.mode", value: v }); }}>
              <option value="none">off</option>
              <option value="default">default</option>
              <option value="custom">custom...</option>
            </select>
          </div></li>
          {verifyMode === "custom" && (
            <li className="arc-row"><div className="arc-row-main">
              <span className="arc-row-label">Max retries</span>
              <span className="arc-spacer" />
              <input className="arc-input arc-input-sm" type="number" min={0} step={1} value={verifyMaxRetries} onChange={(e) => setVerifyMaxRetries(Number(e.target.value))} onBlur={() => client.send({ type: SET, key: "arc.verify.customMaxRetries", value: verifyMaxRetries })} />
            </div></li>
          )}
        </ul>
      </Section>
  );
}
function CompactionSection({ client }: { client: RpcClient }) {
  const [compactionStrategy, setCompactionStrategy] = useState<"model-aware" | "fixed">("model-aware");
  const [safetyMargin, setSafetyMargin] = useState(0.15);
  const [fixedAtPct, setFixedAtPct] = useState(75);
  useEffect(() => {
    void client.request("arc.compaction.strategy").then((v) => setCompactionStrategy((v as typeof compactionStrategy) ?? "model-aware"));
    void client.request("arc.compaction.safetyMargin").then((v) => setSafetyMargin(typeof v === "number" ? v : 0.15));
    void client.request("arc.compaction.fixedAtPct").then((v) => setFixedAtPct(typeof v === "number" ? v : 75));
  }, [client]);
  return (
      <Section collapsible title="Compaction" description="Controls when and how conversation context is summarized.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Strategy</span>
            {compactionStrategy === "model-aware" && (
              <span className="arc-info-icon" title="Learns from recent turns: reserves headroom for the model's average thinking + response length plus the safety margin below, and may compact at the cost-optimal point once pricing is known — but never before half the usable window (see the context tooltip). Falls back to a fixed output reserve when few turns have been observed.">
                <Info size={13} />
              </span>
            )}
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={compactionStrategy} onChange={(e) => { const v = e.target.value as typeof compactionStrategy; setCompactionStrategy(v); client.send({ type: SET, key: "arc.compaction.strategy", value: v }); }}>
              <option value="model-aware">model-aware</option>
              <option value="fixed">fixed</option>
            </select>
          </div></li>
          {compactionStrategy === "fixed" && (
            <li className="arc-row"><div className="arc-row-main">
              <span className="arc-row-label">Compact at</span>
              <span className="arc-row-meta">% of context window</span>
              <span className="arc-spacer" />
              <input className="arc-input arc-input-sm" type="number" min={1} max={100} step={5} value={fixedAtPct} onChange={(e) => setFixedAtPct(Number(e.target.value))} onBlur={() => client.send({ type: SET, key: "arc.compaction.fixedAtPct", value: Math.min(100, Math.max(1, fixedAtPct || 75)) })} style={{ width: 72 }} />
            </div></li>
          )}
          {compactionStrategy === "model-aware" && (
            <li className="arc-row"><div className="arc-row-main">
              <span className="arc-row-label">Safety margin</span>
              <span className="arc-row-meta">extra headroom below the learned output reserve</span>
              <span className="arc-spacer" />
              <input className="arc-input arc-input-sm" type="number" min={0} max={0.5} step={0.05} value={safetyMargin} onChange={(e) => setSafetyMargin(Number(e.target.value))} onBlur={() => client.send({ type: SET, key: "arc.compaction.safetyMargin", value: safetyMargin })} />
            </div></li>
          )}
        </ul>
      </Section>
  );
}
function ReasoningSection({ client }: { client: RpcClient }) {
  const [reasoningEffort, setReasoningEffort] = useState<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">("high");
  useEffect(() => {
    void client.request("arc.reasoning.effort").then((v) => {
      const known = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
      setReasoningEffort(known.includes(String(v)) ? v as typeof reasoningEffort : "high");
    });
  }, [client]);
  return (
      <Section collapsible title="Reasoning" description="How much the model reasons before responding on new chats.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Default effort</span>
            <span className="arc-row-meta">reasoning budget for new conversations</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={reasoningEffort} onChange={(e) => { const v = e.target.value as typeof reasoningEffort; setReasoningEffort(v); client.send({ type: SET, key: "arc.reasoning.effort", value: v }); }}>
              <option value="none">none</option>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
              <option value="max">max</option>
            </select>
          </div></li>
        </ul>
      </Section>
  );
}
function ComposerSection({ client }: { client: RpcClient }) {
  const [polishLevel, setPolishLevel] = useState<"off" | "basic" | "polish">("off");
  const [routerQuality, setRouterQuality] = useState<"balanced" | "economy" | "power">("balanced");
  const [autoRoute, setAutoRoute] = useState(false);
  useEffect(() => {
    void client.request("arc.promptPolish").then((v) => setPolishLevel(v === "basic" || v === "polish" ? v : "off"));
    void client.request("arc.router.quality").then((v) => {
      const known = ["balanced", "economy", "power"];
      setRouterQuality(known.includes(String(v)) ? v as typeof routerQuality : "balanced");
    });
    void client.request("arc.router.autoRoute").then((v) => setAutoRoute(v === true));
  }, [client]);
  return (
      <Section collapsible title="Composer" description="Prompt handling before sending.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Prompt polish</span>
            <span className="arc-row-meta">rewrite prompts before sending</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={polishLevel} onChange={(e) => { const v = e.target.value as "off" | "basic" | "polish"; setPolishLevel(v); client.send({ type: SET, key: "arc.promptPolish", value: v }); }}>
              <option value="off">off</option>
              <option value="basic">basic</option>
              <option value="polish">polish</option>
            </select>
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Auto routing quality</span>
            <span className="arc-row-meta">model strength vs cost for the Auto model</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={routerQuality} onChange={(e) => { const v = e.target.value as typeof routerQuality; setRouterQuality(v); client.send({ type: SET, key: "arc.router.quality", value: v }); }}>
              <option value="balanced">balanced</option>
              <option value="economy">prefer cheaper</option>
              <option value="power">prefer stronger</option>
            </select>
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Auto route directly</span>
            <span className="arc-row-meta">skip the routed-model confirmation and send immediately</span>
            <span className="arc-spacer" />
            <Toggle checked={autoRoute} onChange={(v) => { setAutoRoute(v); client.send({ type: SET, key: "arc.router.autoRoute", value: v }); }} />
          </div></li>
        </ul>
      </Section>
  );
}
function TitlesSection({ client, models }: { client: RpcClient; models: ModelDescriptor[] }) {
  const [titleGenMethod, setTitleGenMethod] = useState<string>("first-words");
  useEffect(() => {
    void client.request("arc.titleGeneration.method").then((v) => setTitleGenMethod(typeof v === "string" && v ? v : "first-words"));
  }, [client]);
  return (
      <Section collapsible title="Titles" description="How new chat titles are generated.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Method</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={titleGenMethod} onChange={(e) => { const v = e.target.value; setTitleGenMethod(v); client.send({ type: SET, key: "arc.titleGeneration.method", value: v }); }}>
              <option value="first-words">first 40 chars</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div></li>
        </ul>
      </Section>
  );
}
function ImagesSection({ client, models }: { client: RpcClient; models: ModelDescriptor[] }) {
  const [describer, setDescriber] = useState<string>("none");
  const [multimodalIds, setMultimodalIds] = useState<string[]>([]);
  useEffect(() => {
    void client.request("arc.image.describeModel").then((v) => setDescriber(typeof v === "string" && v ? v : "none"));
    void client.request("arc.model.multimodalIds").then((v) => setMultimodalIds(Array.isArray(v) ? v as string[] : []));
  }, [client]);
  const multimodal = models.filter((m) => multimodalIds.includes(m.id));
  const known = describer === "none" || multimodal.some((m) => m.id === describer);
  return (
      <Section collapsible title="Images" description="How attached images are handled when the active model is not multimodal.">
        {multimodal.length === 0 && <p className="arc-empty">No multimodal models. Mark models as multimodal in Models.</p>}
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Describe images with</span>
            <span className="arc-row-meta">model used to describe images for non-VL models</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={describer} onChange={(e) => { const v = e.target.value; setDescriber(v); client.send({ type: SET, key: "arc.image.describeModel", value: v }); }}>
              <option value="none">none</option>
              {!known && <option value={describer}>{describer}</option>}
              {multimodal.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div></li>
        </ul>
      </Section>
  );
}
function SoundsSection({ client }: { client: RpcClient }) {
  const [attentionEnabled, setAttentionEnabled] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [attentionSound, setAttentionSound] = useState<"beep" | "system" | "pop">("beep");
  const [attentionVolume, setAttentionVolume] = useState(70);
  const [attentionCompletion, setAttentionCompletion] = useState(true);
  const [attentionApproval, setAttentionApproval] = useState(true);
  const [attentionError, setAttentionError] = useState(true);
  useEffect(() => {
    void client.request("arc.attention.enabled").then((v) => setAttentionEnabled(v === true));
    void client.request("arc.notifications.enabled").then((v) => setNotificationsEnabled(v !== false));
    void client.request("arc.attention.sound").then((v) => setAttentionSound(v === "system" || v === "pop" ? v : "beep"));
    void client.request("arc.attention.volume").then((v) => setAttentionVolume(typeof v === "number" ? v : 70));
    void client.request("arc.attention.completion").then((v) => setAttentionCompletion(v !== false));
    void client.request("arc.attention.approval").then((v) => setAttentionApproval(v !== false));
    void client.request("arc.attention.error").then((v) => setAttentionError(v !== false));
  }, [client]);
  return (
      <Section collapsible title="Sounds & Notifications" description="Attention sounds and OS notifications for agent activity.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">OS notifications</span>
            <span className="arc-row-meta">show system notifications on agent events</span>
            <span className="arc-spacer" />
            <Toggle checked={notificationsEnabled} onChange={(v) => { setNotificationsEnabled(v); client.send({ type: SET, key: "arc.notifications.enabled", value: v }); }} />
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Enabled</span>
            <span className="arc-row-meta">play sounds on agent events</span>
            <span className="arc-spacer" />
            <Toggle checked={attentionEnabled} onChange={(v) => { setAttentionEnabled(v); client.send({ type: SET, key: "arc.attention.enabled", value: v }); }} />
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Sound</span>
            <span className="arc-row-meta">style of the attention sound</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={attentionSound} onChange={(e) => { const v = e.target.value as typeof attentionSound; setAttentionSound(v); client.send({ type: SET, key: "arc.attention.sound", value: v }); }}>
              <option value="beep">beep</option>
              <option value="system">system default</option>
              <option value="pop">pop</option>
            </select>
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Volume</span>
            <span className="arc-row-meta">audio loudness (0-100)</span>
            <span className="arc-spacer" />
            <input className="arc-input arc-input-sm" type="number" min={0} max={100} step={5} value={attentionVolume} onChange={(e) => setAttentionVolume(Number(e.target.value))} onBlur={() => client.send({ type: SET, key: "arc.attention.volume", value: attentionVolume })} style={{ width: 64 }} />
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Task complete</span>
            <span className="arc-row-meta">when a turn finishes</span>
            <span className="arc-spacer" />
            <Toggle checked={attentionCompletion} onChange={(v) => { setAttentionCompletion(v); client.send({ type: SET, key: "arc.attention.completion", value: v }); }} />
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Approval needed</span>
            <span className="arc-row-meta">when Arc asks for permission</span>
            <span className="arc-spacer" />
            <Toggle checked={attentionApproval} onChange={(v) => { setAttentionApproval(v); client.send({ type: SET, key: "arc.attention.approval", value: v }); }} />
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Errors</span>
            <span className="arc-row-meta">when a turn fails</span>
            <span className="arc-spacer" />
            <Toggle checked={attentionError} onChange={(v) => { setAttentionError(v); client.send({ type: SET, key: "arc.attention.error", value: v }); }} />
          </div></li>
        </ul>
      </Section>
  );
}
function AgentTab({ client, models }: { client: RpcClient; models: ModelDescriptor[] }) {
  return (
    <>
      <SystemPromptsSection client={client} />
      <ModesSection client={client} models={models} />
      <SecuritySection client={client} />
      <CompactionSection client={client} />
      <MemoriesSection client={client} />
      <VerificationSection client={client} />
      <ReasoningSection client={client} />
    </>
  );
}
const GENERATE_HOOK_PROMPT = `You are helping me set up Arc hooks: short shell commands Arc runs automatically on agent lifecycle events. Work with me interactively.
What hooks can do (plain language):
- WHEN (event): session.start (a session begins), user.submit (I send a message), pre.tool / post.tool (around each tool call), pre.compact / post.compact (around context compaction), pre.handoff (before a model handoff), notification, stop (a task ends), subagent.spawn (a subagent starts), instructions.loaded (after instructions load).
- FILTER (optional, valid for pre.tool and post.tool): tool (one tool name such as shell.run), mode (one mode slug such as plan), tier (heavy, default, light, or free).
- RUN: command (required; runs through my platform shell), command_windows (optional Windows-only variant), timeout (seconds, default 10).
How we proceed:
1. Show me these options and ask what I want to automate, one focused question at a time.
2. Propose hooks with a one-line explanation each. Nothing destructive or side-effect heavy without asking me first. Keep commands short; quote paths; prefer matchers so hooks only fire when relevant.
3. On my approval, create each hook with the hooks.create tool, adjust with hooks.update or hooks.delete, and finish by showing the final list with hooks.list.`;
function ProxySection({ client }: { client: RpcClient }) {
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyProviderUrl, setProxyProviderUrl] = useState("");
  const [proxyWebUrl, setProxyWebUrl] = useState("");
  const [proxyShellUrl, setProxyShellUrl] = useState("");
  useEffect(() => {
    void client.request("arc.proxy.url").then((v) => setProxyUrl(typeof v === "string" ? v : ""));
    void client.request("arc.proxy.providerUrl").then((v) => setProxyProviderUrl(typeof v === "string" ? v : ""));
    void client.request("arc.proxy.webUrl").then((v) => setProxyWebUrl(typeof v === "string" ? v : ""));
    void client.request("arc.proxy.shellUrl").then((v) => setProxyShellUrl(typeof v === "string" ? v : ""));
  }, [client]);
  return (
      <Section collapsible title="Proxy" description="Optional HTTP/HTTPS proxy URLs. Category settings override the fallback.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">URL</span>
            <span className="arc-row-meta">fallback for all categories</span>
            <span className="arc-spacer" />
            <input className="arc-input arc-input-sm" type="text" placeholder="http://proxy:8080" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} onBlur={() => client.send({ type: SET, key: "arc.proxy.url", value: proxyUrl.trim() })} style={{ width: 280 }} />
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Provider</span>
            <span className="arc-row-meta">model provider API calls (OpenAI, Anthropic, Ollama, etc.)</span>
            <span className="arc-spacer" />
            <input className="arc-input arc-input-sm" type="text" placeholder="http://proxy:8080" value={proxyProviderUrl} onChange={(e) => setProxyProviderUrl(e.target.value)} onBlur={() => client.send({ type: SET, key: "arc.proxy.providerUrl", value: proxyProviderUrl.trim() })} style={{ width: 280 }} />
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Web</span>
            <span className="arc-row-meta">web.fetch and web.search tools</span>
            <span className="arc-spacer" />
            <input className="arc-input arc-input-sm" type="text" placeholder="http://proxy:8080" value={proxyWebUrl} onChange={(e) => setProxyWebUrl(e.target.value)} onBlur={() => client.send({ type: SET, key: "arc.proxy.webUrl", value: proxyWebUrl.trim() })} style={{ width: 280 }} />
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Shell</span>
            <span className="arc-row-meta">sets HTTP_PROXY / HTTPS_PROXY env vars on shell commands</span>
            <span className="arc-spacer" />
            <input className="arc-input arc-input-sm" type="text" placeholder="http://proxy:8080" value={proxyShellUrl} onChange={(e) => setProxyShellUrl(e.target.value)} onBlur={() => client.send({ type: SET, key: "arc.proxy.shellUrl", value: proxyShellUrl.trim() })} style={{ width: 280 }} />
          </div></li>
        </ul>
      </Section>
  );
}
function DiscordSection({ client }: { client: RpcClient }) {
  const [spoofRpc, setSpoofRpc] = useState(false);
  useEffect(() => {
    void client.request("arc.discord.spoofRpc").then((v) => setSpoofRpc(v === true));
  }, [client]);
  return (
      <Section collapsible title="Discord" description="Show the file the agent is editing as your Discord rich presence.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Spoof RPC</span>
            <span className="arc-row-meta">report agent file edits to Discord extensions</span>
            <span className="arc-spacer" />
            <Toggle checked={spoofRpc} onChange={(v) => { setSpoofRpc(v); client.send({ type: SET, key: "arc.discord.spoofRpc", value: v }); }} />
          </div></li>
        </ul>
      </Section>
  );
}
function ToolsTab({ client, toolCatalog, onUseChat }: { client: RpcClient; toolCatalog: ToolSpec[]; onUseChat?: (text: string) => void }) {
  return (
    <>
      <Section collapsible title="Tool calls">
        <ToolTogglesSection client={client} toolCatalog={toolCatalog} />
        <ShellSection client={client} />
        <SemanticSearchSection client={client} />
      </Section>
      <McpCategory client={client} />
      <HooksSection client={client} onUseChat={onUseChat} />
    </>
  );
}
function ToolTogglesSection({ client, toolCatalog }: { client: RpcClient; toolCatalog: ToolSpec[] }) {
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void client.request("arc.tools.disabled").then((v) => {
      const arr = Array.isArray(v) ? v as string[] : [];
      setDisabled(new Set(arr));
      setLoaded(true);
    });
  }, [client]);
  const saveDisabled = (next: Set<string>) => {
    setDisabled(next);
    client.send({ type: SET, key: "arc.tools.disabled", value: [...next] });
  };
  const resetToCurated = () => {
    const curated = new Set<string>([
      "shell.customRun", "shell.editCustomRun", "shell.runCustomRun",
      "browser.drag", "browser.evaluate", "browser.hover", "browser.domSnapshot", "browser.readPage", "browser.newTab", "browser.switchTab", "browser.listTabs",
      "git.stage", "git.commit", "git.push", "git.branch", "git.branchDiff", "git.changedFiles", "git.commitMessage", "git.diffStaged", "git.diffUnstaged", "git.pr",
      "notebook.read", "notebook.execute", "notebook.editCell", "notebook.addCell", "notebook.deleteCell",
      "test.run", "session.exportTrace",
    ]);
    saveDisabled(curated);
  };
  const categories: { category: string; tools: ToolSpec[] }[] = [];
  const byCat = new Map<string, ToolSpec[]>();
  for (const t of toolCatalog) {
    const list = byCat.get(t.category) ?? [];
    list.push(t);
    byCat.set(t.category, list);
  }
  const CAT_ORDER = ["File", "Shell", "Browser", "Web", "Git", "MCP", "Hooks", "Memory", "Notebook", "Rules", "Skills", "Code intelligence", "Session", "Communication", "Orchestration", "Wait"];
  for (const cat of CAT_ORDER) {
    const tools = byCat.get(cat);
    if (tools?.length) categories.push({ category: cat, tools });
  }
  for (const [cat, tools] of byCat) {
    if (!CAT_ORDER.includes(cat)) categories.push({ category: cat, tools });
  }
  const toggleCat = (tools: ToolSpec[]) => {
    const allOff = tools.every((t) => disabled.has(t.name));
    const next = new Set(disabled);
    if (allOff) for (const t of tools) next.delete(t.name);
    else for (const t of tools) next.add(t.name);
    saveDisabled(next);
  };
  const toggleTool = (name: string) => {
    const next = new Set(disabled);
    if (next.has(name)) next.delete(name); else next.add(name);
    saveDisabled(next);
  };
  const catCount = (tools: ToolSpec[]) => tools.filter((t) => !disabled.has(t.name)).length;
  const enabledCount = toolCatalog.filter((t) => !disabled.has(t.name)).length;
  return (
      <Section collapsible nested title="Enable/disable tool calls" titleExtra={loaded ? <button className="arc-iconbtn" onClick={resetToCurated} title="Reset to the default curated tool set" style={{ marginLeft: 4 }}><RefreshCw size={13} /></button> : undefined} description="Unselect tools the agent doesn't need." action={loaded ? (
        <span className="arc-row-meta">{enabledCount}/{toolCatalog.length} enabled</span>
      ) : undefined}>
        {!loaded ? <p className="arc-empty">Loading...</p> : toolCatalog.length === 0 ? <p className="arc-empty">No tools available.</p> : (
          <ul className="arc-rows">
            {categories.map(({ category, tools }) => {
              const on = catCount(tools);
              const allOn = on === tools.length;
              const someOn = on > 0 && !allOn;
              return (
                <li key={category} className="arc-row">
                  <div className="arc-row-main arc-tool-cat">
                    <button className="arc-iconbtn" onClick={() => { const next = new Set(expanded); if (next.has(category)) next.delete(category); else next.add(category); setExpanded(next); }} title={expanded.has(category) ? "Collapse" : "Expand"}>
                      {expanded.has(category) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <span className="arc-row-label">{category}</span>
                    <span className="arc-row-meta">{on}/{tools.length} enabled</span>
                    <span className="arc-spacer" />
                    <input
                      type="checkbox"
                      checked={allOn}
                      ref={(el) => { if (el) el.indeterminate = someOn; }}
                      onChange={() => toggleCat(tools)}
                      title={allOn ? "Disable all in category" : "Enable all in category"}
                    />
                  </div>
                  {expanded.has(category) && (
                    <ul className="arc-rows arc-tool-sublist">
                      {tools.map((t) => (
                        <li key={t.name} className="arc-row">
                          <div className="arc-row-main">
                            <span className="arc-row-label arc-monospace">{t.name}</span>
                            <span className="arc-row-meta">{t.description}</span>
                            <span className="arc-spacer" />
                            <input
                              type="checkbox"
                              checked={!disabled.has(t.name)}
                              onChange={() => toggleTool(t.name)}
                              title={disabled.has(t.name) ? `Enable ${t.name}` : `Disable ${t.name}`}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
  );
}
function ShellSection({ client }: { client: RpcClient }) {
  const [sandboxProfile, setSandboxProfile] = useState<"off" | "read-only" | "workspace" | "system">("off");
  const [terminal, setTerminal] = useState("default");
  const [surface, setSurface] = useState<"arc-handled" | "integrated">("arc-handled");
  const [terminals, setTerminals] = useState<{ id: string; name: string }[]>([]);
  const [isWindows, setIsWindows] = useState(false);
  const preSandboxTerminal = useRef<string | undefined>(undefined);
  useEffect(() => {
    void client.request("arc.sandbox.profile").then((v) => setSandboxProfile(v === "read-only" || v === "workspace" || v === "system" ? v : "off"));
    void client.request("arc.shell.terminal").then((v) => { if (typeof v === "string" && v) setTerminal(v); });
    void client.request("arc.shell.surface").then((v) => setSurface(v === "integrated" ? "integrated" : "arc-handled"));
    void client.request("arc.env.platform").then((v) => { if (v === "win32") setIsWindows(true); });
    void client.request("arc.shell.detectedTerminals").then((v) => {
      if (!Array.isArray(v)) return;
      setTerminals(v.filter((t): t is { id: string; name: string } => !!t && typeof (t as { id?: unknown }).id === "string" && typeof (t as { name?: unknown }).name === "string"));
    });
  }, [client]);
  const sandboxTerminal = isWindows && sandboxProfile !== "off"
    ? (["pwsh", "powershell", "cmd"].map((id) => terminals.find((t) => t.id === id)).find(Boolean))
    : undefined;
  useEffect(() => {
    if (sandboxTerminal && terminal !== sandboxTerminal.id) {
      if (preSandboxTerminal.current === undefined) preSandboxTerminal.current = terminal;
      setTerminal(sandboxTerminal.id);
      client.send({ type: SET, key: "arc.shell.terminal", value: sandboxTerminal.id });
    } else if (!sandboxTerminal && preSandboxTerminal.current !== undefined) {
      const restore = preSandboxTerminal.current;
      preSandboxTerminal.current = undefined;
      setTerminal(restore);
      client.send({ type: SET, key: "arc.shell.terminal", value: restore });
    }
  }, [client, sandboxTerminal, terminal]);
  const knownTerminal = terminal === "default" || terminals.some((t) => t.id === terminal);
  return (
      <Section collapsible nested title="Shell" description="Approvals are in the chat top bar.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Terminal</span>
            <span className="arc-row-meta">the shell that interprets shell tool commands</span>
            {sandboxTerminal && (
              <span className="arc-info-icon" title={`Sandboxing on Windows is only supported by ${sandboxTerminal.name}`}>
                <Info size={13} />
              </span>
            )}
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={sandboxTerminal ? sandboxTerminal.id : terminal} disabled={!!sandboxTerminal} onChange={(e) => { const v = e.target.value; setTerminal(v); client.send({ type: SET, key: "arc.shell.terminal", value: v }); }}>
              <option value="default">default</option>
              {!knownTerminal && <option value={terminal}>{terminal}</option>}
              {terminals.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Run commands</span>
            <span className="arc-row-meta">where shell tool commands execute</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={surface} onChange={(e) => { const v = e.target.value as typeof surface; setSurface(v); client.send({ type: SET, key: "arc.shell.surface", value: v }); }}>
              <option value="arc-handled">arc-handled</option>
              <option value="integrated">integrated</option>
            </select>
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Sandbox</span>
            <span className="arc-row-meta">native OS sandboxing for Arc-handled shell commands (fails closed when unavailable)</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={sandboxProfile} onChange={(e) => { const v = e.target.value as typeof sandboxProfile; setSandboxProfile(v); client.send({ type: SET, key: "arc.sandbox.profile", value: v }); }}>
              <option value="off">off</option>
              <option value="read-only">read-only</option>
              <option value="workspace">workspace</option>
              <option value="system">system</option>
            </select>
          </div></li>
        </ul>
      </Section>
  );
}
function SecuritySection({ client }: { client: RpcClient }) {
  const [injectionPolicy, setInjectionPolicy] = useState<"off" | "balanced" | "strict">("balanced");
  useEffect(() => {
    void client.request("arc.security.promptInjection").then((v) => setInjectionPolicy(v === "off" || v === "strict" ? v : "balanced"));
  }, [client]);
  return (
      <Section collapsible title="Security" description="Protection against prompt injection from untrusted content.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Prompt-injection protection</span>
            <span className="arc-row-meta">scans tool output, memory writes, skills, and repo instructions; quarantines high-confidence injections before they reach the model</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={injectionPolicy} onChange={(e) => { const v = e.target.value as typeof injectionPolicy; setInjectionPolicy(v); client.send({ type: SET, key: "arc.security.promptInjection", value: v }); }}>
              <option value="off">off (no scanning)</option>
              <option value="balanced">balanced</option>
              <option value="strict">strict</option>
            </select>
          </div></li>
        </ul>
      </Section>
  );
}
function SemanticSearchSection({ client }: { client: RpcClient }) {
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [searchBackend, setSearchBackend] = useState<"hash-based" | "semantic">("hash-based");
  const [searchProvider, setSearchProvider] = useState<"ollama" | "openrouter">("ollama");
  const [searchModelTier, setSearchModelTier] = useState<"low" | "mid" | "high">("low");
  const [openrouterModel, setOpenrouterModel] = useState("");
  const [orModels, setOrModels] = useState<{ slug: string; name: string; contextLength: number }[] | null>(null);
  const [searchChunks, setSearchChunks] = useState(0);
  const [autoReindex, setAutoReindex] = useState<"off" | "hourly" | "daily">("off");
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState<{ scanned: number; indexed: number; chunks: number; errors: number }>({ scanned: 0, indexed: 0, chunks: 0, errors: 0 });
  useEffect(() => {
    void client.request("arc.search.enabled").then((v) => setSearchEnabled(v !== false));
    void client.request("arc.search.backend").then((v) => setSearchBackend((v === "semantic" ? "semantic" : "hash-based")));
    void client.request("arc.search.provider").then((v) => setSearchProvider(v === "openrouter" ? "openrouter" : "ollama"));
    void client.request("arc.search.modelTier").then((v) => {
      if (v === "mid") setSearchModelTier("mid");
      else if (v === "high") setSearchModelTier("high");
      else setSearchModelTier("low");
    });
    void client.request("arc.search.openrouterModel").then((v) => setOpenrouterModel(typeof v === "string" ? v : ""));
    void client.request("arc.search.chunkCount").then((v) => setSearchChunks(typeof v === "number" ? v : 0));
    void client.request("arc.search.autoReindex").then((v) => setAutoReindex(v === "hourly" || v === "daily" ? v : "off"));
    const off = client.on((e: any) => {
      if (e.type === "search/indexProgress") {
        setIndexing(true);
        setProgress({ scanned: e.filesScanned, indexed: e.filesIndexed, chunks: e.chunksEmbedded, errors: e.errors });
        setSearchChunks(e.chunksEmbedded);
        if (e.filesScanned === e.filesIndexed) setIndexing(false);
      }
    });
    return off;
  }, [client]);
  useEffect(() => {
    if (searchBackend !== "semantic" || searchProvider !== "openrouter" || orModels) return;
    void client.request("arc.search.openrouterModels").then((v) => setOrModels(Array.isArray(v) ? v : []));
  }, [client, searchBackend, searchProvider, orModels]);
  const pct = progress.scanned > 0 ? (progress.indexed / progress.scanned) * 100 : 0;
  return (
    <Section collapsible nested title="Semantic search" description="Indexes the workspace with an embedding model for natural-language queries.">
      <ul className="arc-rows">
        <li className="arc-row"><div className="arc-row-main">
          <span className="arc-row-label">Enable</span>
            <span className="arc-row-meta">index the workspace on activation and keep it in sync</span>
          <span className="arc-spacer" />
          <Toggle checked={searchEnabled} onChange={(v) => { setSearchEnabled(v); client.send({ type: SET, key: "arc.search.enabled", value: v }); }} />
        </div></li>
        <li className="arc-row"><div className="arc-row-main">
          <span className="arc-row-label">Backend</span>
          <span className="arc-spacer" />
          <select className="arc-input arc-input-sm" value={searchBackend} onChange={(e) => { const v = e.target.value as typeof searchBackend; setSearchBackend(v); client.send({ type: SET, key: "arc.search.backend", value: v }); }}>
            <option value="hash-based">hash-based</option>
            <option value="semantic">semantic</option>
          </select>
        </div></li>
        {searchBackend === "semantic" && (
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Model provider</span>
            <span className="arc-row-meta">where the embedding model runs</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={searchProvider} onChange={(e) => { const v = e.target.value as typeof searchProvider; setSearchProvider(v); client.send({ type: SET, key: "arc.search.provider", value: v }); }}>
              <option value="ollama">ollama</option>
              <option value="openrouter">openrouter</option>
            </select>
          </div></li>
        )}
        {searchBackend === "semantic" && searchProvider === "ollama" && (
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Model</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={searchModelTier} onChange={(e) => { const v = e.target.value as typeof searchModelTier; setSearchModelTier(v); client.send({ type: SET, key: "arc.search.modelTier", value: v }); }}>
              <option value="low">nomic-embed-text (768d)</option>
              <option value="mid">qwen3-embedding:0.6b (1024d)</option>
              <option value="high">qwen3-embedding:8b (4096d)</option>
            </select>
          </div></li>
        )}
        {searchBackend === "semantic" && searchProvider === "openrouter" && (
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Model</span>
            <span className="arc-spacer" />
            <select
              className="arc-input arc-input-sm"
              value={openrouterModel}
              onChange={(e) => { const v = e.target.value; setOpenrouterModel(v); if (v) client.send({ type: SET, key: "arc.search.openrouterModel", value: v }); }}
            >
              {!openrouterModel && <option value="">select a model...</option>}
              {openrouterModel && !orModels?.some((m) => m.slug === openrouterModel) && <option value={openrouterModel}>{openrouterModel}</option>}
              {(orModels ?? []).map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
              {orModels === null && <option value="" disabled>loading...</option>}
              {orModels !== null && orModels.length === 0 && <option value="" disabled>no embedding models found</option>}
            </select>
          </div></li>
        )}
        <li className="arc-row"><div className="arc-row-main">
          <span className="arc-row-label">Automatic reindexing</span>
            <span className="arc-row-meta">periodically rebuild the full index, in addition to live file watching</span>
          <span className="arc-spacer" />
          <select className="arc-input arc-input-sm" value={autoReindex} onChange={(e) => { const v = e.target.value as typeof autoReindex; setAutoReindex(v); client.send({ type: SET, key: "arc.search.autoReindex", value: v }); }}>
            <option value="off">off</option>
            <option value="hourly">hourly</option>
            <option value="daily">daily</option>
          </select>
        </div></li>
      </ul>
      <div className="arc-progress-wrap">
        <button className="arc-chip" onClick={() => { setIndexing(true); setProgress({ scanned: 0, indexed: 0, chunks: 0, errors: 0 }); client.send({ type: "search/reindex" }); }} disabled={indexing}>Reindex {searchChunks > 0 ? `(${searchChunks} chunks)` : ""}</button>
        {indexing && (
          <div style={{ marginTop: 8 }}>
            <div className="arc-progress-bar"><div className="arc-progress-fill" style={{ width: `${pct}%` }} /></div>
            <p className="arc-progress-text">{progress.indexed} files · {progress.chunks} chunks{progress.errors > 0 ? ` · ${progress.errors} errors` : ""}</p>
          </div>
        )}
      </div>
    </Section>
  );
}
interface CustomModeEntry { slug: string; roleDefinition: string; allowedTools: string[]; writeGlob?: string; description: string; whenToUse: string; model?: string; source: "builtin" | "workspace" | "global" }
function emptyModeEntry(): CustomModeEntry {
  return { slug: "", roleDefinition: "", allowedTools: [], writeGlob: "", description: "", whenToUse: "", model: "", source: "workspace" };
}
function ModesSection({ client, models }: { client: RpcClient; models: ModelDescriptor[] }) {
  const [modes, setModes] = useState<CustomModeEntry[]>([]);
  const [editing, setEditing] = useState<CustomModeEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [toolsText, setToolsText] = useState("");
  const [error, setError] = useState("");
  const savedSlugRef = useRef<string | null>(null);
  useEffect(() => {
    const off = client.on((e: any) => {
      if (e.type === "mode/list") {
        setModes(e.modes);
        if (savedSlugRef.current && e.modes?.some((m: any) => m.slug === savedSlugRef.current)) {
          savedSlugRef.current = null;
          setSaving(false);
          setEditing(null);
        }
      }
      if (e.type === "error" && typeof e.message === "string" && e.message.startsWith("Failed to save mode")) {
        setSaving(false);
        setError(e.message);
      }
    });
    client.send({ type: "mode/list" });
    return off;
  }, [client]);
  const startNew = () => { setEditing(emptyModeEntry()); setToolsText(""); setError(""); };
  const startEdit = (m: CustomModeEntry) => { setEditing(m); setToolsText(m.allowedTools.join(", ")); setError(""); };
  const cancel = () => { setEditing(null); setError(""); setSaving(false); };
  const save = () => {
    if (!editing) return;
    const slug = editing.slug.trim();
    const allowedTools = toolsText.split(",").map((t) => t.trim()).filter(Boolean);
    if (!slug || !editing.roleDefinition.trim() || !allowedTools.length) { setError("Name, prompt, and at least one tool are required."); return; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { setError("Mode slug must be lowercase alphanumeric with hyphens only."); return; }
    savedSlugRef.current = slug;
    setSaving(true);
    setError("");
    client.send({
      type: "mode/save",
      mode: { slug, roleDefinition: editing.roleDefinition, allowedTools, writeGlob: editing.writeGlob || undefined, description: editing.description, whenToUse: editing.whenToUse, model: editing.model || undefined },
      scope: "workspace",
    });
  };
  const remove = (slug: string) => client.send({ type: "mode/delete", slug, scope: "workspace" });
  return (
    <Section collapsible title="Modes" description="Custom agent modes with their own prompt, tools, write scope, and model." action={!editing && <button className="arc-btn" onClick={startNew}><Plus size={14} /> New mode</button>}>
      {!editing && (
        <ul className="arc-rows">
          {modes.map((m) => (
            <li key={m.slug} className="arc-row"><div className="arc-row-main">
              <span className="arc-row-label">{m.slug}</span>
              <span className="arc-row-meta">{m.description || m.whenToUse || "-"} · {m.source}</span>
              <span className="arc-spacer" />
              <button className="arc-iconbtn" onClick={() => startEdit(m)} title="Edit"><Pencil size={14} /></button>
              <button className="arc-iconbtn" onClick={() => remove(m.slug)} title={m.source === "builtin" ? "Reset to default" : "Delete"}><Trash2 size={14} /></button>
            </div></li>
          ))}
        </ul>
      )}
      {editing && (
        <div className="arc-form">
          {error && <p className="arc-section-desc" style={{ color: "var(--vscode-errorForeground)" }}>{error}</p>}
          <input className="arc-input" placeholder="name (slug, e.g. reviewer)" value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} />
          <textarea className="arc-input" style={{ width: "100%", resize: "vertical" }} rows={6} placeholder="prompt (system role definition)" value={editing.roleDefinition} onChange={(e) => setEditing({ ...editing, roleDefinition: e.target.value })} />
          <input className="arc-input" placeholder="tools (comma-separated, e.g. file.read, file.grep, lsp.problems)" value={toolsText} onChange={(e) => setToolsText(e.target.value)} />
          <div className="arc-form-row">
            <input className="arc-input" placeholder="write glob (optional, e.g. **/*.ts)" value={editing.writeGlob ?? ""} onChange={(e) => setEditing({ ...editing, writeGlob: e.target.value })} />
            <select className="arc-input" value={editing.model ?? ""} onChange={(e) => setEditing({ ...editing, model: e.target.value })}>
              <option value="">(use current model)</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <input className="arc-input" placeholder="description" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          <input className="arc-input" placeholder="when to use" value={editing.whenToUse} onChange={(e) => setEditing({ ...editing, whenToUse: e.target.value })} />
          <div className="arc-form-actions">
            <button className="arc-btn" onClick={save} disabled={saving}>{saving ? "Saving..." : <><Check size={14} /> Save</>}</button>
            <button className="arc-btn-ghost" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
    </Section>
  );
}
function SystemPromptsSection({ client }: { client: RpcClient }) {
  const PROMPTS = [
    { name: "Global default", meta: "built into the extension", action: null as React.ReactNode },
    { name: "~/.arc/workspaces/*/prompt.md", meta: "workspace prompt", action: <button className="arc-btn-ghost" onClick={() => client.send({ type: "ui/openPrompt" })}>Open</button> },
    { name: "AGENTS.md / CLAUDE.md · ~/.arc/workspaces/*/instructions.md", meta: "auto-loaded rules files", action: null },
    { name: "~/.arc/workspaces/*/prompts/*.md", meta: "per-mode prompt overrides", action: null },
  ];
  return (
      <Section collapsible title="System prompts" description="Higher-precedence content overrides lower. Supports {{workspace}}, {{os}}, {{date}}.">
        <ul className="arc-rows">
          {PROMPTS.map((r) => (
            <li key={r.name} className="arc-row">
              <div className="arc-row-main">
                <span className="arc-row-label">{r.name}</span>
                <span className="arc-row-meta">{r.meta}</span>
                <span className="arc-spacer" />
                {r.action}
              </div>
            </li>
          ))}
        </ul>
      </Section>
  );
}
function MemoriesSection({ client }: { client: RpcClient }) {
  const [memories, setMemories] = useState<{ index: number; category: string; content: string; createdAt: string }[]>([]);
  const [memLoading, setMemLoading] = useState(true);
  useEffect(() => {
    const off = client.on((e: any) => {
      if (e.type === "memory/list") { setMemories(e.memories); setMemLoading(false); }
    });
    client.send({ type: "memory/list" });
    return off;
  }, [client]);
  return (
      <Section collapsible title="Memories" description="Persistent facts, preferences, and gotchas saved across sessions.">
        {memLoading ? <p className="arc-empty">Loading...</p> : memories.length === 0 ? <p className="arc-empty">No memories stored.</p> : (
          <ul className="arc-rows">
            {memories.map((m) => (
              <li key={m.index} className="arc-row">
                <div className="arc-row-main">
                  <span className="arc-row-label">[{m.category}] {m.content}</span>
                  <span className="arc-row-meta">{m.createdAt}</span>
                  <span className="arc-spacer" />
                  <button className="arc-iconbtn" onClick={() => client.send({ type: "memory/delete", index: m.index })} title="Delete"><Trash2 size={14} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
  );
}
function HooksSection({ client, onUseChat }: { client: RpcClient; onUseChat?: (text: string) => void }) {
  const [hooks, setHooks] = useState<{ event: string; command?: string; command_windows?: string; timeout_sec?: number; matchers?: { tool?: string; mode?: string; modelTier?: string } }[]>([]);
  useEffect(() => {
    const off = client.on((e: any) => {
      if (e.type === "hooks/list") setHooks(Array.isArray(e.hooks) ? e.hooks : []);
    });
    client.send({ type: "hooks/list" });
    return off;
  }, [client]);
  return (
      <Section collapsible title="Hooks" description="Custom scripts on lifecycle events. Configured in ~/.arc/hooks.json or the centralized workspace hooks file.">
        {hooks.length === 0 && (
          <div className="arc-hook-empty">
            <p className="arc-empty">No hooks configured.</p>
            <p className="arc-hint-text">Add hooks to <code>~/.arc/hooks.json</code> for events like <strong>session.start</strong>, <strong>pre.tool</strong>, <strong>post.tool</strong>, or <strong>stop</strong>.</p>
          </div>
        )}
        <div className="arc-hook-panel">
          {hooks.map((h, i) => (
            <div key={i} className="arc-hook-item">
              <div className="arc-hook-item-head">
                <span className="arc-hook-item-event">{h.event}</span>
                {[h.matchers?.tool, h.matchers?.mode, h.matchers?.modelTier].filter(Boolean).length > 0 && (
                  <span className="arc-row-meta">matcher: {[h.matchers?.tool, h.matchers?.mode, h.matchers?.modelTier].filter(Boolean).join(", ")}</span>
                )}
              </div>
              <div className="arc-hook-item-cmd">{h.command}</div>
            </div>
          ))}
        </div>
        <div className="arc-hook-editor-actions">
          {onUseChat && (
            <button className="arc-btn-ghost" title="Opens the chat with a ready-to-send prompt" onClick={() => onUseChat(GENERATE_HOOK_PROMPT)}>
              Generate with Arc
            </button>
          )}
        </div>
      </Section>
  );
}
function WorkspaceTab({ client, models }: { client: RpcClient; models: ModelDescriptor[] }) {
  const [prideLogo, setPrideLogo] = useState<"always" | "june" | "never">("june");
  const [toolTree, setToolTree] = useState<"auto" | "collapsed">("auto");
  const [groupSummary, setGroupSummary] = useState<"count" | "tools" | "ai">("count");
  const [autoOpenDiff, setAutoOpenDiff] = useState(true);
  const [fontFamily, setFontFamily] = useState<string>("atkinson");
  const [monoFontFamily, setMonoFontFamily] = useState<string>("ibm-plex-mono");
  const [customFontFamily, setCustomFontFamily] = useState<string>("");
  const [customMonoFontFamily, setCustomMonoFontFamily] = useState<string>("");
  const flushTimers = useRef<{ ui?: ReturnType<typeof setTimeout>; mono?: ReturnType<typeof setTimeout> }>({});
  useEffect(() => () => {
    if (flushTimers.current.ui) clearTimeout(flushTimers.current.ui);
    if (flushTimers.current.mono) clearTimeout(flushTimers.current.mono);
  }, []);
  const queueFlush = (which: "ui" | "mono", value: string) => {
    const t = flushTimers.current;
    if (which === "ui") {
      if (t.ui) clearTimeout(t.ui);
      t.ui = setTimeout(() => client.send({ type: SET, key: "arc.appearance.customFontFamily", value: value.trim() }), 800);
    } else {
      if (t.mono) clearTimeout(t.mono);
      t.mono = setTimeout(() => client.send({ type: SET, key: "arc.appearance.customMonoFontFamily", value: value.trim() }), 800);
    }
  };
  useEffect(() => {
    void client.request("arc.appearance.prideLogo").then((v) => setPrideLogo(v === "always" || v === "never" ? v as typeof prideLogo : "june"));
    void client.request("arc.appearance.toolTree").then((v) => setToolTree(v === "auto" ? "auto" : "collapsed"));
    void client.request("arc.appearance.toolGroupSummary").then((v) => setGroupSummary(v === "tools" ? "tools" : v === "ai" ? "ai" : "count"));
    void client.request("arc.diffView.autoOpen").then((v) => setAutoOpenDiff(v !== false));
    void client.request("arc.appearance.fontFamily").then((v) => setFontFamily(typeof v === "string" ? v : "atkinson"));
    void client.request("arc.appearance.monoFontFamily").then((v) => setMonoFontFamily(typeof v === "string" ? v : "ibm-plex-mono"));
    void client.request("arc.appearance.customFontFamily").then((v) => setCustomFontFamily(typeof v === "string" ? v : ""));
    void client.request("arc.appearance.customMonoFontFamily").then((v) => setCustomMonoFontFamily(typeof v === "string" ? v : ""));
  }, [client]);
  return (
    <>
      <Section collapsible title="Appearance" description="Visual preferences for the chat interface.">
        <ul className="arc-rows">
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Pride logo</span>
            <span className="arc-row-meta">when to show the pride variant in the welcome text and sidebar</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={prideLogo} onChange={(e) => { const v = e.target.value as typeof prideLogo; setPrideLogo(v); client.send({ type: SET, key: "arc.appearance.prideLogo", value: v }); }}>
              <option value="june">june</option>
              <option value="always">always</option>
              <option value="never">never</option>
            </select>
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Tool call tree</span>
            <span className="arc-row-meta">how tool call trees expand and collapse</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={toolTree} onChange={(e) => { const v = e.target.value as typeof toolTree; setToolTree(v); client.send({ type: SET, key: "arc.appearance.toolTree", value: v }); }}>
              <option value="auto">auto</option>
              <option value="collapsed">collapsed</option>
            </select>
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Tool run summary</span>
            <span className="arc-row-meta">how a finished chain of tool calls is titled in the chat</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={groupSummary} onChange={(e) => { const v = e.target.value as typeof groupSummary; setGroupSummary(v); client.send({ type: SET, key: "arc.appearance.toolGroupSummary", value: v }); }}>
              <option value="count">count</option>
              <option value="tools">top tools</option>
              <option value="ai">summary</option>
            </select>
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Auto-open diff</span>
            <span className="arc-row-meta">stream file-edit diffs into the main-window diff editor as they're generated</span>
            <span className="arc-spacer" />
            <Toggle checked={autoOpenDiff} onChange={(v) => { setAutoOpenDiff(v); client.send({ type: SET, key: "arc.diffView.autoOpen", value: v }); }} />
          </div></li>
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">UI font</span>
            <span className="arc-row-meta">font for the chat interface (self-hosted)</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={fontFamily} onChange={(e) => { const v = e.target.value; setFontFamily(v); client.send({ type: SET, key: "arc.appearance.fontFamily", value: v }); applyFonts(v, customFontFamily, monoFontFamily, customMonoFontFamily); }}>
              {UI_FONT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              <option value="custom">Custom...</option>
            </select>
          </div></li>
          {fontFamily === "custom" && (
            <li className="arc-row"><div className="arc-row-main">
              <span className="arc-row-label">Custom UI font</span>
              <span className="arc-row-meta">font family name (system or your own self-hosted @font-face)</span>
              <span className="arc-spacer" />
              <input className="arc-input arc-input-sm" type="text" placeholder="My Font" value={customFontFamily} onChange={(e) => { const v = e.target.value; setCustomFontFamily(v); applyFonts(fontFamily, v, monoFontFamily, customMonoFontFamily); queueFlush("ui", v); }} onBlur={() => client.send({ type: SET, key: "arc.appearance.customFontFamily", value: customFontFamily.trim() })} style={{ width: 200 }} />
            </div></li>
          )}
          <li className="arc-row"><div className="arc-row-main">
            <span className="arc-row-label">Mono font</span>
            <span className="arc-row-meta">monospace font for code blocks and tool output (self-hosted)</span>
            <span className="arc-spacer" />
            <select className="arc-input arc-input-sm" value={monoFontFamily} onChange={(e) => { const v = e.target.value; setMonoFontFamily(v); client.send({ type: SET, key: "arc.appearance.monoFontFamily", value: v }); applyFonts(fontFamily, customFontFamily, v, customMonoFontFamily); }}>
              {MONO_FONT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              <option value="custom">Custom...</option>
            </select>
          </div></li>
          {monoFontFamily === "custom" && (
            <li className="arc-row"><div className="arc-row-main">
              <span className="arc-row-label">Custom mono font</span>
              <span className="arc-row-meta">font family name (system or your own self-hosted @font-face)</span>
              <span className="arc-spacer" />
              <input className="arc-input arc-input-sm" type="text" placeholder="My Mono" value={customMonoFontFamily} onChange={(e) => { const v = e.target.value; setCustomMonoFontFamily(v); applyFonts(fontFamily, customFontFamily, monoFontFamily, v); queueFlush("mono", v); }} onBlur={() => client.send({ type: SET, key: "arc.appearance.customMonoFontFamily", value: customMonoFontFamily.trim() })} style={{ width: 200 }} />
            </div></li>
          )}
        </ul>
      </Section>
      <ComposerSection client={client} />
      <ProxySection client={client} />
      <TitlesSection client={client} models={models} />
      <ImagesSection client={client} models={models} />
      <SoundsSection client={client} />
      <DiscordSection client={client} />
    </>
  );
}
function AboutSection({ logoTextUri, version, client }: { logoTextUri: string; version: string; client: RpcClient }) {
  return (
    <div className="arc-about" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "clamp(8px, 1.5vw, 16px)", padding: "clamp(24px, 4vw, 56px) 0" }}>
      <img className="arc-about-logo-text" src={logoTextUri} alt="Arc" style={{ width: "100%", maxWidth: 560, height: "auto" }} />
      <p className="arc-about-version" style={{ margin: 0, fontSize: "clamp(12px, 1.5vw, 17px)", fontWeight: 600 }}>v{version} <a href="#" onClick={(e) => { e.preventDefault(); client.send({ type: "ui/openExternal", url: `https://khrotu.org/blogs/arc-v${version.replace(/\./g, "-")}-release` }); }} style={{ fontWeight: 400, fontSize: "clamp(10px, 1.1vw, 13px)" }}>(Update Log)</a></p>
      <p className="arc-about-alpha" style={{ display: "flex", gap: "clamp(4px, 0.8vw, 10px)", alignItems: "flex-start", fontSize: "clamp(11px, 1.2vw, 13px)", color: "var(--vscode-descriptionForeground)", margin: 0, maxWidth: 560 }}>
        <Info size={16} style={{ flexShrink: 0, marginTop: 1, width: "clamp(12px, 1.6vw, 18px)", height: "clamp(12px, 1.6vw, 18px)" }} />
        <span>This extension is in <strong style={{ color: "var(--vscode-foreground)" }}>beta testing</strong>. Features, APIs, and configuration formats may change without notice.</span>
      </p>
      <div style={{ width: "100%", maxWidth: 560, marginTop: "clamp(16px, 3vw, 32px)" }}>
        <ImportSection client={client} />
      </div>
    </div>
  );
}
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`arc-toggle ${checked ? "is-on" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span className="arc-toggle-knob" />
    </button>
  );
}
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) return true;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}
function searchCatalog(entries: ModelCatalogEntry[], query: string): ModelCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const variants = [q, q.replace(/[\s_]+/g, "-"), q.replace(/[\s_-]+/g, "")];
  const out: ModelCatalogEntry[] = [];
  for (const e of entries) {
    const hit = variants.some((v) => fuzzyMatch(v, e.label)) || e.providers.some((p) => variants.some((v) => fuzzyMatch(v, p.slug)));
    if (hit) out.push(e);
  }
  return out;
}