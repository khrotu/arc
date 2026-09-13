import { randomUUID } from "node:crypto";
import { ModelRegistry } from "../routing/registry.js";
import { pickProvider } from "../routing/router.js";
import { transportFor } from "../providers/transport.js";
import type { ChatMessage, ModelDescriptor } from "../protocol/protocol.js";
import type { ProcessStep } from "../protocol/process.js";
export type GroupSummaryMode = "count" | "tools" | "ai";
export const GROUP_SUMMARY_MAX_CHARS = 50;
export type ToolPhrase = readonly [verb: string, object: string];
const TOOL_PHRASES: Record<string, ToolPhrase> = {
  "file.read": ["Read", "files"],
  "notebook.read": ["Read", "files"],
  "file.edit": ["Edited", "files"],
  "file.write": ["Wrote", "files"],
  "file.grep": ["Searched", "files"],
  "file.glob": ["Globbed", "files"],
  "file.semanticSearch": ["Ran", "semantic search"],
  "syms.context": ["Built", "code context"],
  "shell.run": ["Ran", "commands"],
  "shell.backgroundRun": ["Started", "background process"],
  "shell.check": ["Checked", "processes"],
  "shell.write": ["Managed", "processes"],
  "shell.customRun": ["Created", "custom runs"],
  "shell.editCustomRun": ["Edited", "custom runs"],
  "shell.runCustomRun": ["Ran", "custom runs"],
  "lsp.problems": ["Checked", "diagnostics"],
  "lsp.problemsFor": ["Checked", "diagnostics"],
  "todo.write": ["Updated", "plan"],
  "web.search": ["Searched", "the web"],
  "web.fetch": ["Fetched", "pages"],
  "mcp.call": ["Called", "MCP tools"],
  "mcp.create": ["Registered", "MCP servers"],
  "mcp.remove": ["Removed", "MCP servers"],
  "mcp.toggle": ["Toggled", "MCP servers"],
  "mcp.resources/list": ["Listed", "MCP resources"],
  "mcp.resources/read": ["Read", "MCP resources"],
  "mcp.prompts/list": ["Listed", "MCP prompts"],
  "mcp.prompts/get": ["Fetched", "MCP prompts"],
  "test.run": ["Ran", "tests"],
  "subagent.spawn": ["Spawned", "subagents"],
  "subagent.askParent": ["Asked", "the parent"],
  "clarification.askUser": ["Asked", "questions"],
  "checkpoint.list": ["Listed", "checkpoints"],
  "checkpoint.revert": ["Reverted", "checkpoints"],
  "checkpoint.compare": ["Compared", "checkpoints"],
  "handoff": ["Handed off", "models"],
  "context.retrieve": ["Retrieved", "context"],
  "memory.add": ["Updated", "memory"],
  "memory.note": ["Saved", "notes"],
  "memory.list": ["Listed", "memories"],
  "memory.edit": ["Edited", "memory"],
  "memory.delete": ["Deleted", "memory"],
  "mode.switch": ["Switched", "modes"],
  "skill.use": ["Loaded", "skills"],
  "skill.read": ["Read", "skills"],
  "rule.list": ["Listed", "rules"],
  "rule.read": ["Read", "rules"],
  "rule.create": ["Created", "rules"],
  "session.exportTrace": ["Exported", "trace"],
  "hooks.list": ["Listed", "hooks"],
  "hooks.create": ["Created", "hooks"],
  "hooks.update": ["Updated", "hooks"],
  "hooks.delete": ["Deleted", "hooks"],
  "git.stage": ["Staged", "changes"],
  "git.commit": ["Committed", "changes"],
  "git.push": ["Pushed", "commits"],
  "git.branch": ["Managed", "branches"],
  "git.pr": ["Managed", "pull requests"],
};
const TOOL_PREFIX_PHRASES: [string, ToolPhrase][] = [
  ["browser.", ["Used", "the browser"]],
  ["notebook.", ["Edited", "notebooks"]],
  ["git.", ["Inspected", "git"]],
  ["wait.", ["Waited", ""]],
];
export function toolPhrasePair(name: string | undefined): ToolPhrase | undefined {
  if (!name) return undefined;
  if (TOOL_PHRASES[name]) return TOOL_PHRASES[name];
  for (const [prefix, pair] of TOOL_PREFIX_PHRASES) {
    if (name.startsWith(prefix)) return pair;
  }
  return undefined;
}
function labelOf(p: ToolPhrase): string {
  return p[1] ? `${p[0]} ${p[1]}` : p[0];
}
export function describeTool(step: ProcessStep): string | undefined {
  const visit = (s: ProcessStep): ToolPhrase | undefined => {
    const p = toolPhrasePair(s.toolName);
    if (p) return p;
    for (const c of s.children ?? []) {
      const d = visit(c);
      if (d) return d;
    }
    return undefined;
  };
  const p = visit(step);
  return p ? labelOf(p) : undefined;
}
function rankToolPairs(steps: ProcessStep[]): ToolPhrase[] {
  const counts = new Map<string, { pair: ToolPhrase; n: number }>();
  const visit = (s: ProcessStep): void => {
    const p = toolPhrasePair(s.toolName);
    if (p) {
      const key = labelOf(p);
      const e = counts.get(key);
      if (e) e.n += 1;
      else counts.set(key, { pair: p, n: 1 });
    }
    for (const c of s.children ?? []) visit(c);
  };
  for (const s of steps) visit(s);
  return [...counts.values()].sort((a, b) => b.n - a.n).map((e) => e.pair);
}
export function joinToolPhrases(a: ToolPhrase, b?: ToolPhrase): string {
  if (!b) return labelOf(a);
  const [v1, o1] = a;
  const [v2, o2] = b;
  if (o1 && o2 && o1 === o2) return `${v1} and ${v2.toLowerCase()} ${o1}`;
  if (v1 === v2) return o2 ? `${v1} ${o1} and ${o2}` : labelOf(a);
  if (!o2) return `${v1} ${o1} and ${v2.toLowerCase()}`;
  return `${v1} ${o1} and ${v2.toLowerCase()} ${o2}`;
}
export function topToolSummaries(steps: ProcessStep[], max = 2): string[] {
  const ranked = rankToolPairs(steps).slice(0, max);
  return ranked.map((p, i) => (i === 0 ? labelOf(p) : labelOf(p)));
}
export function groupSummaryFor(steps: ProcessStep[], mode: GroupSummaryMode, fallback = "Called"): string {
  if (steps.length <= 0 || mode !== "tools") return fallback;
  const ranked = rankToolPairs(steps);
  if (!ranked.length) return fallback;
  const label = joinToolPhrases(ranked[0], ranked[1]);
  return label.length > GROUP_SUMMARY_MAX_CHARS ? `${label.slice(0, GROUP_SUMMARY_MAX_CHARS - 1)}...` : label;
}
export async function llmGroupSummary(
  registry: ModelRegistry,
  titles: string[],
  proxyUrl?: string,
): Promise<string | undefined> {
  const candidates: ModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const tier of ["free", "light"] as const) {
    for (const m of registry.list()) {
      if (m.tier !== tier || seen.has(m.id)) continue;
      if (pickProvider(registry, m)) {
        seen.add(m.id);
        candidates.push(m);
      }
    }
  }
  if (!candidates.length || !titles.length) return undefined;
  const bulletList = titles.slice(0, 60).map((t) => `- ${t}`).join("\n");
  const prompt: ChatMessage[] = [
    {
      id: randomUUID(),
      role: "system",
      content: `Summarize what the assistant did in this tool-call chain in at most 6 words (under 50 characters). Use a plain past-tense phrase like "Read auth module and fixed routes". No punctuation at the end, no quotes, no explanation. HARD LIMIT: your entire reply must be 50 characters or fewer.`,
      ts: Date.now(),
    },
    { id: randomUUID(), role: "user", content: `Tool calls:\n${bulletList}`, ts: Date.now() },
  ];
  for (const model of candidates) {
    const decision = pickProvider(registry, model);
    if (!decision) continue;
    try {
      const transport = transportFor(decision.provider);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 10_000);
      try {
        const stream = await transport.stream({ model, provider: decision.provider, messages: prompt, signal: abort.signal, proxyUrl });
        let out = "";
        for await (const ev of stream.events) {
          if (ev.type === "text") out += ev.delta;
          if (ev.type === "error" || ev.type === "done") break;
        }
        const text = out.trim().replace(/^["'\s]+|["'\s.]+$/g, "").split("\n")[0].trim();
        if (!text) continue;
        return text.length > GROUP_SUMMARY_MAX_CHARS ? `${text.slice(0, GROUP_SUMMARY_MAX_CHARS - 1)}...` : text;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      continue;
    }
  }
  return undefined;
}