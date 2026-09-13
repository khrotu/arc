export interface CalibrationModel {
  v: number;
  type: string;
  edges: number[];
  bars_by_q: Record<string, number[]>;
  default_q: number;
  ling_score: number;
  weak_score: number;
  strong_score: number;
}
export interface DomainBars {
  edges: number[];
  bars_by_q: Record<string, number[]>;
}
export interface CapabilityModel {
  v: number;
  domains: string[];
  default_q: number;
  anchor_scores: number[];
  bars: Record<string, DomainBars>;
}
export function loadCalibrationModel(json: CalibrationModel): CalibrationModel {
  if (!json || typeof json !== "object") throw new Error("Invalid calibration model.");
  if (!Array.isArray(json.edges) || json.edges.length === 0 || !json.edges.every(Number.isFinite)) {
    throw new Error("Invalid calibration model: bad edges.");
  }
  if (!json.bars_by_q || typeof json.bars_by_q !== "object") throw new Error("Invalid calibration model: bad bars.");
  for (const bars of Object.values(json.bars_by_q)) {
    if (!Array.isArray(bars) || bars.length !== json.edges.length || !bars.every(Number.isFinite)) {
      throw new Error("Invalid calibration model: bad bars entry.");
    }
  }
  for (const k of ["default_q", "ling_score", "weak_score", "strong_score"] as const) {
    if (!Number.isFinite(json[k])) throw new Error(`Invalid calibration model: bad ${k}.`);
  }
  return json;
}
export function loadCapabilityModel(json: CapabilityModel): CapabilityModel {
  if (!json || typeof json !== "object") throw new Error("Invalid capability model.");
  if (!Array.isArray(json.domains)) throw new Error("Invalid capability model: bad domains.");
  if (!Array.isArray(json.anchor_scores) || !json.anchor_scores.every(Number.isFinite)) {
    throw new Error("Invalid capability model: bad anchor scores.");
  }
  if (!json.bars || typeof json.bars !== "object") throw new Error("Invalid capability model: bad bars.");
  for (const [name, dom] of Object.entries(json.bars)) {
    if (!dom || !Array.isArray(dom.edges) || dom.edges.length === 0 || !dom.edges.every(Number.isFinite)) {
      throw new Error(`Invalid capability model: bad edges for '${name}'.`);
    }
    if (!dom.bars_by_q || typeof dom.bars_by_q !== "object") throw new Error(`Invalid capability model: bad bars for '${name}'.`);
  }
  if (!Number.isFinite(json.default_q)) throw new Error("Invalid capability model: bad default_q.");
  return json;
}
function interp(x: number, xs: number[], ys: number[]): number {
  if (xs.length === 0 || ys.length === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}
function barsFor(calibOrBars: CalibrationModel | DomainBars, q?: number): number[] {
  const defaultQ = (calibOrBars as CalibrationModel).default_q ?? 0.8;
  const byQ = (calibOrBars as CalibrationModel).bars_by_q ?? (calibOrBars as DomainBars).bars_by_q;
  const key = String(q ?? defaultQ);
  return byQ[key] ?? byQ[String(defaultQ)] ?? byQ["0.8"] ?? byQ["0.9"] ?? [];
}
export function requiredScore(
  d: number,
  domain: string | undefined,
  calibration: CalibrationModel | undefined,
  capability: CapabilityModel | undefined,
  q?: number,
): number {
  if (capability && domain && capability.domains.includes(domain)) {
    const dom = capability.bars[domain];
    const bars = barsFor(dom, q);
    if (bars.length) return interp(d, dom.edges, bars);
  }
  if (calibration) {
    const bars = barsFor(calibration, q);
    if (bars.length) return interp(d, calibration.edges, bars);
  }
  const lo = calibration?.ling_score ?? 14;
  const hi = calibration?.strong_score ?? 51;
  return lo + (hi - lo) * (1 - d);
}