import type { ModelDescriptor, ModelTier } from "../protocol/protocol.js";
import { pickForTier } from "../routing/router.js";
import type { ModelRegistry } from "../routing/registry.js";
export type HandoffDirection = "escalate" | "de-escalate";
export interface HandoffPolicy {
  maxEscalations: number;
  costCeiling: number;
  confidenceThreshold: number;
}
export const defaultPolicy: HandoffPolicy = {
  maxEscalations: 3,
  costCeiling: 5.0,
  confidenceThreshold: 0.4,
};
export interface HandoffRecord {
  turnId: string;
  direction: HandoffDirection;
  fromModelId: string;
  toModelId: string;
  reason: string;
  ts: number;
  costIncurred: number;
}
export function nextModelForHandoff(
  registry: ModelRegistry,
  current: ModelDescriptor,
  direction: HandoffDirection,
  policy: HandoffPolicy = defaultPolicy,
  history: HandoffRecord[] = [],
): ModelDescriptor | undefined {
  const escalations = history.filter((h) => h.direction === "escalate").length;
  if (direction === "escalate" && escalations >= Math.max(0, policy.maxEscalations)) return undefined;
  const spent = history.reduce((s, h) => s + (Number.isFinite(h.costIncurred) ? h.costIncurred : 0), 0);
  if (spent >= policy.costCeiling) return undefined;
  const prevFrom = history.length > 0 ? history[history.length - 1].fromModelId : undefined;
  const targetTier: ModelTier | undefined =
    direction === "escalate"
      ? current.tier === "free"
        ? "light"
        : current.tier === "light"
          ? "default"
          : current.tier === "default"
            ? "heavy"
            : undefined
      : current.tier === "heavy"
        ? "default"
        : current.tier === "default"
          ? "light"
          : current.tier === "light"
            ? "free"
            : undefined;
  if (!targetTier) return undefined;
  const candidate = pickForTier(registry, targetTier);
  if (!candidate) return undefined;
  const lastTs = history.length > 0 ? history[history.length - 1].ts : 0;
  if (candidate.id === prevFrom && Date.now() - lastTs < 60_000) return undefined;
  return candidate;
}
export function subagentTierFor(current: ModelDescriptor, hint?: ModelTier): ModelTier {
  if (hint) return hint;
  const ladder: ModelTier[] = ["heavy", "default", "light", "free"];
  const i = ladder.indexOf(current.tier);
  return ladder[Math.min(i + 1, ladder.length - 1)];
}