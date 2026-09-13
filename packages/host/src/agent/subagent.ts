import { Agent, type AgentEventSink, type AgentOptions } from "./agent.js";
import { ModelRegistry } from "../routing/registry.js";
import { CheckpointStore } from "../checkpoint/store.js";
import { pickForTier } from "../routing/router.js";
import { subagentTierFor } from "../routing/handoff.js";
import { ModeRegistry } from "../modes/index.js";
import { DEFAULT_APPROVALS } from "../approvals/index.js";
import * as tools from "./tools.js";
import type { ModelDescriptor, ModelTier } from "../protocol/protocol.js";
import type { ProcessStep, TodoItem } from "../protocol/process.js";
export interface SubagentRules {
  blockedCommands?: string[];
  requireApproval?: boolean;
}
export interface SubagentSpec {
  name: string;
  instructions: string;
  tier?: ModelTier;
  modelId?: string;
  rules?: SubagentRules;
}
export interface SubagentResult {
  ok: boolean;
  output: string;
  steps: ProcessStep[];
  todo: TodoItem[];
  model?: { id: string; label: string };
}
const WRAPPER_COMMANDS = new Set(["sudo", "doas", "su", "runas", "env", "nice", "timeout", "stdbuf", "unshare", "chroot", "npx", "sh", "bash", "zsh", "fish", "pwsh", "powershell", "cmd"]);
function splitFirst(s: string): { first: string; rest: string } {
  let t = s.trim();
  for (;;) {
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]*)\s+/);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  let first: string;
  let rest: string;
  if (t[0] === '"' || t[0] === "'") {
    const close = t.indexOf(t[0], 1);
    first = close > 0 ? t.slice(1, close) : t.slice(1);
    rest = close > 0 ? t.slice(close + 1).trim() : "";
  } else {
    first = t.split(/[\s;|&]+/)[0] ?? "";
    first = first.replace(/^["']|["']$/g, "");
    rest = first ? t.slice(t.indexOf(first) + first.length).trim() : "";
    if (t.indexOf(first) < 0) rest = "";
  }
  return { first, rest };
}
function cleanBase(first: string): string {
  return ((first.split(/[\\/]/).pop() ?? first).toLowerCase().replace(/\.exe$/, ""));
}
function stripWrapperArgs(s: string): string {
  let rest = s.replace(/^[-/]c\s+/i, "").trim();
  rest = rest.replace(/^((-[a-zA-Z]+\s+[^\s-][^\s]*|--\s+|\d[\d.]*(ms|s|m|h|d)?)\s+|(-[a-zA-Z]+|--[a-zA-Z0-9][\w-]*)(?=\s|$)\s*)+/, "").trim();
  if ((rest[0] === '"' || rest[0] === "'") && rest.length > 1) {
    const close = rest.indexOf(rest[0], 1);
    rest = (close > 0 ? rest.slice(1, close) : rest.slice(1)).trim();
  }
  return rest;
}
export function baseCommand(cmd: string): string {
  const chain = commandChain(cmd);
  return chain.length > 0 ? chain[chain.length - 1] : "";
}
export function commandChain(cmd: string): string[] {
  const chain: string[] = [];
  let s = cmd.trim();
  for (let depth = 0; depth < 8 && s; depth++) {
    const { first, rest } = splitFirst(s);
    if (!first) break;
    const base = cleanBase(first);
    if (!base) break;
    chain.push(base);
    if (!WRAPPER_COMMANDS.has(base)) break;
    const next = stripWrapperArgs(rest);
    if (!next || next === s) break;
    s = next;
  }
  return chain;
}
export class SubagentRunner {
  constructor(
    private registry: ModelRegistry,
    private store: CheckpointStore,
    private modeRegistry?: ModeRegistry,
  ) {}
  async run(
    spec: SubagentSpec,
    parent: ModelDescriptor,
    ctx: AgentOptions["toolContext"] & { root: string; shell?: { policy: "always" | "allowlist" | "off"; allowlist: string[] }; requestApproval?: (description: string, meta?: import("../approvals/index.js").ApproveShellMeta) => Promise<boolean> } & { approvalsConfig?: import("../approvals/index.js").ApprovalsConfig; sessionApprovals?: import("../approvals/index.js").SessionApprovals; conversationId?: string },
    askParent?: (question: string, options: string[]) => Promise<string>,
    onStep?: (steps: ProcessStep[]) => void,
    onApprovalRequest?: (description: string) => void,
    onUsage?: (usage: { prompt: number; completion: number; cost: number }) => void,
  ): Promise<SubagentResult> {
    const childParent = askParent
      ? ({ askFromSubagent: (q: string, o: string[]) => askParent(q, o) } as unknown as Agent)
      : undefined;
    const tier = spec.tier ?? subagentTierFor(parent);
    const model = spec.modelId ? this.registry.get(spec.modelId) : pickForTier(this.registry, tier);
    if (!model) {
      return { ok: false, output: `No model available for tier ${tier}.`, steps: [], todo: [] };
    }
    if (!this.registry.providersFor(model.id).length) {
      return { ok: false, output: `Model ${model.label} has no enabled providers.`, steps: [], todo: [] };
    }
    const collected: ProcessStep[] = [];
    const todos: TodoItem[] = [];
    const sink: AgentEventSink = {
      message: () => {},
      assistantDelta: () => {},
      steps: (steps) => {
        collected.length = 0;
        collected.push(...steps);
        onStep?.(steps);
      },
      turnStart: () => {},
      turnEnd: () => {},
      usage: () => {},
      handoff: () => {},
      todo: (items) => { todos.length = 0; todos.push(...items); },
      clarification: () => {},
      done: () => {},
      error: () => {},
      compaction: () => {},
      guidance: () => {},
      timeline: () => {},
    };
    const rules = spec.rules ?? {};
    const blockedChains = (rules.blockedCommands ?? []).map((r) => commandChain(r).filter(Boolean)).filter((c) => c.length > 0);
    const needsApproval = rules.requireApproval ?? false;
    const toolContext = {
      ...ctx,
      requestApproval: async (description: string, meta?: import("../approvals/index.js").ApproveShellMeta): Promise<boolean> => {
        onApprovalRequest?.(description);
        const rawCmd = meta?.command ?? description.split("\n\n")[1] ?? "";
        const chain = commandChain(rawCmd);
        const blocked = blockedChains.some((rule) =>
          rule.length === 1 ? chain.includes(rule[0]) : chain.length >= rule.length && rule.every((c, i) => chain[i] === c),
        );
        if (blocked) {
          return false;
        }
        if (!ctx.requestApproval) return false;
        const prefix = needsApproval ? "Subagent requires approval" : "Subagent requested a privileged operation";
        return ctx.requestApproval(`${prefix} (${spec.name}):\n\n${description}`, meta);
      },
    };
    const baseApprovals = ctx.approvalsConfig ?? DEFAULT_APPROVALS;
    const childApprovals = {
      ...baseApprovals,
      "write.local": "ask" as const,
      "write.external": "ask" as const,
      "shell.safe": "ask" as const,
      "shell.other": "ask" as const,
      browser: "ask" as const,
      "code.execute": "ask" as const,
      subagent: "ask" as const,
      mcp: { default: "ask" as const, perServer: {} },
    };
    const modeReg = this.modeRegistry ?? new ModeRegistry(ctx.root);
    const agent = new Agent(this.registry, this.store, sink, {
      systemPrompt: spec.instructions,
      enabledTools: new Set([...Object.keys(tools.tools), "subagent.askParent"]),
      workspaceRoot: ctx.root,
      mode: "code",
      modeRegistry: modeReg,
      approvalsConfig: childApprovals,
      initialSessionApprovals: ctx.sessionApprovals,
      conversationId: ctx.conversationId,
      isMain: false,
      ownerTier: tier,
      parent: childParent,
      toolContext,
      modelOverride: model,
      proxyUrl: toolContext.proxyUrl,
      proxyProvider: toolContext.proxyProvider,
    });
    await agent.send(spec.instructions);
    const usage = agent.getUsage();
    if (onUsage) {
      let prompt = 0;
      let completion = 0;
      let cost = 0;
      for (const u of Object.values(usage)) {
        prompt += u.prompt ?? 0;
        completion += u.completion ?? 0;
        cost += u.cost ?? 0;
      }
      onUsage({ prompt, completion, cost });
    }
    const all = agent.getMessages();
    const assistantTexts = all.filter((m) => m.role === "assistant" && m.content?.trim()).map((m) => m.content);
    let finalText = assistantTexts.length ? assistantTexts[assistantTexts.length - 1] : "";
    if (!finalText) {
      const toolOuts = all.filter((m) => m.role === "tool" && m.content?.trim()).map((m) => m.content);
      const last = toolOuts.length ? toolOuts[toolOuts.length - 1] : "";
      finalText = last ? `(no summary; last tool output)\n${last.slice(0, 2000)}` : "(subagent produced no output)";
    }
    return { ok: true, output: finalText, steps: collected, todo: todos, model: { id: model.id, label: model.label } };
  }
  async runBatch(
    specs: SubagentSpec[],
    parent: ModelDescriptor,
    ctx: AgentOptions["toolContext"] & { root: string; shell?: { policy: "always" | "allowlist" | "off"; allowlist: string[] }; requestApproval?: (description: string, meta?: import("../approvals/index.js").ApproveShellMeta) => Promise<boolean> } & { approvalsConfig?: import("../approvals/index.js").ApprovalsConfig; sessionApprovals?: import("../approvals/index.js").SessionApprovals; conversationId?: string },
    askParent?: (question: string, options: string[]) => Promise<string>,
    onStep?: (steps: ProcessStep[]) => void,
    onApprovalRequest?: (description: string) => void,
    onUsage?: (usage: { prompt: number; completion: number; cost: number }) => void,
  ): Promise<SubagentResult[]> {
    if (specs.length > 5) throw new Error(`runBatch supports at most 5 subagents (got ${specs.length}).`);
    return Promise.all(specs.map((spec) => this.run(spec, parent, ctx, askParent, onStep, onApprovalRequest, onUsage)));
  }
}