import { useState, useRef, useEffect } from "react";
import { ChevronDown, Wrench, FileSearch, BugPlay, SearchCheck, Layers } from "./icons";
type ModeDef = { slug: string; description: string; source?: string };
const MODE_ICONS: Record<string, React.ReactNode> = {
  plan: <FileSearch size={12} />,
  code: <Wrench size={12} />,
  debug: <BugPlay size={12} />,
  audit: <SearchCheck size={12} />,
};
const CUSTOM_ICON = <Layers size={12} />;
const MODE_LABELS: Record<string, string> = {
  plan: "Plan",
  code: "Code",
  debug: "Debug",
  audit: "Audit",
};
type Props = {
  modes: ModeDef[];
  currentMode: string;
  onSelect: (mode: string) => void;
  compact?: boolean;
};
export default function ModePicker({ modes, currentMode, onSelect, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const currentLabel = MODE_LABELS[currentMode] ?? currentMode;
  const currentIcon = MODE_ICONS[currentMode] ?? CUSTOM_ICON;
  const isCustom = (m: ModeDef) => (m.source ?? "builtin") !== "builtin";
  const official = modes.filter((m) => !isCustom(m));
  const custom = modes.filter((m) => isCustom(m));
  const visible = [...official, ...custom];
  const iconFor = (m: ModeDef) => MODE_ICONS[m.slug] ?? CUSTOM_ICON;
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  useEffect(() => {
    if (!open || !listRef.current) return;
    const items = listRef.current.querySelectorAll(".arc-mode-dropdown-item");
    (items[activeIdx] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);
  const handleKey = (e: React.KeyboardEvent) => {
    if (!open) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % Math.max(1, visible.length));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + visible.length) % Math.max(1, visible.length));
        break;
      case "Enter":
        e.preventDefault();
        if (visible[activeIdx]) {
          onSelect(visible[activeIdx].slug);
          setOpen(false);
        }
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
    }
  };
  if (modes.length === 0) return null;
  return (
    <div className="arc-mode" ref={containerRef} onKeyDown={handleKey}>
      {compact ? (
        <button
          className={`arc-mode-trigger arc-mode-trigger-compact ${open ? "is-open" : ""}`}
          onClick={() => setOpen((o) => !o)}
          title={currentLabel + " mode"}
        >
          <span className="arc-mode-trigger-icon">{currentIcon}</span>
        </button>
      ) : (
        <button
          className={`arc-mode-trigger ${open ? "is-open" : ""}`}
          onClick={() => setOpen((o) => !o)}
          title={currentLabel + " mode"}
        >
          <span className="arc-mode-trigger-icon">{currentIcon}</span>
          <span className="arc-mode-trigger-label">{currentLabel}</span>
          <ChevronDown size={12} className={`arc-mode-trigger-chevron ${open ? "is-open" : ""}`} />
        </button>
      )}
      {open && (
        <div className="arc-mode-dropdown">
          <div className="arc-mode-dropdown-list" ref={listRef} onMouseLeave={() => setActiveIdx(-1)}>
            {official.map((m, i) => (
              <button
                key={m.slug}
                className={`arc-mode-dropdown-item ${m.slug === currentMode ? "is-selected" : ""} ${i === activeIdx ? "is-active" : ""}`}
                onClick={() => { onSelect(m.slug); setOpen(false); }}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <span className="arc-mode-dropdown-item-icon">
                  {iconFor(m)}
                </span>
                <span className="arc-mode-dropdown-item-label">{MODE_LABELS[m.slug] ?? m.slug}</span>
              </button>
            ))}
            {custom.length > 0 && (
              <>
                <div className="arc-mode-dropdown-sep" />
                {custom.map((m, j) => {
                  const idx = official.length + j;
                  return (
                    <button
                      key={m.slug}
                      className={`arc-mode-dropdown-item ${m.slug === currentMode ? "is-selected" : ""} ${idx === activeIdx ? "is-active" : ""}`}
                      onClick={() => { onSelect(m.slug); setOpen(false); }}
                      onMouseEnter={() => setActiveIdx(idx)}
                    >
                      <span className="arc-mode-dropdown-item-icon">
                        {CUSTOM_ICON}
                      </span>
                      <span className="arc-mode-dropdown-item-label">{MODE_LABELS[m.slug] ?? m.slug}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}