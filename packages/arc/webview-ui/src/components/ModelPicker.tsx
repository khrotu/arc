import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Search, ChevronDown } from "./icons";
import ModelIcon from "./ModelIcon";
import type { ModelDescriptor, ModelTier } from "@arc/host/protocol";
export const AUTO_MODEL_ID = "auto";
const TIER_ORDER: Record<ModelTier, number> = { heavy: 0, default: 1, light: 2, free: 3 };
const TIER_LABELS: Record<ModelTier, string> = { heavy: "heavy", default: "default", light: "light", free: "free" };
type Props = {
  models: ModelDescriptor[];
  currentModelId: string;
  onSelect: (modelId: string) => void;
  compact?: boolean;
};
export default function ModelPicker({ models, currentModelId, onSelect, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoSelected = currentModelId === AUTO_MODEL_ID;
  const sorted = useMemo(
    () => [...models].sort((a, b) => (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99)),
    [models],
  );
  const filtered = useMemo(() => {
    if (!query.trim()) return sorted;
    const q = query.toLowerCase();
    return sorted.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.tier.toLowerCase().includes(q),
    );
  }, [sorted, query]);
  const current = models.find((m) => m.id === currentModelId);
  const reset = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIdx(0);
  }, []);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        reset();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, reset]);
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);
  useEffect(() => {
    if (!open || !listRef.current) return;
    const focusable = listRef.current.querySelectorAll<HTMLElement>(".arc-model-dropdown-item");
    focusable[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);
  const showAuto = !query.trim() || query.toLowerCase().includes("auto");
  const autoActiveIdx = showAuto ? 0 : -1;
  const modelStartIdx = showAuto ? 1 : 0;
  const handleKey = (e: React.KeyboardEvent) => {
    if (!open) return;
    const total = filtered.length + (showAuto ? 1 : 0);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % Math.max(1, total));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + total) % Math.max(1, total));
        break;
      case "Enter":
        e.preventDefault();
        if (activeIdx === autoActiveIdx) {
          onSelect(AUTO_MODEL_ID);
          reset();
        } else if (filtered[activeIdx - modelStartIdx]) {
          onSelect(filtered[activeIdx - modelStartIdx].id);
          reset();
        }
        break;
      case "Escape":
        e.preventDefault();
        reset();
        break;
    }
  };
  const selectModel = (id: string) => {
    onSelect(id);
    reset();
  };
  const triggerTitle = autoSelected
    ? "Auto · route by difficulty"
    : current ? `${current.label} · ${TIER_LABELS[current.tier]}` : "Select model";
  if (models.length === 0) {
    return (
      <div className="arc-model">
        <button className="arc-model-trigger arc-model-trigger-empty">
          <span className="arc-model-trigger-label">no models</span>
        </button>
      </div>
    );
  }
  return (
    <div className="arc-model" ref={containerRef} onKeyDown={handleKey}>
      {compact ? (
        <button
          className={`arc-model-trigger arc-model-trigger-compact ${open ? "is-open" : ""}`}
          onClick={() => setOpen((o) => !o)}
          title={triggerTitle}
        >
          {autoSelected ? <ModelIcon modelId={AUTO_MODEL_ID} size={15} /> : <ModelIcon modelId={currentModelId} size={15} />}
        </button>
      ) : (
        <button
          className={`arc-model-trigger ${open ? "is-open" : ""}`}
          onClick={() => setOpen((o) => !o)}
          title={triggerTitle}
        >
          <span className="arc-model-trigger-label">
            {autoSelected ? "Auto" : current ? current.label : "Select model"}
          </span>
          <ChevronDown size={12} className={`arc-model-trigger-chevron ${open ? "is-open" : ""}`} />
        </button>
      )}
      {open && (
        <div className="arc-model-dropdown">
          <div className="arc-model-dropdown-search">
            <Search size={13} className="arc-model-dropdown-search-icon" />
            <input
              ref={inputRef}
              className="arc-model-dropdown-search-input"
              placeholder="Search models..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKey}
            />
          </div>
          <div className="arc-model-dropdown-list" ref={listRef} onMouseLeave={() => setActiveIdx(-1)}>
            {showAuto && (
              <button
                className={`arc-model-dropdown-item ${autoSelected ? "is-selected" : ""} ${activeIdx === 0 ? "is-active" : ""}`}
                onClick={() => selectModel(AUTO_MODEL_ID)}
                onMouseEnter={() => setActiveIdx(0)}
              >
                <span className="arc-model-dropdown-item-label">Auto</span>
              </button>
            )}
            {showAuto && <div className="arc-mode-dropdown-sep" />}
            {filtered.length === 0 ? (
              <div className="arc-model-dropdown-empty">No models match "{query}"</div>
            ) : (
              filtered.map((m, i) => {
                const idx = modelStartIdx + i;
                return (
                  <button
                    key={m.id}
                    className={`arc-model-dropdown-item ${m.id === currentModelId ? "is-selected" : ""} ${idx === activeIdx ? "is-active" : ""}`}
                    onClick={() => selectModel(m.id)}
                    onMouseEnter={() => setActiveIdx(idx)}
                  >
                    <span className="arc-model-dropdown-item-label">{m.label}</span>
                    <span className="arc-model-dropdown-item-tier">
                      {TIER_LABELS[m.tier]}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}