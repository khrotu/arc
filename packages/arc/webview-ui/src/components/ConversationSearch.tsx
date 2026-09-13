import { useState, useRef, useEffect } from "react";
import { Search, X, History, ArrowRight } from "./icons";
import type { RpcClient } from "../rpc";
type SearchResult = { id: string; title: string; matches: string[] };
type Props = {
  client: RpcClient;
  onClose: () => void;
};
export default function ConversationSearch({ client, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const latestQueryRef = useRef("");
  useEffect(() => {
    inputRef.current?.focus();
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "chat/searchResults") {
        if (typeof e.data.query !== "string" || e.data.query !== latestQueryRef.current) return;
        const raw: unknown[] = Array.isArray(e.data.results) ? e.data.results : [];
        setResults(
          raw
            .filter((r: unknown): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as Record<string, unknown>).id === "string")
            .map((r) => ({
              id: r.id as string,
              title: typeof r.title === "string" ? r.title : "(untitled)",
              matches: Array.isArray(r.matches)
                ? r.matches.map((m: unknown) => (typeof m === "string" ? m : m && typeof (m as Record<string, unknown>).text === "string" ? ((m as Record<string, unknown>).text as string) : "")).filter(Boolean)
                : [],
            })),
        );
        setLoading(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!query.trim()) { setResults([]); setLoading(false); return; }
      setLoading(true);
      latestQueryRef.current = query.trim();
      client.send({ type: "chat/search", query: latestQueryRef.current });
    }, 200);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    setSelectedIdx(0);
    listRef.current?.scrollTo(0, 0);
  }, [results]);
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && results[selectedIdx]) { resume(results[selectedIdx].id); }
    else if (e.key === "Escape") onClose();
  };
  const resume = (id: string) => {
    client.send({ type: "chat/resume", id } as any);
    onClose();
  };
  return (
    <div className="arc-modal-overlay" onClick={onClose}>
      <div className="arc-modal" onClick={(e) => e.stopPropagation()}>
        <header className="arc-modal-head">
          <Search size={16} />
          <h2>Search Conversations</h2>
          <div className="arc-search-input-wrap">
            <input
              ref={inputRef}
              className="arc-input"
              type="text"
              placeholder="Search past conversations..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKey}
            />
          </div>
          <button className="arc-iconbtn" onClick={onClose}><X size={15} /></button>
        </header>
        <div className="arc-modal-body">
          {loading && <div className="arc-search-loading">Searching...</div>}
          {!loading && !query.trim() && (
            <div className="arc-empty" style={{ padding: 48 }}>
              <Search size={32} className="arc-empty-icon" style={{ opacity: 0.3 }} />
              <p className="arc-empty-text">Type to search past conversations</p>
            </div>
          )}
          {!loading && query.trim() && results.length === 0 && (
            <div className="arc-empty" style={{ padding: 48 }}>
              <Search size={32} className="arc-empty-icon" style={{ opacity: 0.3 }} />
              <p className="arc-empty-text">No results for "{query}"</p>
            </div>
          )}
          {results.length > 0 && (
            <div className="arc-search-results" ref={listRef}>
              {results.map((r, i) => (
                <div
                  key={r.id}
                  className={`arc-search-result ${i === selectedIdx ? "is-active" : ""}`}
                  onClick={() => resume(r.id)}
                  onMouseEnter={() => setSelectedIdx(i)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") resume(r.id); }}
                >
                  <div className="arc-search-result-header">
                    <History size={13} className="arc-search-result-icon" />
                    <span className="arc-search-result-title">{r.title}</span>
                    <ArrowRight size={13} className="arc-search-result-arrow" />
                  </div>
                  {r.matches.slice(0, 3).map((m, j) => (
                    <div key={j} className="arc-search-result-match">
                      {highlight(m, query)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
function highlight(text: string, q: string): JSX.Element {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx === -1) return <span>{text}</span>;
  const start = Math.max(0, idx - 30);
  const prefix = start > 0 ? "..." : "";
  const before = text.slice(start, idx);
  const match = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length, idx + q.length + 100);
  const suffix = text.length > idx + q.length + 100 ? "..." : "";
  return <span>{prefix}{before}<span className="arc-search-highlight">{match}</span>{after}{suffix}</span>;
}