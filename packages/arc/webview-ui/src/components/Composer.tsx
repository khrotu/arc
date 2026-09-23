import { useState, useRef, useEffect, useCallback, useLayoutEffect, type ReactNode } from "react";
import { ArrowUp, Paperclip, Square, X, ChevronDown } from "./icons";
import ModelPicker from "./ModelPicker";
import ModePicker from "./ModePicker";
import EffortPicker, { type Effort } from "./EffortPicker";
import { TodoList, type TodoItemUI } from "./TodoList";
import type { ModelDescriptor } from "@arc/host/protocol";
type Attachment = { uri: string; preview?: string };
function AttachParent({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) {
      setFlip(false);
      return;
    }
    const el = parentRef.current?.querySelector<HTMLElement>(".arc-attach-submenu");
    if (!el) return;
    const vw = document.documentElement.clientWidth;
    const r = el.getBoundingClientRect();
    if (!flip && r.right > vw - 8) setFlip(true);
    else if (flip && r.left < 8) setFlip(false);
  }, [open, flip]);
  return (
    <div className="arc-attach-parent" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className="arc-attach-item arc-attach-has-sub" onClick={() => setOpen(false)}>{label}</button>
      {open && <div className={`arc-attach-submenu ${flip ? "is-flipped" : ""}`}>{children}</div>}
    </div>
  );
}
type Props = {
  onSend: (text: string, attachments?: Attachment[], images?: string[]) => void;
  onStop?: () => void;
  onGuidance?: (text: string) => void;
  streaming?: boolean;
  disabled?: boolean;
  pendingAttachment?: string | null;
  onAttach?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  queuedText?: string | null;
  onCancelQueue?: () => void;
  prefillText?: string | null;
  prefillSeq?: number;
  todos?: TodoItemUI[] | null;
  todosOpen?: boolean;
  onToggleTodos?: () => void;
  polishing?: boolean;
  polishPending?: { original: string; polished: string } | null;
  onRejectPolished?: () => void;
  polishLevel?: "off" | "basic" | "polish";
  onPolish?: (text: string) => void;
  autoMode?: boolean;
  routing?: boolean;
  routePending?: { modelLabel: string; domain?: string; confidence?: number } | null;
  onAcceptRouted?: () => void;
  onRejectRouted?: () => void;
  approval?: { description: string; queueCount: number } | null;
  approvalMenuOpen?: boolean;
  onToggleApprovalMenu?: () => void;
  onRespondApproval?: (allowed: boolean, rememberCommand?: string, rememberPrefix?: string) => void;
  approvalCommand?: string;
  approvalPrefix?: string;
  clarification?: { question: string; options: string[] } | null;
  onAnswerClarification?: (answer: string) => void;
  onDismissClarification?: () => void;
  suggestions?: { kind: string; id: string; label: string; detail?: string; tokens: number }[] | null;
  suggestionsOpen?: boolean;
  onToggleSuggestions?: () => void;
  onUnloadSuggestion?: (kind: string, id: string) => void;
  onDismissSuggestion?: (kind: string, id: string) => void;
  variant: "sidebar" | "fullscreen";
  models: ModelDescriptor[];
  currentModelId: string;
  onSelectModel: (modelId: string) => void;
  modes: { slug: string; description: string }[];
  currentMode: string;
  onSelectMode: (mode: string) => void;
  effort: Effort;
  onSelectEffort: (effort: Effort) => void;
};
export default function Composer({
  onSend, onStop, onGuidance, streaming, disabled, pendingAttachment, onAttach, placeholder, autoFocus = true, queuedText, onCancelQueue, prefillText, prefillSeq,
  todos, todosOpen, onToggleTodos, polishing, polishPending, onRejectPolished, polishLevel, onPolish,
  autoMode, routing, routePending, onAcceptRouted, onRejectRouted,
  approval, approvalMenuOpen, onToggleApprovalMenu, onRespondApproval, approvalCommand, approvalPrefix,
  clarification, onAnswerClarification, onDismissClarification,
  suggestions, suggestionsOpen, onToggleSuggestions, onUnloadSuggestion, onDismissSuggestion,
  variant, models, currentModelId, onSelectModel, modes, currentMode, onSelectMode, effort, onSelectEffort,
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  useLayoutEffect(() => {
    if (prefillText !== undefined && prefillText !== null) {
      setText(prefillText);
      ref.current?.focus();
    }
  }, [prefillText, prefillSeq]);
  useLayoutEffect(() => {
    if (polishPending) setText(polishPending.polished);
  }, [polishPending]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);
  useEffect(() => {
    if (!actionsOpen) return;
    const handler = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [actionsOpen]);
  useEffect(() => {
    if (pendingAttachment) {
      setAttachments((prev) => [
        ...prev.filter((a) => a.preview !== pendingAttachment),
        { uri: pendingAttachment, preview: pendingAttachment },
      ]);
    }
  }, [pendingAttachment]);
  const routeActive = !!routing || !!routePending;
  const submit = useCallback(() => {
    const t = text.trim();
    if (!t || disabled) return;
    if (routeActive) return;
    if (polishLevel && polishLevel !== "off" && !polishing && !polishPending && onPolish) {
      onPolish(t);
      return;
    }
    onSend(t, attachments.length ? attachments : undefined, images.length ? images : undefined);
    if (!autoMode) {
      setText("");
      setAttachments([]);
      setImages([]);
    }
  }, [text, disabled, streaming, attachments, images, onSend, polishLevel, polishing, polishPending, onPolish, autoMode, routeActive]);
  const acceptRoute = () => {
    onAcceptRouted?.();
    setText("");
    setAttachments([]);
    setImages([]);
  };
  const rejectRoute = () => {
    onRejectRouted?.();
  };
  const attach = () => {
    if (onAttach) return onAttach();
    (window as unknown as { __ARC_ATTACH?: () => void }).__ARC_ATTACH?.();
  };
  const attachFile = () => {
    (window as unknown as { __ARC_ATTACH_FILE?: () => void }).__ARC_ATTACH_FILE?.();
  };
  const attachProblems = () => {
    (window as unknown as { __ARC_ATTACH_PROBLEMS?: () => void }).__ARC_ATTACH_PROBLEMS?.();
  };
  const attachAllProblems = () => {
    (window as unknown as { __ARC_ATTACH_ALL_PROBLEMS?: () => void }).__ARC_ATTACH_ALL_PROBLEMS?.();
  };
  const attachFileProblems = () => {
    (window as unknown as { __ARC_ATTACH_FILE_PROBLEMS?: () => void }).__ARC_ATTACH_FILE_PROBLEMS?.();
  };
  const attachCurrentFile = () => {
    (window as unknown as { __ARC_ATTACH_CURRENT_FILE?: () => void }).__ARC_ATTACH_CURRENT_FILE?.();
  };
  const attachGitDiff = () => {
    (window as unknown as { __ARC_ATTACH_GIT_DIFF?: () => void }).__ARC_ATTACH_GIT_DIFF?.();
  };
  const attachGitStaged = () => {
    (window as unknown as { __ARC_ATTACH_GIT_STAGED?: () => void }).__ARC_ATTACH_GIT_STAGED?.();
  };
  const attachChangedFiles = () => {
    (window as unknown as { __ARC_ATTACH_CHANGED_FILES?: () => void }).__ARC_ATTACH_CHANGED_FILES?.();
  };
  const attachPullRequest = () => {
    (window as unknown as { __ARC_ATTACH_PR?: () => void }).__ARC_ATTACH_PR?.();
  };
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLDivElement>(null);
  const [dropdownFlip, setDropdownFlip] = useState(false);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (attachRef.current && !attachRef.current.contains(e.target as Node)) setAttachOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  useLayoutEffect(() => {
    if (!attachOpen) {
      setDropdownFlip(false);
      return;
    }
    const el = attachRef.current?.querySelector<HTMLElement>(".arc-attach-dropdown");
    if (!el) return;
    const vw = document.documentElement.clientWidth;
    const r = el.getBoundingClientRect();
    if (!dropdownFlip && r.right > vw - 8) setDropdownFlip(true);
    else if (dropdownFlip && r.left < 8) setDropdownFlip(false);
  }, [attachOpen, dropdownFlip]);
  const todoCount = todos
    ? (() => {
        let done = 0, all = 0;
        const walk = (list: TodoItemUI[]) => {
          for (const t of list) {
            all++;
            if (t.state === "done" || t.state === "skipped") done++;
            if (t.children?.length) walk(t.children);
          }
        };
        walk(todos);
        return { done, all };
      })()
    : null;
  const currentTodo = todos
    ? (() => {
        const walk = (list: TodoItemUI[]): TodoItemUI | null => {
          for (const t of list) {
            if (t.state === "in_progress") return t;
            if (t.children?.length) {
              const c = walk(t.children);
              if (c) return c;
            }
          }
          return null;
        };
        const hit = walk(todos);
        if (hit) return hit;
        const next = (list: TodoItemUI[]): TodoItemUI | null => {
          for (const t of list) {
            if (t.state !== "done" && t.state !== "skipped") return t;
            if (t.children?.length) {
              const c = next(t.children);
              if (c) return c;
            }
          }
          return null;
        };
        return next(todos);
      })()
    : null;
  const planBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!todosOpen || !planBodyRef.current) return;
    const el = planBodyRef.current.querySelector<HTMLElement>(".arc-todo-sidebar-item-in_progress");
    el?.scrollIntoView({ block: "center" });
  }, [todosOpen, todos]);
  if (queuedText) {
    return (
      <div className="arc-composer is-queued">
        <div className="arc-composer-queued">
          <span className="arc-composer-queued-label">Queued message:</span>
          <span className="arc-composer-queued-text">{queuedText}</span>
          <button className="arc-composer-send is-stop" onClick={onCancelQueue} title="Cancel queued message">
            <X size={12} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={`arc-composer ${disabled ? "is-disabled" : ""} ${streaming ? "is-busy" : ""} ${polishing ? "is-polishing" : ""} ${routing ? "is-routing" : ""}`}>
      {polishPending && (
        <div className="arc-composer-polish">
          <div className="arc-composer-polish-actions">
            <button className="arc-btn-ghost" onClick={() => { onRejectPolished?.(); setText(polishPending.original); }}>Revert</button>
            <button className="arc-btn" onClick={submit}>Send</button>
          </div>
        </div>
      )}
      {routePending && (
        <div className="arc-composer-route">
          <div className="arc-composer-route-bar">
            <span className="arc-composer-route-label">
              Routed to <strong>{routePending.modelLabel}</strong>
              {routePending.domain && routePending.domain !== "general" ? (
                <span className="arc-composer-route-domain">{routePending.domain}</span>
              ) : null}
            </span>
            <button className="arc-btn" onClick={acceptRoute}>Accept</button>
            <button className="arc-btn-ghost" onClick={rejectRoute}>Reject</button>
          </div>
        </div>
      )}
      {clarification && (
        <div className="arc-composer-clar">
          <div className="arc-composer-clar-head">
            <span className="arc-composer-clar-title">Clarification needed</span>
            <span className="arc-spacer" />
            <button className="arc-iconbtn" title="Dismiss" aria-label="Dismiss clarification" onClick={() => onDismissClarification?.()}>
              <X size={13} />
            </button>
          </div>
          <div className="arc-composer-clar-q">{clarification.question}</div>
          {clarification.options.length > 0 && (
            <div className="arc-composer-clar-options">
              {clarification.options.map((opt, i) => (
                <button key={opt} className="arc-chip" onClick={() => onAnswerClarification?.(opt)}>
                  {opt}<kbd>{i + 1}</kbd>
                </button>
              ))}
            </div>
          )}
          <div className="arc-composer-clar-input">
            <input
              type="text"
              placeholder="Type your answer..."
              aria-label="Clarification answer"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) {
                    onAnswerClarification?.(val);
                    (e.target as HTMLInputElement).value = "";
                  }
                }
              }}
            />
            <button
              aria-label="Submit answer"
              onClick={(e) => {
                const input = (e.currentTarget.parentElement?.querySelector("input") as HTMLInputElement | null);
                const val = input?.value.trim();
                if (val) {
                  onAnswerClarification?.(val);
                  if (input) input.value = "";
                }
              }}
            >↩</button>
          </div>
        </div>
      )}
      {approval && (
        <div className="arc-composer-approval">
          <div className="arc-composer-approval-head">
            <span className="arc-approval-dot" />
            <span className="arc-composer-approval-q">{(approval.description ?? "Approval required").split("\n\n")[0]}</span>
            {approval.queueCount > 1 && <span className="arc-composer-approval-meta">+{approval.queueCount - 1}</span>}
          </div>
          {(approval.description ?? "").includes("\n\n") && (
            <div className="arc-composer-approval-body">{(approval.description ?? "").split("\n\n").slice(1).join("\n\n")}</div>
          )}
          <div className="arc-composer-approval-actions">
            <div className="arc-approval-allow-group">
              <button className="arc-approval-allow" onClick={() => onRespondApproval?.(true)} autoFocus>
                Allow once
              </button>
              <button
                className="arc-approval-allow-caret"
                onClick={() => onToggleApprovalMenu?.()}
                aria-expanded={approvalMenuOpen}
                aria-haspopup="menu"
                title="More approval options"
              >
                <ChevronDown size={13} />
              </button>
              {approvalMenuOpen && (
                <div className="arc-approval-menu" role="menu">
                  <button role="menuitem" onClick={() => { if (approvalCommand) onRespondApproval?.(true, approvalCommand); onToggleApprovalMenu?.(); }}>
                    Allow session
                  </button>
                  <button role="menuitem" onClick={() => { if (approvalPrefix) onRespondApproval?.(true, undefined, approvalPrefix); onToggleApprovalMenu?.(); }}>
                    Allow prefix
                  </button>
                </div>
              )}
            </div>
            <button className="arc-approval-deny" onClick={() => { onRespondApproval?.(false); }}>
              Deny <kbd>Esc</kbd>
            </button>
          </div>
        </div>
      )}
      {todos && todos.length > 0 && (
        <div className={`arc-composer-plan ${todosOpen ? "is-open" : ""}`}>
          <button className="arc-composer-plan-head" onClick={onToggleTodos}>
            {todosOpen && <span className="arc-composer-plan-title">Plan</span>}
            {!todosOpen && currentTodo && (
              <span className={`arc-composer-plan-current ${currentTodo.state === "in_progress" ? "is-active" : ""}`}>{currentTodo.text}</span>
            )}
            {todoCount && <span className="arc-composer-plan-count">{todoCount.done}/{todoCount.all}</span>}
            <ChevronDown size={11} className={`arc-composer-plan-chevron ${todosOpen ? "is-open" : ""}`} />
          </button>
          {todosOpen && (
            <div className="arc-composer-plan-body" ref={planBodyRef}>
              <TodoList items={todos} level={0} />
            </div>
          )}
        </div>
      )}
      {suggestions && suggestions.length > 0 && (
        <div className={`arc-composer-suggestions ${suggestionsOpen ? "is-open" : ""}`}>
          <button className="arc-composer-plan-head" onClick={onToggleSuggestions} title="Unused context you can unload to save tokens">
            <span className="arc-composer-plan-title">Suggestions</span>
            <span className="arc-composer-suggest-save">
              save ~{(suggestions.reduce((s, x) => s + x.tokens, 0) / 1000).toFixed(1)}k
            </span>
            <span className="arc-composer-plan-count">{suggestions.length}</span>
            <ChevronDown size={11} className={`arc-composer-plan-chevron ${suggestionsOpen ? "is-open" : ""}`} />
          </button>
          {suggestionsOpen && (
            <div className="arc-composer-suggest-body">
              {suggestions.map((s) => (
                <div key={`${s.kind}:${s.id}`} className="arc-composer-suggest-row">
                  <div className="arc-composer-suggest-main">
                    <span className="arc-composer-suggest-label">{s.label}</span>
                    {s.detail && <span className="arc-composer-suggest-detail">{s.detail}</span>}
                  </div>
                  <span className="arc-composer-suggest-tokens">~{s.tokens >= 1000 ? `${(s.tokens / 1000).toFixed(1)}k` : s.tokens}</span>
                  <button
                    className="arc-btn-ghost arc-composer-suggest-unload"
                    title={s.kind === "mcp" || s.kind === "tool" ? `Unload ${s.label}` : `Dismiss suggestion`}
                    onClick={() => onUnloadSuggestion?.(s.kind, s.id)}
                  >
                    {s.kind === "mcp" || s.kind === "tool" ? "Unload" : "Dismiss"}
                  </button>
                  <button className="arc-iconbtn" title="Dismiss" aria-label={`Dismiss ${s.label}`} onClick={() => onDismissSuggestion?.(s.kind, s.id)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="arc-composer-attachments">
          {attachments.map((a) => (
            <span key={a.uri} className="arc-attach-pill">
              <Paperclip size={11} />
              <span className="arc-attach-pill-text">{a.preview ?? a.uri}</span>
              <button className="arc-attach-pill-x" onClick={() => setAttachments((p) => p.filter((x) => x.uri !== a.uri))} aria-label="Remove">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="arc-composer-images">
          {images.map((dataUrl, i) => (
            <span key={i} className="arc-image-chip">
              <img src={dataUrl} alt={`Pasted ${i + 1}`} onClick={() => setEnlarged(dataUrl)} />
              <button
                className="arc-image-chip-x"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              ><X size={14} /></button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const items = e.clipboardData?.items;
          if (!items) return;
          for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith("image/")) {
              const blob = items[i].getAsFile();
              if (!blob) continue;
              const reader = new FileReader();
              reader.onload = () => setImages((prev) => [...prev, reader.result as string]);
              reader.readAsDataURL(blob);
              e.preventDefault();
            }
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.ctrlKey && onGuidance) {
            e.preventDefault();
            const t = text.trim();
            if (t) { onGuidance(t); setText(""); }
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault(); submit();
          }
        }}
        rows={1}
        disabled={disabled || !!polishing || routeActive}
        placeholder={placeholder ?? "Ask Arc anything..."}
      />
      <div className="arc-composer-bar">
        <div className="arc-composer-pickers">
          {modes.length > 0 && (
            <ModePicker modes={modes} currentMode={currentMode} onSelect={onSelectMode} compact />
          )}
          <ModelPicker models={models} currentModelId={currentModelId} onSelect={onSelectModel} compact />
          <EffortPicker effort={effort} onSelect={onSelectEffort} variant={variant} compact />
        </div>
        <span className="arc-spacer" />
        <div className="arc-attach-wrap" ref={attachRef}>
          <button className="arc-composer-tool" title="Attach" onClick={() => setAttachOpen((o) => !o)} disabled={disabled}>
            <Paperclip size={14} />
          </button>
          {attachOpen && (
            <div className={`arc-attach-dropdown ${dropdownFlip ? "is-flipped" : ""}`}>
              <button className="arc-attach-item" onClick={() => { attach(); setAttachOpen(false); }}>Attach selection</button>
              <AttachParent label="Attach file">
                <button className="arc-attach-item" onClick={() => { attachCurrentFile(); setAttachOpen(false); }}>Current file</button>
                <button className="arc-attach-item" onClick={() => { attachFile(); setAttachOpen(false); }}>Select...</button>
              </AttachParent>
              <AttachParent label="Attach problems">
                <button className="arc-attach-item" onClick={() => { attachProblems(); setAttachOpen(false); }}>Current file</button>
                <button className="arc-attach-item" onClick={() => { attachAllProblems(); setAttachOpen(false); }}>All files</button>
                <button className="arc-attach-item" onClick={() => { attachFileProblems(); setAttachOpen(false); }}>Select...</button>
              </AttachParent>
              <AttachParent label="Attach from Git">
                <button className="arc-attach-item" onClick={() => { attachGitDiff(); setAttachOpen(false); }}>Unstaged diff</button>
                <button className="arc-attach-item" onClick={() => { attachGitStaged(); setAttachOpen(false); }}>Staged diff</button>
                <button className="arc-attach-item" onClick={() => { attachChangedFiles(); setAttachOpen(false); }}>Changed files</button>
                <div className="arc-attach-sep" />
                <AttachParent label="Pull request">
                  <button className="arc-attach-item" onClick={() => { attachPullRequest(); setAttachOpen(false); }}>Current branch</button>
                </AttachParent>
              </AttachParent>
            </div>
          )}
        </div>
        {streaming ? (
          <div className="arc-send-group" ref={actionsRef}>
            <button className="arc-composer-send is-stop" onClick={onStop} title="Stop">
              <Square size={12} strokeWidth={2.5} />
            </button>
            {text.trim() ? (
              <>
                <span className="arc-send-sep" />
                <button className="arc-composer-send" onClick={submit} title="Send (queues after current turn)">
                  <ArrowUp size={15} strokeWidth={2.5} />
                </button>
                <span className="arc-send-sep" />
                <button className="arc-composer-send is-chevron" onClick={() => setActionsOpen((o) => !o)} title="More actions">
                  <ChevronDown size={12} strokeWidth={2.5} />
                </button>
                {actionsOpen && (
                  <div className="arc-send-dropdown">
                    <button className="arc-send-dropdown-item" onClick={() => { setActionsOpen(false); if (text.trim() && onGuidance) { onGuidance(text.trim()); setText(""); } }} disabled={!text.trim()}>
                      Steer
                    </button>
                    <button className="arc-send-dropdown-item" onClick={() => { setActionsOpen(false); if (text.trim()) { onSend(text.trim(), attachments.length ? attachments : undefined, images.length ? images : undefined); setText(""); setAttachments([]); setImages([]); } }} disabled={!text.trim()}>
                      Queue
                    </button>
                  </div>
                )}
              </>
            ) : null}
          </div>
        ) : (
          <button className="arc-composer-send" onClick={submit} disabled={disabled || polishing || routeActive || !text.trim()} title="Send (Enter)">
            <ArrowUp size={15} strokeWidth={2.5} />
          </button>
        )}
      </div>
      {enlarged && (
        <div className="arc-image-overlay" onClick={() => setEnlarged(null)}>
          <img src={enlarged} alt="Enlarged" />
        </div>
      )}
    </div>
  );
}