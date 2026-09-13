import { lazy, Suspense, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";
import { Settings, Plus, Trash2, Pencil, FoldVertical, PanelLeftClose, PanelLeft, ShieldCheck, ShieldOff, ShieldHalf, Search, ArrowLeft, Undo2, X, ListChecks } from "./icons";
import { TodoList, type TodoItemUI } from "./TodoList";
import { FadeSlideIn } from "./anim";
import ArcProcessUI, { type ProcessStep } from "./AgentProcess";
import Composer from "./Composer";
import { AUTO_MODEL_ID } from "./ModelPicker";
import type { Effort } from "./EffortPicker";
import type { ModelDescriptor, TurnUsage, ChatMessage, ProviderSummary, ProviderKind } from "@arc/host/protocol";
import { renderMarkdown } from "../util/markdown";
import type { RpcClient } from "../rpc";
import { useArcLogo, swapOnError } from "../hooks/useArcLogo";
const ConversationSearch = lazy(() => import("./ConversationSearch"));
const AUTO_APPROVE_LABELS: Record<"off" | "safe" | "allowlist" | "all", string> = { off: "Always ask", safe: "Safelist", allowlist: "Allowlist", all: "Hail mary (everything)" };
const SettingsModal = lazy(() => import("./SettingsView"));
const AUTO_CONFIRM_CONFIDENCE = 0.45;
type ChatMeta = { id: string; title: string; updatedAt: number; cost: number; isActive: boolean };
type Props = {
  client: RpcClient;
  monoLogo: string;
  prideLogo: string;
  monoLogoText: string;
  prideActive: boolean;
  toolTreeMode: "auto" | "collapsed";
  variant: "sidebar" | "fullscreen";
  version: string;
  providerCatalog: { kind: ProviderKind; label: string; tags: string[]; defaultBaseUrl?: string }[];
  toolCatalog: { name: string; category: string; description: string }[];
};
const WAVE_BAR = { transform: "scaleY(0.28)" };
function WaveSpinner() {
  return (
    <svg className="arc-wave" width="28" height="14" viewBox="0 0 28 14">
      <g fill="var(--vscode-descriptionForeground, #858585)">
        <rect className="arc-wave-bar" style={{ ...WAVE_BAR, animationDelay: "0s" }}    x="0"  y="0" width="4" height="14" rx="2" />
        <rect className="arc-wave-bar" style={{ ...WAVE_BAR, animationDelay: "0.10s" }} x="6"  y="0" width="4" height="14" rx="2" />
        <rect className="arc-wave-bar" style={{ ...WAVE_BAR, animationDelay: "0.20s" }} x="12" y="0" width="4" height="14" rx="2" />
        <rect className="arc-wave-bar" style={{ ...WAVE_BAR, animationDelay: "0.30s" }} x="18" y="0" width="4" height="14" rx="2" />
        <rect className="arc-wave-bar" style={{ ...WAVE_BAR, animationDelay: "0.40s" }} x="24" y="0" width="4" height="14" rx="2" />
      </g>
    </svg>
  );
}
function RippleSpinner() {
  return (
    <svg className="arc-wave" width="28" height="14" viewBox="0 0 28 14">
      <g fill="var(--vscode-descriptionForeground, #858585)">
        <rect className="arc-ripple-bar" style={{ animationDelay: "0.50s" }} x="0"  y="0" width="4" height="14" rx="2" />
        <rect className="arc-ripple-bar" style={{ animationDelay: "0.25s" }} x="6"  y="0" width="4" height="14" rx="2" />
        <rect className="arc-ripple-bar" style={{ animationDelay: "0s" }}    x="12" y="0" width="4" height="14" rx="2" />
        <rect className="arc-ripple-bar" style={{ animationDelay: "0.25s" }} x="18" y="0" width="4" height="14" rx="2" />
        <rect className="arc-ripple-bar" style={{ animationDelay: "0.50s" }} x="24" y="0" width="4" height="14" rx="2" />
      </g>
    </svg>
  );
}
const DEFAULT_RENDER_WINDOW = 400;
const RENDER_WINDOW_STEP = 500;
export default function ArcChat({ client, monoLogo, prideLogo, monoLogoText, prideActive, toolTreeMode, variant, version, providerCatalog, toolCatalog }: Props) {
  const logoUri = useArcLogo(monoLogo, prideLogo, prideActive);
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [steps, setSteps] = useState<ProcessStep[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<{ id: string; text: string; ts?: number } | null>(null);
  const attentionRef = useRef({ enabled: false, volume: 70, completion: true, approval: true, error: true, sound: "beep" as "beep" | "system" | "pop" });
  const playAttention = useCallback((kind: "done" | "approval" | "error") => {
    const a = attentionRef.current;
    if (!a.enabled) return;
    if (a.sound === "system") { client.send({ type: "attention/sound", event: kind }); return; }
    try {
      const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const pop = a.sound === "pop";
      const dur = pop ? 0.09 : kind === "done" ? 0.12 : kind === "approval" ? 0.2 : 0.25;
      const base = kind === "done" ? 880 : kind === "approval" ? 440 : 220;
      const freq = pop ? (kind === "done" ? 560 : kind === "approval" ? 470 : 360) : base;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      if (pop) osc.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.28), ctx.currentTime + dur);
      gain.gain.setValueAtTime(0.07 * (a.volume / 70), ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur);
} catch {  }
  }, [client]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showSidebarList, setShowSidebarList] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [clarification, setClarification] = useState<{ id: string; question: string; options: string[] } | null>(null);
  const [handoff, setHandoff] = useState<{ from: string; to: string; reason: string } | null>(null);
  const [, setUsage] = useState<TurnUsage | null>(null);
  const [ctxStats, setCtxStats] = useState<{ usedPct: number; tokens: number; window: number; cost: number; inputTokens?: number; cacheRead?: number; cacheWrite?: number; cacheReadCost?: number; completionTokens?: number; costIn?: number; costOut?: number } | null>(null);
  const [groupSummaryMode, setGroupSummaryMode] = useState<"count" | "tools" | "ai">("count");
  const pendingToolSummaries = useRef(new Map<string, (text: string) => void>());
  const pendingLocal = useRef<string[]>([]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [currentModel, setCurrentModel] = useState<string>("");
  const [modes, setModes] = useState<{ slug: string; description: string; source?: string }[]>([]);
  const [currentMode, setCurrentMode] = useState<string>("code");
  const [pendingAttachment, setPendingAttachment] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [hasEverSent, setHasEverSent] = useState(false);
  const [lastTurnError, setLastTurnError] = useState<{ message: string; code?: string } | null>(null);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpdate, setShowUpdate] = useState<{ version: string; url: string } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [serverStates, setServerStates] = useState<Record<string, { running: boolean; pid?: number; error?: string; starting?: boolean }>>({});
  const [approvalQueue, setApprovalQueue] = useState<{ id: string; description: string; kind: string; command?: string }[]>([]);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [queuedMessage, setQueuedMessage] = useState<{ text: string; attachments?: { uri: string; preview?: string }[]; images?: string[]; modelId?: string; autoRouted?: boolean } | null>(null);
  const [prefillText, setPrefillText] = useState<string | null>(null);
  const [prefillSeq, setPrefillSeq] = useState(0);
  const [polishLevel, setPolishLevel] = useState<"off" | "basic" | "polish">("off");
  const [polishing, setPolishing] = useState(false);
  const [polishPending, setPolishPending] = useState<{ original: string; polished: string } | null>(null);
  const [routing, setRouting] = useState(false);
  const [routePending, setRoutePending] = useState<{ original: string; modelId: string; modelLabel: string; domain?: string; confidence?: number } | null>(null);
  const routeRef = useRef<{ text: string; attachments?: { uri: string; preview?: string }[]; images?: string[] } | null>(null);
  const autoRouteRef = useRef(false);
  const [autoApproveMode, setAutoApproveModeState] = useState<"off" | "safe" | "allowlist" | "all">("off");
  const [reasoningEffort, setReasoningEffort] = useState<Effort>("high");
  const [resolvedDiffs, setResolvedDiffs] = useState<Record<string, "accepted" | "rejected">>({});
  const [chatLoading, setChatLoading] = useState(false);
  const [renderWindow, setRenderWindow] = useState(DEFAULT_RENDER_WINDOW);
  const renderWindowRef = useRef(DEFAULT_RENDER_WINDOW);
  renderWindowRef.current = renderWindow;
  const totalTimelineRef = useRef(0);
  const loadMoreScrollRef = useRef<{ h: number; top: number } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const pendingTextRef = useRef<{ id: string; text: string } | null>(null);
  const rafRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string>("");
  const stopSeqRef = useRef(0);
  const cancelStreamFlush = () => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    pendingTextRef.current = null;
  };
  useEffect(() => {
    void Promise.all([
      client.request<boolean>("arc.attention.enabled"),
      client.request<number>("arc.attention.volume"),
      client.request<boolean>("arc.attention.completion"),
      client.request<boolean>("arc.attention.approval"),
      client.request<boolean>("arc.attention.error"),
      client.request<string>("arc.attention.sound"),
      client.request<string>("arc.promptPolish"),
      client.request<boolean>("arc.router.autoRoute"),
    ]).then(([enabled, volume, completion, approval, error, attentionSound, promptPolish, autoRoute]) => {
      attentionRef.current = {
        enabled: enabled === true,
        volume: typeof volume === "number" ? volume : 70,
        completion: completion !== false,
        approval: approval !== false,
        error: error !== false,
        sound: attentionSound === "system" || attentionSound === "pop" ? attentionSound : "beep",
      };
      setPolishLevel(promptPolish === "basic" || promptPolish === "polish" ? promptPolish : "off");
      autoRouteRef.current = autoRoute === true;
    });
    const off = client.on((e: any) => {
      switch (e.type) {
        case "session/init":
          pendingLocal.current = [];
          if (e.chatId) setActiveId(e.chatId);
          if (Array.isArray(e.models)) setModels(e.models);
          if (e.currentModelId) setCurrentModel(e.currentModelId);
          if (Array.isArray(e.modes) && e.modes.length) {
            setModes(e.modes);
            if (typeof e.currentMode === "string" && e.modes.some((m: { slug: string }) => m?.slug === e.currentMode)) {
              setCurrentMode(e.currentMode);
            }
          }
          if (e.reasoningEffort) setReasoningEffort(e.reasoningEffort);
          break;
        case "mode/list":
          if (Array.isArray(e.modes) && e.modes.length) {
            setModes(e.modes);
            setCurrentMode((prev) => (prev && e.modes.some((m: { slug: string }) => m?.slug === prev) ? prev : e.modes[0].slug));
          }
          break;
        case "chat/list": if (Array.isArray(e.chats)) setChats(e.chats); break;
        case "chat/current":
          cancelStreamFlush();
          pendingLocal.current = [];
          sessionIdRef.current = e.chatId;
          setActiveId(e.chatId);
          setShowOnboarding(true);
          setHasEverSent(false);
          setSteps([]);
          setMessages([]);
          setStreaming(null);
          setLastTurnError(null);
          setPendingAttachment(null);
          setPolishing(false);
          setPolishPending(null);
          setApprovalQueue([]);
          setChatLoading(true);
          setRenderWindow(DEFAULT_RENDER_WINDOW);
          break;
        case "session/assistantText":
          if (e.sessionId && sessionIdRef.current && e.sessionId !== sessionIdRef.current) break;
          pendingTextRef.current = { id: e.id, text: e.text };
          if (rafRef.current == null) {
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = null;
              const p = pendingTextRef.current;
              if (p) setStreaming((s) => (s ? { ...s, id: p.id, text: p.text, ts: s.ts ?? Date.now() } : { id: p.id, text: p.text, ts: Date.now() }));
            });
          }
          break;
        case "session/message":
          if (e.sessionId && sessionIdRef.current && e.sessionId !== sessionIdRef.current) break;
          if (e.message.role === "assistant") {
            cancelStreamFlush();
            setStreaming((s) => (s && (s.id === e.message.id || s.id === "pending") ? null : s));
            if (e.message.toolCalls?.length) {
              setStreaming({ id: "pending", text: "" });
            }
          }
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === e.message.id);
            if (idx >= 0) {
              const next = prev.slice();
              next[idx] = e.message;
              return next;
            }
            if (e.message.role === "user") {
              const localId = pendingLocal.current.shift();
              if (localId) {
                const localIdx = prev.findIndex((m) => m.id === localId);
                if (localIdx >= 0) {
                  const next = prev.slice();
                  next[localIdx] = e.message;
                  return next;
                }
              }
            }
            return [...prev, e.message];
          });
          break;
        case "session/steps":
          setSteps(e.steps);
          break;
        case "session/stepUpdate":
          setSteps((prev) => {
            const idx = prev.findIndex((s) => s.id === e.step.id);
            if (idx < 0) return [...prev, e.step];
            const next = prev.slice();
            next[idx] = e.step;
            return next;
          });
          break;
        case "session/replaceState":
          setMessages(e.messages);
          setSteps(e.steps);
          setChatLoading(false);
          if (e.loadComposer) { setPrefillText(e.loadComposer); setPrefillSeq((s) => s + 1); }
          break;
        case "session/turnStart":
          stopSeqRef.current++;
          if (e.sessionId && sessionIdRef.current !== e.sessionId) sessionIdRef.current = e.sessionId;
          setStreaming({ id: "pending", text: "" }); setShowOnboarding(false); setLastTurnError(null); break;
        case "session/turnEnd": stopSeqRef.current++; setStopping(false); if (attentionRef.current.completion) playAttention("done"); cancelStreamFlush(); setStreaming(null); break;
        case "session/clarification": setClarification({ id: e.id, question: e.question, options: e.options }); break;
        case "suggestions/list":
          setSuggestions((e as { items: { kind: string; id: string; label: string; detail?: string; tokens: number }[] }).items ?? []);
          break;
        case "session/guidance":
          break;
        case "session/handoff":
          setHandoff({ from: e.fromModel, to: e.toModel, reason: e.reason });
          setTimeout(() => setHandoff(null), 2400);
          break;
        case "session/attachment": setPendingAttachment(e.preview); break;
        case "session/usage": setUsage(e.usage); break;
        case "context/stats": setCtxStats(e); break;
        case "chat/toolsSummary":
          pendingToolSummaries.current.get(e.id)?.(e.text ?? "");
          pendingToolSummaries.current.delete(e.id);
          break;
        case "model/list": setModels(e.models); setCurrentModel(e.currentModelId); break;
        case "provider/list": setProviders(e.providers); break;
        case "provider/serverState":
          setServerStates((prev) => ({ ...prev, [e.providerId]: { running: e.running, pid: e.pid, error: e.error, starting: false } }));
          break;
        case "ui/showSettings": setShowSettings(true); break;
        case "ui/showUpdate": setShowUpdate({ version: e.version, url: e.url }); break;
        case "ui/showSearch": setShowSearch(true); break;
        case "autoApproveState": setAutoApproveModeState(e.mode ?? (e.active ? "all" : "off")); break;
        case "approval/request":
          if (attentionRef.current.approval) playAttention("approval");
          setApprovalQueue((q) => (q.some((a) => a.id === e.id) ? q : [...q.slice(-19), { id: e.id, description: e.description, kind: e.kind, command: e.command }]));
          break;
        case "chat/polishResult":
          setPolishing(false);
          setPolishPending({ original: e.original, polished: e.polished });
          break;
        case "chat/polishFailed":
          setPolishing(false);
          setPolishPending({ original: e.original, polished: e.original });
          break;
        case "chat/routeResult":
          setRouting(false);
          if (autoRouteRef.current && (e.confidence ?? 1) >= AUTO_CONFIRM_CONFIDENCE) {
            const r = routeRef.current;
            setRoutePending(null);
            routeRef.current = null;
            if (r) send(r.text, r.attachments, r.images, e.modelId, true);
          } else {
            setRoutePending({
              original: e.original,
              modelId: e.modelId,
              modelLabel: e.modelLabel || models.find((m) => m.id === e.modelId)?.label || e.modelId,
              domain: e.domain,
              confidence: e.confidence,
            });
          }
          break;
        case "chat/routeFailed":
          {
            setRouting(false);
            const routed = routeRef.current;
            routeRef.current = null;
            if (routed) send(routed.text, routed.attachments, routed.images);
          }
          break;
        case "config/changed":
          if (e.key === "arc.promptPolish") setPolishLevel(e.value === "basic" || e.value === "polish" ? e.value : "off");
          if (e.key === "arc.diffView.autoOpen") setAutoOpenDiff(e.value !== false);
          if (e.key === "arc.router.autoRoute") autoRouteRef.current = e.value === true;
          if (e.key === "arc.appearance.toolGroupSummary") setGroupSummaryMode(e.value === "tools" ? "tools" : e.value === "ai" ? "ai" : "count");
          if (typeof e.key === "string" && e.key.startsWith("arc.attention.")) {
            const k = e.key.slice("arc.attention.".length);
            const a = attentionRef.current;
            if (k === "enabled") a.enabled = e.value === true;
            else if (k === "volume" && typeof e.value === "number") a.volume = Math.max(0, Math.min(100, e.value));
            else if (k === "sound" && (e.value === "beep" || e.value === "system" || e.value === "pop")) a.sound = e.value;
            else if ((k === "completion" || k === "approval" || k === "error") && e.value !== undefined) attentionRef.current[k as "completion" | "approval" | "error"] = e.value !== false;
          }
          if (e.key === "arc.notifications.enabled" && e.value !== undefined) attentionRef.current.enabled = e.value !== false;
          break;
        case "error":
          if (attentionRef.current.error) playAttention("error");
          setLastTurnError({ message: e.message, code: e.code });
          setErrorExpanded(false);
          break;
      }
    });
    client.send({ type: "ready" });
    return () => { off(); cancelStreamFlush(); };
  }, [client]);
  useEffect(() => {
    if (streaming && !streaming.text) {
      setWaiting(false);
      const id = setTimeout(() => setWaiting(true), 3000);
      return () => clearTimeout(id);
    }
    setWaiting(false);
  }, [streaming]);
  const atBottomRef = useRef(true);
  const onTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 80 && renderWindowRef.current < totalTimelineRef.current && !loadMoreScrollRef.current && !chatLoading) {
      loadMoreScrollRef.current = { h: el.scrollHeight, top: el.scrollTop };
      setRenderWindow((w) => w + RENDER_WINDOW_STEP);
    }
  };
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [steps, streaming, clarification, messages]);
  const send = (text: string, attachments?: { uri: string; preview?: string }[], images?: string[], modelId?: string, autoRouted?: boolean) => {
    if (streaming || stopping) {
      setQueuedMessage({ text, attachments, images, modelId, autoRouted });
      return;
    }
    setPrefillText("");
    setPrefillSeq((s) => s + 1);
    setRouting(false);
    setRoutePending(null);
    routeRef.current = null;
    setPolishing(false);
    setPolishPending(null);
    setShowOnboarding(false);
    setHasEverSent(true);
    setLastTurnError(null);
    setPendingAttachment(null);
    const localId = `local-${Date.now()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    pendingLocal.current.push(localId);
    setMessages((prev) => [...prev, { id: localId, role: "user", content: text, ts: Date.now() }]);
    client.send({ type: "chat/send", text, attachments, images, ...(modelId ? { modelId } : {}), ...(autoRouted ? { autoRouted: true } : {}) });
  };
  const route = (text: string, attachments?: { uri: string; preview?: string }[], images?: string[]) => {
    routeRef.current = { text, attachments, images };
    setPolishing(false);
    setPolishPending(null);
    setShowOnboarding(false);
    setHasEverSent(true);
    setLastTurnError(null);
    setPendingAttachment(null);
    setRouting(true);
    client.send({ type: "chat/route", text, attachments, images });
  };
  const handleSend = (text: string, attachments?: { uri: string; preview?: string }[], images?: string[]) => {
    if (currentModel === AUTO_MODEL_ID) {
      route(text, attachments, images);
      return;
    }
    send(text, attachments, images, currentModel);
  };
  const acceptRouted = () => {
    const r = routeRef.current;
    const p = routePending;
    setRoutePending(null);
    setRouting(false);
    routeRef.current = null;
    if (r) send(r.text, r.attachments, r.images, p?.modelId);
  };
  const rejectRouted = () => {
    setRoutePending(null);
    setRouting(false);
    routeRef.current = null;
  };
  const polish = (text: string) => {
    setPolishing(true);
    client.send({ type: "chat/polish", text });
  };
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    const seq = ++stopSeqRef.current;
    setStopping(true);
    client.send({ type: "chat/stop" });
    window.setTimeout(() => {
      if (stopSeqRef.current === seq) setStopping(false);
    }, 5000);
  };
  const guide = (text: string) => client.send({ type: "chat/guidance", text });
  const cancelQueue = () => setQueuedMessage(null);
  useEffect(() => {
    if (!streaming && !stopping && queuedMessage) {
      const q = queuedMessage;
      setQueuedMessage(null);
      send(q.text, q.attachments, q.images, q.modelId, q.autoRouted);
    }
  }, [streaming, stopping, queuedMessage]);
  const newChat = () => { setShowOnboarding(true); client.send({ type: "chat/new" }); };
  const switchChat = (id: string) => client.send({ type: "chat/switch", chatId: id });
  const renameChat = (id: string, title: string) => client.send({ type: "chat/rename", chatId: id, title });
  const deleteChat = (id: string) => client.send({ type: "chat/delete", chatId: id });
  const compact = () => client.send({ type: "chat/compact" });
  const openSettings = () => setShowSettings(true);
  const closeSettings = () => {
    setShowSettings(false);
    void client.request<string>("arc.promptPolish").then((v) => setPolishLevel(v === "basic" || v === "polish" ? v : "off"));
  };
  const openFile = (path: string, line?: number, endLine?: number) => {
    client.send({ type: "ui/openFile", path, ...(line ? { line } : {}), ...(line && endLine && endLine > line ? { endLine } : {}) });
  };
  const onTranscriptClick = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest?.(".arc-md-copy") as HTMLElement | null;
    if (copyBtn) {
      const block = copyBtn.closest?.(".arc-md-codeblock") as HTMLElement | null;
      const pre = block?.querySelector("pre.arc-md-pre") as HTMLElement | null;
      const code = pre?.textContent ?? "";
      if (code) {
        void navigator.clipboard.writeText(code).then(() => {
          copyBtn.classList.add("is-copied");
          copyBtn.setAttribute("aria-label", "Copied");
          window.setTimeout(() => {
            copyBtn.classList.remove("is-copied");
            copyBtn.setAttribute("aria-label", "Copy code");
          }, 1400);
        });
      }
      return;
    }
    const ref = target.closest?.(".arc-ref, .arc-ref-code") as HTMLElement | null;
    if (!ref) return;
    const path = ref.getAttribute("data-path");
    if (!path) return;
    const line = Number(ref.getAttribute("data-line") || 0) || undefined;
    const endLine = Number(ref.getAttribute("data-end-line") || 0) || undefined;
    openFile(path, line, endLine);
  };
  const selectModel = (id: string) => {
    setCurrentModel(id);
    setRoutePending(null);
    setRouting(false);
    routeRef.current = null;
    if (id === AUTO_MODEL_ID) return;
    client.send({ type: "model/select", modelId: id });
  };
  const selectEffort = (e: Effort) => {
    setReasoningEffort(e);
    client.send({ type: "config/set", key: "arc.reasoning.effort", value: e });
  };
  const selectMode = (mode: string) => {
    setCurrentMode(mode);
    client.send({ type: "mode/select", mode });
  };
  const setAutoApprove = (mode: "off" | "safe" | "allowlist" | "all") => client.send({ type: "autoApprove/set", mode });
  const [autoApproveMenuOpen, setAutoApproveMenuOpen] = useState(false);
  const approval = approvalQueue[0] ?? null;
  const respondApproval = (allowed: boolean, rememberCommand?: string, rememberPrefix?: string) => {
    const current = approvalQueue[0];
    if (!current) return;
    client.send({ type: "approval/response", id: current.id, allowed, ...(rememberCommand ? { rememberCommand } : {}), ...(rememberPrefix ? { rememberPrefix } : {}) });
    setApprovalQueue((q) => q.slice(1));
  };
  const getApprovalCommand = (desc: string): string | undefined => {
    if (approval?.command) return approval.command;
    const lines = desc.split("\n\n");
    return lines.length > 1 ? lines[1].trim() : undefined;
  };
  const unwrapPrefix = (cmd: string): string => {
    let s = cmd.trim().replace(/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s]*)\s+)+/, "");
    for (let depth = 0; depth < 5; depth++) {
      const m = s.match(/^(sudo|doas|su|runas|env|nice|timeout|stdbuf|unshare|chroot|npx|sh|bash|zsh|fish|pwsh|powershell|cmd)(?:\s+|$)/i);
      if (!m) break;
      s = s.slice(m[0].length).trim().replace(/^[-/]c\s+/i, "").replace(/^((-[a-zA-Z]+\s+[^\s-][^\s]*|--\s+|\d[\d.]*(ms|s|m|h|d)?)\s+)+/, "").trim();
      if ((s[0] === '"' || s[0] === "'") && s.length > 1) {
        const close = s.indexOf(s[0], 1);
        s = (close > 0 ? s.slice(1, close) : s.slice(1)).trim();
      }
    }
    return s;
  };
  const getApprovalPrefix = (desc: string): string | undefined => {
    const cmd = approval?.command ?? getApprovalCommand(desc);
    if (!cmd) return undefined;
    const stripped = unwrapPrefix(cmd);
    const first = stripped.split(/\s+/)[0] || undefined;
    if (!first) return undefined;
    const unquoted = first.replace(/^["']|["']$/g, "");
    return unquoted.split(/[\\/]/).pop() || undefined;
  };
  const isEditableTarget = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    if (!el || typeof (el as HTMLElement).tagName !== "string") return false;
    const tag = (el as HTMLElement).tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return (el as HTMLElement).isContentEditable === true;
  };
  useEffect(() => {
    if (!approval) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === "Escape") { setApprovalMenuOpen(false); respondApproval(false); e.preventDefault(); }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { respondApproval(true); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [approval]);
  useEffect(() => {
    if (!clarification) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.metaKey) {
        const idx = parseInt(e.key) - 1;
        if (idx < clarification.options.length) {
          client.send({ type: "chat/answerClarification", id: clarification.id, answer: clarification.options[idx] });
          setClarification(null);
          e.preventDefault();
        }
      }
      if (e.key === "Escape") { setClarification(null); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [clarification]);
  useEffect(() => {
    const onFocus = () => {
      if (document.querySelector(".arc-modal-overlay, [role='dialog']")) return;
      const active = document.activeElement;
      if (!active || active === document.body || active === document.getElementById("root")) {
        (document.querySelector(".arc-composer textarea") as HTMLTextAreaElement)?.focus();
        return;
      }
      const tag = active.tagName.toLowerCase();
      const isEditable = active.getAttribute("contenteditable") === "true";
      if (tag !== "input" && tag !== "textarea" && tag !== "select" && !isEditable) {
        (document.querySelector(".arc-composer textarea") as HTMLTextAreaElement)?.focus();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const pct = ctxStats?.usedPct ?? 0;
  const chatCost = ctxStats?.cost ?? 0;
  const costShort = chatCost.toFixed(1);
  const [ctxTipOpen, setCtxTipOpen] = useState(false);
  const fmtTok = (n: number | undefined) => {
    const v = n ?? 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return String(Math.round(v));
  };
  const fmtMoney = (n: number | undefined) => {
    const v = n ?? 0;
    return `$${v.toFixed(v > 0 && v < 0.01 ? 4 : 2)}`;
  };
  const hitTokens = ctxStats?.cacheRead ?? 0;
  const missTokens = Math.max(0, (ctxStats?.inputTokens ?? 0) - hitTokens);
  const missCost = Math.max(0, (ctxStats?.costIn ?? 0) - (ctxStats?.cacheReadCost ?? 0));
  const hitRate = (ctxStats?.inputTokens ?? 0) > 0 ? hitTokens / (ctxStats?.inputTokens ?? 0) : 0;
  const isEmpty = steps.length === 0 && streaming === null && !hasEverSent && !lastTurnError;
  type TimelineItem =
    | { kind: "msg"; ts: number; seq: number; msg: ChatMessage }
    | { kind: "step"; ts: number; seq: number; step: ProcessStep }
    | { kind: "stream"; ts: number; seq: number }
    | { kind: "compaction"; ts: number; seq: number; msg: ChatMessage };
  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [];
    let seq = 0;
    for (const m of messages) {
      if (m.role === "system") {
        if (m.content && m.content.startsWith("## Compaction summary of")) {
          items.push({ kind: "compaction", ts: m.ts ?? 0, seq: seq++, msg: m });
        }
        continue;
      }
      items.push({ kind: "msg", ts: m.ts ?? 0, seq: seq++, msg: m });
    }
    for (const s of steps) {
      items.push({ kind: "step", ts: s.ts ?? 0, seq: seq++, step: s });
    }
    if (streaming?.text && streaming.ts) {
      items.push({ kind: "stream", ts: streaming.ts, seq: seq++ });
    }
    items.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    totalTimelineRef.current = items.length;
    return items;
  }, [messages, steps, streaming]);
  const requestAISummary = useCallback((groupId: string, titles: string[]): Promise<string> => {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        pendingToolSummaries.current.delete(groupId);
        resolve("");
      }, 15_000);
      pendingToolSummaries.current.set(groupId, (t) => {
        clearTimeout(timer);
        pendingToolSummaries.current.delete(groupId);
        resolve(t);
      });
      client.send({ type: "chat/summarizeTools", id: groupId, titles });
    });
  }, [client]);
  const saveGroupTitle = useCallback((stepId: string, title: string, mode: string) => {
    client.send({ type: "chat/saveGroupTitle", stepId, title, mode });
  }, [client]);
  const timelineNodes = useMemo<ReactNode[]>(() => {
    const out: ReactNode[] = [];
    let run: ProcessStep[] = [];
    const handleResolveDiff = (step: ProcessStep, action: "accept" | "reject") => {
      setResolvedDiffs((cur) => ({ ...cur, [step.id]: action === "accept" ? "accepted" : "rejected" }));
      if (action === "reject" && step.filePath) {
        client.send({ type: "diff/reject", stepId: step.id, filePath: step.filePath, hunks: step.diffHunks ?? [] });
      } else if (action === "accept" && step.filePath) {
        client.send({ type: "diff/accept", stepId: step.id, filePath: step.filePath });
      }
    };
    const flush = () => {
      if (run.length) {
        out.push(
          <ArcProcessUI
            key={`steps-${run[0].id}`}
            steps={run}
            onOpenFile={openFile}
            onOpenFullscreenDiff={(payload) => {
              if (!payload.filePath) return;
              client.send({ type: "ui/openFileDiff", path: payload.filePath, hunks: payload.hunks });
            }}
            toolTreeMode={toolTreeMode}
            resolvedDiffs={resolvedDiffs}
            onResolveDiff={handleResolveDiff}
            groupSummaryMode={groupSummaryMode}
            requestAISummary={requestAISummary}
            saveGroupTitle={saveGroupTitle}
          />,
        );
        run = [];
      }
    };
    const visible = timeline.length > renderWindow ? timeline.slice(timeline.length - renderWindow) : timeline;
    const hiddenCount = timeline.length - visible.length;
    if (hiddenCount > 0) {
      out.push(
        <button key="load-earlier" className="arc-btn" style={{ margin: "8px auto 12px", display: "block" }} onClick={() => {
          const el = transcriptRef.current;
          if (el) loadMoreScrollRef.current = { h: el.scrollHeight, top: el.scrollTop };
          setRenderWindow((w) => w + RENDER_WINDOW_STEP);
        }}>
          Load {Math.min(RENDER_WINDOW_STEP, hiddenCount)} earlier messages ({hiddenCount} hidden)
        </button>,
      );
    }
    for (const item of visible) {
      if (item.kind === "step") {
        run.push(item.step);
        continue;
      }
      if (item.kind === "stream") {
        flush();
        const full = streaming?.text ?? "";
        const shown = full.length > 12000 ? `${full.slice(0, 4000)}\n\n… (${full.length - 8000} chars elided while streaming) …\n\n${full.slice(-4000)}` : full;
        out.push(
          <div key="stream" className="arc-streaming" aria-live="polite">
            <span className="arc-streaming-text arc-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(shown) }} />
          </div>,
        );
        continue;
      }
      if (item.kind === "compaction") {
        flush();
        out.push(
          <ArcProcessUI
            key={`compaction-${item.msg.id}`}
            steps={[compactionStepFor(item.msg)]}
            onOpenFile={openFile}
            onOpenFullscreenDiff={(payload) => {
              if (!payload.filePath) return;
              client.send({ type: "ui/openFileDiff", path: payload.filePath, hunks: payload.hunks });
            }}
            toolTreeMode={toolTreeMode}
            resolvedDiffs={resolvedDiffs}
            onResolveDiff={handleResolveDiff}
          />,
        );
        continue;
      }
      const m = item.msg;
      if (m.role === "assistant" && m.toolCalls?.length && !m.content) continue;
      if (m.role === "tool") continue;
      flush();
      out.push(<MessageBubble key={m.id} message={m} client={client} />);
    }
    flush();
    return out;
  }, [timeline, toolTreeMode, variant, resolvedDiffs, client, groupSummaryMode, requestAISummary, saveGroupTitle, renderWindow]);
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!el || !loadMoreScrollRef.current) return;
    const { h, top } = loadMoreScrollRef.current;
    loadMoreScrollRef.current = null;
    el.scrollTop = el.scrollHeight - h + top;
  }, [timelineNodes]);
  const latestTodos = useMemo(() => {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].type === "todo_list" && steps[i].todos?.length) return steps[i].todos ?? null;
    }
    return null;
  }, [steps]);
  const [todosOpen, setTodosOpen] = useState(true);
  const [todosVisible, setTodosVisible] = useState(false);
  // Task 14: suggestions for unused context.
  const [suggestions, setSuggestions] = useState<{ kind: string; id: string; label: string; detail?: string; tokens: number }[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  useEffect(() => {
    client.send({ type: "suggestions/list" });
    const t = setInterval(() => client.send({ type: "suggestions/list" }), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [client, activeId]);
  const latestTodosSig = useRef<string | null>(null);
  useEffect(() => {
    if (!latestTodos?.length) {
      latestTodosSig.current = null;
      return;
    }
    const sig = JSON.stringify(latestTodos);
    if (latestTodosSig.current !== sig) {
      const first = latestTodosSig.current === null;
      latestTodosSig.current = sig;
      setTodosVisible(true);
      if (first) setTodosOpen(true);
    }
  }, [latestTodos]);
  useEffect(() => {
    if (variant !== "sidebar" || streaming || !latestTodos?.length) return;
    const allDone = (items: TodoItemUI[]): boolean =>
      items.every((t) => (t.state === "done" || t.state === "skipped") && (!t.children?.length || allDone(t.children)));
    if (allDone(latestTodos as TodoItemUI[])) setTodosVisible(false);
  }, [variant, streaming, latestTodos]);
  const [autoOpenDiff, setAutoOpenDiff] = useState(true);
  useEffect(() => {
    void client.request<boolean>("arc.diffView.autoOpen").then((v) => setAutoOpenDiff(v !== false));
    void client.request<string>("arc.appearance.toolGroupSummary").then((v) => setGroupSummaryMode(v === "tools" ? "tools" : v === "ai" ? "ai" : "count"));
  }, [client]);
  const latestStreamingDiff = useMemo(() => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step.type !== "tool") continue;
      if (step.toolName !== "file.edit" && step.toolName !== "file.write") continue;
      if (!step.diffHunks || !step.diffHunks.length) continue;
      return { signature: `${step.id}:${step.filePath ?? ""}:${step.diffHunks.length}`, filePath: step.filePath, hunks: step.diffHunks };
    }
    return null;
  }, [steps]);
  useEffect(() => {
    if (variant !== "sidebar") return;
    if (!autoOpenDiff) return;
    if (!streaming) return;
    if (!latestStreamingDiff) return;
    if (!latestStreamingDiff.filePath) return;
    client.send({ type: "ui/openFileDiff", path: latestStreamingDiff.filePath, hunks: latestStreamingDiff.hunks, streamId: latestStreamingDiff.signature });
  }, [variant, streaming, latestStreamingDiff, autoOpenDiff, client]);
  const activeTitle = chats.find((c) => c.id === activeId)?.title ?? "Chat";
  const currentModelLabel = models.find((m) => m.id === currentModel)?.label;
  return (
    <div className={`arc-shell arc-shell-${variant}`}>
      {variant === "sidebar" && showSidebarList ? (
        <div className="arc-body arc-body-sidebar">
          <div className="arc-sidebar-nav">
            <button className="arc-iconbtn" title="Back to chat" onClick={() => setShowSidebarList(false)}>
              <ArrowLeft size={15} />
            </button>
            <span className="arc-sidebar-nav-label">Chats</span>
            <span className="arc-topbar-spacer" />
            <button className="arc-iconbtn" title="Search conversations" onClick={() => client.send({ type: "ui/openFullscreen", show: "search" } as any)}>
              <Search size={14} />
            </button>
            <button className="arc-iconbtn" title="New chat" onClick={newChat}>
              <Plus size={15} />
            </button>
          </div>
          <div className="arc-sidebar-list-wrap">
            <ChatList
              chats={chats}
              activeId={activeId}
              onSelect={(id) => { switchChat(id); setShowSidebarList(false); }}
              onNew={newChat}
              onSearch={() => client.send({ type: "ui/openFullscreen", show: "search" } as any)}
              onRename={(id) => setRenaming({ id, value: chats.find((x) => x.id === id)?.title ?? "" })}
              onDelete={deleteChat}
              renaming={renaming}
              setRenaming={setRenaming}
              onCommitRename={(id, value) => { renameChat(id, value); setRenaming(null); }}
              hideHeader
            />
          </div>
        </div>
      ) : (
        <>
      <header className="arc-topbar">
        {variant === "fullscreen" && (
          <button className="arc-iconbtn" title={sidebarCollapsed ? "Show chat list" : "Hide chat list"} onClick={() => setSidebarCollapsed((c) => !c)}>
            {sidebarCollapsed ? <PanelLeft size={14} /> : <PanelLeftClose size={14} />}
          </button>
        )}
        {variant === "sidebar" && (
          <>
            <button className="arc-iconbtn" title="Back to chat list" onClick={() => setShowSidebarList(true)}>
              <ArrowLeft size={15} />
            </button>
            <span className="arc-topbar-title" title={activeTitle}>{activeTitle}</span>
          </>
        )}
        <span className="arc-topbar-spacer" />
        <span className="arc-ctx-group" onMouseEnter={() => setCtxTipOpen(true)} onMouseLeave={() => setCtxTipOpen(false)}>
          <span className="arc-ctx-pct">{pct.toFixed(0)}%</span>
          <span className="arc-ctx-dot">·</span>
          <span className="arc-topbar-cost">${costShort}</span>
          {ctxTipOpen && (
            <div className="arc-ctx-tooltip" role="status">
              <div className="arc-ctx-tip-row arc-ctx-tip-head">
                <span>Context</span>
                <span>{fmtTok(ctxStats?.tokens)} / {fmtTok(ctxStats?.window)} ({pct.toFixed(1)}%)</span>
              </div>
              <div className="arc-ctx-tip-row"><span>Cache hit</span><span>{fmtTok(hitTokens)} tok · {fmtMoney(ctxStats?.cacheReadCost)}</span></div>
              <div className="arc-ctx-tip-row"><span>Cache miss</span><span>{fmtTok(missTokens)} tok · {fmtMoney(missCost)}</span></div>
              <div className="arc-ctx-tip-row"><span>Output</span><span>{fmtTok(ctxStats?.completionTokens)} tok · {fmtMoney(ctxStats?.costOut)}</span></div>
              <div className="arc-ctx-tip-row"><span>Input total</span><span>{fmtMoney(ctxStats?.costIn)}</span></div>
              <div className="arc-ctx-tip-row arc-ctx-tip-total"><span>Total</span><span>{fmtMoney(chatCost)}</span></div>
              <div className="arc-ctx-tip-row"><span>Cache hit rate</span><span>{(hitRate * 100).toFixed(1)}%</span></div>
            </div>
          )}
        </span>
        <span className="arc-topbar-sep" />
        <button className="arc-iconbtn" title="Compress context" onClick={compact} disabled={!!streaming}>
          <FoldVertical size={15} />
        </button>
        <div className="arc-autoapprove-wrap">
          <button className={`arc-iconbtn arc-aam-btn arc-aam-${autoApproveMode}`} title={`Auto-approve: ${AUTO_APPROVE_LABELS[autoApproveMode]}`} onClick={() => setAutoApproveMenuOpen((o) => !o)} aria-expanded={autoApproveMenuOpen} aria-haspopup="menu">
            {autoApproveMode === "all" ? <ShieldCheck size={15} /> : autoApproveMode === "safe" ? <ShieldHalf size={15} /> : autoApproveMode === "allowlist" ? <ListChecks size={15} /> : <ShieldOff size={15} />}
          </button>
          {autoApproveMenuOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={() => setAutoApproveMenuOpen(false)} />
              <div className="arc-approval-menu arc-autoapprove-menu" role="menu">
                <button role="menuitem" className={autoApproveMode === "off" ? "is-current" : ""} onClick={() => { setAutoApprove("off"); setAutoApproveMenuOpen(false); }}>Always ask</button>
                <button role="menuitem" className={autoApproveMode === "safe" ? "is-current" : ""} onClick={() => { setAutoApprove("safe"); setAutoApproveMenuOpen(false); }}>Safelist</button>
                <button role="menuitem" className={autoApproveMode === "allowlist" ? "is-current" : ""} onClick={() => { setAutoApprove("allowlist"); setAutoApproveMenuOpen(false); }}>Allowlist</button>
                <button role="menuitem" className={autoApproveMode === "all" ? "is-current" : ""} onClick={() => { setAutoApprove("all"); setAutoApproveMenuOpen(false); }}>Hail mary (everything)</button>
              </div>
            </>
          )}
        </div>
        {variant === "fullscreen" && (
          <button className="arc-iconbtn" title="Settings" onClick={openSettings}>
            <Settings size={15} />
          </button>
        )}
      </header>
      <div className={`arc-body arc-body-${variant}`}>
        {variant === "fullscreen" && !sidebarCollapsed && (
          <ChatList
            chats={chats}
            activeId={activeId}
            onSelect={switchChat}
            onNew={newChat}
            onSearch={() => setShowSearch(true)}
            onRename={(id) => setRenaming({ id, value: chats.find((x) => x.id === id)?.title ?? "" })}
            onDelete={deleteChat}
            renaming={renaming}
            setRenaming={setRenaming}
            onCommitRename={(id, value) => { renameChat(id, value); setRenaming(null); }}
            todos={latestTodos as any}
          />
        )}
        <main className="arc-main">
          {handoff && (
            <FadeSlideIn className="arc-handoff-sep">
              <span className="arc-handoff-sep-label">{handoff.to}</span>
            </FadeSlideIn>
          )}
          <div className="arc-transcript" ref={transcriptRef} onScroll={onTranscriptScroll} onClick={onTranscriptClick}>
            {chatLoading && (
              <div className="arc-streaming" aria-live="polite" role="status">
                <span className="arc-working"><RippleSpinner /> Loading messages...</span>
              </div>
            )}
            {showOnboarding && isEmpty && !chatLoading && (
              <Onboarding logoUri={logoUri} monoLogo={monoLogo} hasModels={models.length > 0} onOpenSettings={openSettings} />
            )}
            {timelineNodes}
            {lastTurnError && !streaming && (
              <div className={`arc-transcript-error ${errorExpanded ? "is-expanded" : ""}`} role="status">
                <div className="arc-transcript-error-body">{lastTurnError.message}</div>
                <button
                  className="arc-transcript-error-toggle"
                  onClick={() => setErrorExpanded((v) => !v)}
                  aria-expanded={errorExpanded}
                >
                  {errorExpanded ? "Show less" : "Expand"}
                </button>
              </div>
            )}
            {(() => {
              const lastStep = steps.length ? steps[steps.length - 1] : undefined;
              const toolPhase = !!lastStep && (lastStep.type === "thought" || (lastStep.type === "tool" && lastStep.pending));
              const showWorking = streaming && (!streaming.text || toolPhase);
              return showWorking ? (
                <div className="arc-streaming" aria-live="polite">
                  <span className="arc-working">
                    {waiting ? <RippleSpinner /> : <WaveSpinner />}
                    {waiting ? "Waiting..." : "Working..."}
                  </span>
                </div>
              ) : null;
            })()}
          </div>
          <footer className="arc-footer">
            <Composer
              key={activeId}
              onSend={handleSend}
              onStop={stop}
              onGuidance={guide}
              streaming={!!streaming}
              pendingAttachment={pendingAttachment}
              queuedText={queuedMessage?.text ?? null}
              onCancelQueue={cancelQueue}
              prefillText={prefillText}
              prefillSeq={prefillSeq}
              todos={variant === "sidebar" && todosVisible ? (latestTodos as TodoItemUI[] | null) : null}
              todosOpen={todosOpen}
              onToggleTodos={() => setTodosOpen((o) => !o)}
              polishing={polishing}
              polishPending={polishPending}
              onRejectPolished={() => setPolishPending(null)}
              polishLevel={polishLevel}
              onPolish={polish}
              autoMode={currentModel === AUTO_MODEL_ID}
              routing={routing}
              routePending={routePending ? { modelLabel: routePending.modelLabel, domain: routePending.domain, confidence: routePending.confidence } : null}
              onAcceptRouted={acceptRouted}
              onRejectRouted={rejectRouted}
              approval={approval ? { description: approval.description, queueCount: approvalQueue.length } : null}
              approvalMenuOpen={approvalMenuOpen}
              onToggleApprovalMenu={() => setApprovalMenuOpen((o) => !o)}
              onRespondApproval={(allowed, rememberCommand, rememberPrefix) => { setApprovalMenuOpen(false); respondApproval(allowed, rememberCommand, rememberPrefix); }}
              approvalCommand={approval ? getApprovalCommand(approval.description) : undefined}
              approvalPrefix={approval ? getApprovalPrefix(approval.description) : undefined}
              clarification={clarification ? { question: clarification.question, options: clarification.options } : null}
              onAnswerClarification={(answer) => { if (clarification) client.send({ type: "chat/answerClarification", id: clarification.id, answer }); setClarification(null); }}
              onDismissClarification={() => { if (clarification) client.send({ type: "chat/answerClarification", id: clarification.id, answer: "" }); setClarification(null); }}
              suggestions={suggestions.length ? suggestions : null}
              suggestionsOpen={suggestionsOpen}
              onToggleSuggestions={() => setSuggestionsOpen((o) => !o)}
              onUnloadSuggestion={(kind, id) => client.send({ type: "suggestions/unload", kind, id })}
              onDismissSuggestion={(kind, id) => {
                setSuggestions((prev) => prev.filter((s) => !(s.kind === kind && s.id === id)));
                client.send({ type: "suggestions/dismiss", kind, id });
              }}
              placeholder={currentModel === AUTO_MODEL_ID ? "Ask anything" : (currentModelLabel ? `Ask ${currentModelLabel}` : undefined)}
              variant={variant}
              models={models}
              currentModelId={currentModel}
              onSelectModel={selectModel}
              modes={modes}
              currentMode={currentMode}
              onSelectMode={selectMode}
              effort={reasoningEffort}
              onSelectEffort={selectEffort}
            />
          </footer>
        </main>
      </div>
      </> )}
      {showSearch && (
        <Suspense fallback={null}>
          <ConversationSearch
            client={client}
            onClose={() => setShowSearch(false)}
          />
        </Suspense>
      )}
      {showUpdate && (
        <div className="arc-modal-overlay" onClick={() => setShowUpdate(null)}>
          <div className="arc-modal" onClick={(e) => e.stopPropagation()}>
            <header className="arc-modal-head">
              <h2>Arc has been updated</h2>
              <button className="arc-iconbtn" onClick={() => setShowUpdate(null)} title="Close"><X size={16} /></button>
            </header>
            <main className="arc-modal-body">
              <div className="arc-settings-inner">
                <div className="arc-update">
                  <p>Arc {showUpdate.version} is here. See what's new in this release.</p>
                  <button className="arc-update-cta" onClick={() => client.send({ type: "ui/openExternal", url: showUpdate.url })}>
                    Release notes
                  </button>
                </div>
              </div>
            </main>
          </div>
        </div>
      )}
      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            client={client}
            onClose={closeSettings}
            onUseChat={(t) => { setShowSettings(false); setPrefillText(t); setPrefillSeq((s) => s + 1); }}
            models={models}
            providers={providers}
            serverStates={serverStates}
            setServerStates={setServerStates}
            monoLogoText={monoLogoText}
            version={version}
            providerCatalog={providerCatalog}
            toolCatalog={toolCatalog}
          />
        </Suspense>
      )}
    </div>
  );
}
function compactionStepFor(message: ChatMessage): ProcessStep {
  const content = message.content || "";
  const m = /^## Compaction summary of (\d+) earlier messages/.exec(content);
  const count = m ? Number(m[1]) : null;
  return {
    id: `compaction-${message.id}`,
    type: "tool",
    toolName: "context.compact",
    title: count != null ? `Compacted ${count} messages` : "Context compacted",
    ts: message.ts,
    pending: false,
    noMark: true,
  };
}
const MessageBubble = memo(function MessageBubble({ message, client }: { message: ChatMessage; client?: RpcClient }) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  if (isTool) {
    return (
      <div className="arc-bubble arc-bubble-tool" role="note">
        <span className="arc-bubble-tool-id">{message.toolCallId ?? "tool"}</span>
        <pre className="arc-bubble-tool-body">{message.content}</pre>
      </div>
    );
  }
  const userImages = (message as any).images as { image_url: { url: string } }[] | undefined;
  const imgs = userImages?.length ? (
    <div className="arc-bubble-images">
      {userImages.map((img, i) => (
        <img key={i} src={img.image_url.url} alt={`Pasted ${i + 1}`} className="arc-bubble-img" onClick={() => setEnlarged(img.image_url.url)} />
      ))}
    </div>
  ) : null;
  return (
    <>
      <div className={`arc-bubble ${isUser ? "arc-bubble-user" : "arc-bubble-assistant"}`}>
        {isUser && imgs}
        {isUser ? (
          editing ? (
            <div className="arc-bubble-text" style={{ padding: 0 }}>
              <textarea
                ref={editRef}
                autoFocus
                defaultValue={message.content}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(false);
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    const newText = editRef.current?.value ?? "";
                    if (newText.trim()) {
                      client?.send({ type: "chat/editMessage", messageId: message.id, content: message.content, newContent: newText });
                    }
                    setEditing(false);
                  }
                }}
                style={{ width: "100%", minHeight: 40, background: "var(--vscode-input-background)", color: "var(--vscode-input-foreground)", border: "1px solid var(--vscode-input-border)", borderRadius: "var(--arc-radius)", padding: "6px 8px", font: "inherit", fontSize: 13, resize: "none", outline: "none", lineHeight: 1.5 }}
                rows={2}
              />
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 4, flexDirection: "row-reverse" }}>
              <div className="arc-bubble-text">{message.content}{(message as unknown as { editedOriginal?: string }).editedOriginal !== undefined && (
                <span className="arc-msg-edited" title="Edited after sending"> (edited)</span>
              )}</div>
              {client && (
                <span style={{ display: "flex", gap: 2, opacity: 0, transition: "opacity 0.18s", flexShrink: 0, alignSelf: "flex-start", marginTop: 2 }} className="arc-msg-actions">
                  <button className="arc-iconbtn" style={{ width: 22, height: 22 }} title="Revert to here" onClick={() => { client.send({ type: "chat/revertToMessage", messageId: message.id, content: message.content, restoreFiles: true, loadToComposer: true }); }}>
                    <Undo2 size={12} />
                  </button>
                  <button className="arc-iconbtn" style={{ width: 22, height: 22 }} title="Edit message" onClick={() => { setEditing(true); }}>
                    <Pencil size={12} />
                  </button>
                </span>
              )}
            </div>
          )
        ) : (
          <div
            className="arc-bubble-text arc-md"
            dangerouslySetInnerHTML={{ __html: message.content ? renderMarkdown(message.content) : '<span class="arc-bubble-empty">(empty response)</span>' }}
          />
        )}
      </div>
      {enlarged && (
        <div className="arc-image-overlay" onClick={() => setEnlarged(null)}>
          <img src={enlarged} alt="Enlarged" />
        </div>
      )}
    </>
  );
});
function Onboarding({ logoUri, monoLogo, hasModels, onOpenSettings }: { logoUri: string; monoLogo: string; hasModels: boolean; onOpenSettings: () => void }) {
  return (
    <div className="arc-onboarding">
      <img className="arc-onboarding-mark" src={logoUri} alt="Arc" onError={swapOnError(monoLogo)} />
      {!hasModels && (
        <p className="arc-onboarding-hint">No configured model. <button className="arc-link" onClick={onOpenSettings}>Open settings →</button></p>
      )}
    </div>
  );
}
function ChatList({
  chats, activeId, onSelect, onNew, onSearch, onRename, onDelete, renaming, setRenaming, onCommitRename, todos, hideHeader,
}: {
  chats: ChatMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSearch: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  renaming: { id: string; value: string } | null;
  setRenaming: (r: { id: string; value: string } | null) => void;
  onCommitRename: (id: string, value: string) => void;
  todos?: { id: string; text: string; state: "pending" | "in_progress" | "done" | "skipped" }[] | null;
  hideHeader?: boolean;
}) {
  return (
    <aside className="arc-chatlist">
      {!hideHeader && (
        <div className="arc-chatlist-head">
          <span>Chats</span>
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <button className="arc-iconbtn" title="Search conversations" onClick={onSearch}>
              <Search size={14} />
            </button>
            <button className="arc-iconbtn" onClick={onNew} title="New chat"><Plus size={15} /></button>
          </span>
        </div>
      )}
      <ul className="arc-chatlist-list">
        {chats.length === 0 && <li className="arc-chatlist-empty">No chats yet.</li>}
        {chats.map((c) => (
          <li key={c.id} className={`arc-chatlist-item ${c.id === activeId ? "is-active" : ""}`} onClick={() => onSelect(c.id)}>
            {renaming?.id === c.id ? (
              <input
                className="arc-chatlist-rename"
                autoFocus
                value={renaming.value}
                onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
                onBlur={() => onCommitRename(c.id, renaming.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommitRename(c.id, renaming.value);
                  if (e.key === "Escape") setRenaming(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="arc-chatlist-title" onDoubleClick={(e) => { e.stopPropagation(); onRename(c.id); }}>{c.title}</span>
            )}
            <span className="arc-chatlist-cost">${c.cost.toFixed(3)}</span>
            <span className="arc-chatlist-actions">
              <button className="arc-chatlist-action" title="Rename" onClick={(e) => { e.stopPropagation(); onRename(c.id); }}><Pencil size={12} /></button>
              <button className="arc-chatlist-action" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}><Trash2 size={12} /></button>
            </span>
          </li>
        ))}
      </ul>
      {todos && todos.length > 0 && (
        <div className="arc-todo-sidebar">
          <TodoList items={todos} level={0} />
        </div>
      )}
    </aside>
  );
}