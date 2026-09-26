import type { DifficultyModel } from "./tfidf.js";
import { estimateDifficulty } from "./tfidf.js";
import type { CalibrationModel, CapabilityModel } from "./calibration.js";
import { requiredScore as calibratedBar } from "./calibration.js";
import type { DomainModel } from "./domain.js";
import { classifyDomain } from "./domain.js";
export type QualityBias = "off" | "prefer-cheap" | "prefer-powerful";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const BIAS_OFFSET: Record<QualityBias, number> = {
  "prefer-cheap": -4,
  off: 0,
  "prefer-powerful": 4,
};
export const EFFORT_TO_QUALITY: Record<ReasoningEffort, number> = {
  none: 0.6, minimal: 0.7, low: 0.75, medium: 0.8, high: 0.85, xhigh: 0.9, max: 0.95,
};
export function qualityForEffort(effort: ReasoningEffort): number {
  return EFFORT_TO_QUALITY[effort] ?? 0.8;
}
export type RouterQualityPreset = "balanced" | "economy" | "power";
export const ROUTER_QUALITY_PRESETS: Record<RouterQualityPreset, { bias: QualityBias; qualityDelta: number }> = {
  economy: { bias: "prefer-cheap", qualityDelta: -0.05 },
  balanced: { bias: "off", qualityDelta: 0 },
  power: { bias: "prefer-powerful", qualityDelta: 0.05 },
};
export function qualityForPreset(preset: RouterQualityPreset, effort: ReasoningEffort): number {
  const p = ROUTER_QUALITY_PRESETS[preset] ?? ROUTER_QUALITY_PRESETS.balanced;
  return Math.max(0.6, Math.min(0.95, qualityForEffort(effort) + p.qualityDelta));
}
const W_LATENCY = 0.35;
const W_HEALTH = 0.5;
const W_COST = 2.0;
export interface FleetModel {
  modelId: string;
  score: number;
  cost: number;
  latencyMs?: number;
  health?: number; 
}
export interface RouteDecision {
  modelId: string;
  requiredScore: number;
  difficulty: number;
  domain: string;
  confidence: number;
  scored: number;
  tau: number;
}
export interface RouteContext {
  calibration?: CalibrationModel;
  capability?: CapabilityModel;
  domainModel?: DomainModel;
}
export interface RouteOptions {
  qualityBias?: QualityBias;
  temperature?: number; 
  quality?: number; 
  tau?: number; 
}
function isRouteContext(x: unknown): x is RouteContext {
  const o = x as RouteContext | undefined;
  return !!o && (o.calibration !== undefined || o.capability !== undefined || o.domainModel !== undefined);
}
export function routePrompt(
  text: string,
  model: DifficultyModel,
  fleet: FleetModel[],
  ctxOrOpts: RouteContext | RouteOptions = {},
  opts: RouteOptions = {},
): RouteDecision {
  const ctx: RouteContext = isRouteContext(ctxOrOpts) ? ctxOrOpts : {};
  const options: RouteOptions = isRouteContext(ctxOrOpts) ? opts : (ctxOrOpts as RouteOptions);
  const d = estimateDifficulty(text, model);
  const domain = ctx.domainModel ? classifyDomain(text, ctx.domainModel) : "general";
  const tau = options.tau ?? 0;
  const q = options.quality ?? 0.8;
  const bias = options.qualityBias ?? "off";
  let bar = calibratedBar(d, domain, ctx.calibration, ctx.capability, q) + BIAS_OFFSET[bias] + tau;
  bar = Math.max(14, Math.min(63, bar));
  const usable = fleet.filter((m) => m.score > 0);
  if (!usable.length) {
    const fallback = fleet.length ? fleet[0] : { modelId: "", score: 0, cost: 0 };
    return { modelId: fallback.modelId, requiredScore: bar, difficulty: d, domain, confidence: 0, scored: fallback.score, tau };
  }
  let best: FleetModel | undefined;
  let bestU = Infinity;
  for (const m of usable) {
    const margin = m.score - bar;
    const latPen = W_LATENCY * ((m.latencyMs ?? 3000) / 1000);
    const health = m.health ?? 100;
    const healthPen = W_HEALTH * ((100 - health) / 10);
    const costPen = W_COST * (m.cost / 1000); 
    const u = margin >= 0
      ? margin + latPen + healthPen + costPen
      : 1000 + -margin + latPen + healthPen + costPen;
    if (u < bestU) {
      bestU = u;
      best = m;
    }
  }
  const chosen = best ?? usable.reduce((a, b) => (b.score > a.score ? b : a));
  const marginConf = Math.min(1, (chosen.score - bar) / 15);
  const clarity = Math.min(1, Math.abs(d - 0.5) * 2);
  const conf = Math.max(0, Math.min(1, 0.35 + 0.35 * marginConf + 0.3 * clarity));
  return {
    modelId: chosen.modelId,
    requiredScore: bar,
    difficulty: d,
    domain,
    confidence: conf,
    scored: chosen.score,
    tau,
  };
}
export function tierFallbackScore(tier: "free" | "light" | "default" | "heavy"): number {
  switch (tier) {
    case "heavy": return 60;
    case "default": return 45;
    case "light": return 30;
    default: return 20;
  }
}