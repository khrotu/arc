import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDifficultyModel, estimateDifficulty } from "../src/model-router/tfidf.js";
import { routePrompt, tierFallbackScore, qualityForPreset, ROUTER_QUALITY_PRESETS } from "../src/model-router/model-router.js";
import { loadCalibrationModel, loadCapabilityModel, requiredScore } from "../src/model-router/calibration.js";
import { loadDomainModel, classifyDomain, domainScores } from "../src/model-router/domain.js";
import { lookupIntelligence, matchIntelligence, setAAList, getAAList, consolidateOpenRouterModels, ensureAAList, type AAModel } from "../src/model-router/aa.js";
import type { DifficultyModel } from "../src/model-router/tfidf.js";
import type { CalibrationModel, CapabilityModel } from "../src/model-router/calibration.js";
import type { DomainModel, DomainModelJson } from "../src/model-router/domain.js";
const RES = path.resolve(__dirname, "..", "..", "arc", "resources", "router");
const MODEL_PATH = path.join(RES, "difficulty.json");
function loadModel(): DifficultyModel {
  return loadDifficultyModel(JSON.parse(fs.readFileSync(MODEL_PATH, "utf8")) as DifficultyModel);
}
function loadCalib(): CalibrationModel {
  return loadCalibrationModel(JSON.parse(fs.readFileSync(path.join(RES, "calibration.json"), "utf8")) as CalibrationModel);
}
function loadCaps(): CapabilityModel {
  return loadCapabilityModel(JSON.parse(fs.readFileSync(path.join(RES, "capability.json"), "utf8")) as CapabilityModel);
}
function loadDomains(): DomainModel {
  return loadDomainModel(JSON.parse(fs.readFileSync(path.join(RES, "domain.json"), "utf8")) as DomainModelJson);
}
const REFERENCES: Array<[string, number]> = [
  ["explain what a monad is in Haskell", 0.43506],
  ["add a try catch around this async call", 0.28396],
  ["what is 2+2", 0.86873],
  ["refactor this class to use dependency injection", 0.29538],
  ["write a quick hello world", 0.42288],
  ["fix the null pointer in the payment service and add tests", 0.25549],
  ["int x = 5;", 0.29774],
  ["why did the tests fail after i changed the mock", 0.44061],
  ["migrate the database schema and write a rollback script", 0.25825],
  ["translate this docstring to french", 0.32485],
  ["prove that the square root of 2 is irrational", 0.54061],
  ["rename the variable and update all usages", 0.16822],
  ["create a react component that fetches data", 0.39005],
  ["this prompt has nothing to do with code at all really", 0.25277],
  ["explain the difference between tcp and udp sockets", 0.22334],
];
describe("router tfidf", () => {
  it("reproduces sklearn difficulty probabilities", () => {
    const model = loadModel();
    for (const [text, ref] of REFERENCES) {
      const mine = estimateDifficulty(text, model);
      expect(Math.abs(mine - ref)).toBeLessThan(1e-4);
    }
  });
});
describe("router policy", () => {
  const fleet = [
    { modelId: "free", score: 20, cost: 0.1 },
    { modelId: "light", score: 30, cost: 1 },
    { modelId: "default", score: 45, cost: 10 },
    { modelId: "heavy", score: 60, cost: 100 },
  ];
  it("escalates quality bias for an easy prompt", () => {
    const model = loadModel();
    const easy = "what is 2+2"; 
    expect(routePrompt(easy, model, fleet, { qualityBias: "prefer-cheap" }).modelId).toBe("free");
    expect(routePrompt(easy, model, fleet, { qualityBias: "off" }).modelId).toBe("free");
    expect(routePrompt(easy, model, fleet, { qualityBias: "prefer-powerful" }).modelId).toBe("light");
  });
  it("picks the cheapest clearing model for a hard prompt", () => {
    const model = loadModel();
    const hard = "prove that the square root of 2 is irrational"; 
    expect(routePrompt(hard, model, fleet, { qualityBias: "off" }).modelId).toBe("default");
    const d = routePrompt(hard, model, fleet, { qualityBias: "off" });
    expect(d.scored).toBeGreaterThanOrEqual(d.requiredScore);
    expect(routePrompt(hard, model, fleet, { qualityBias: "prefer-cheap" }).modelId).toBe("light");
  });
  it("never exceeds the strongest fleet model", () => {
    const model = loadModel();
    const tiny = [{ modelId: "light", score: 25, cost: 1 }];
    expect(routePrompt("some prompt", model, tiny, { qualityBias: "prefer-powerful" }).modelId).toBe("light");
  });
  it("breaks cost ties toward the weakest sufficient model", () => {
    const model = loadModel();
    const ties = [
      { modelId: "a", score: 20, cost: 0 },
      { modelId: "b", score: 30, cost: 0 },
      { modelId: "c", score: 40, cost: 0 },
    ];
    expect(routePrompt("what is 2+2", model, ties, { qualityBias: "prefer-cheap" }).modelId).toBe("a");
    expect(routePrompt("prove that the square root of 2 is irrational", model, ties, { qualityBias: "off" }).modelId).toBe("c");
  });
  it("falls back to the strongest model when nothing clears the bar", () => {
    const model = loadModel();
    const weak = [
      { modelId: "x", score: 8, cost: 0 },
      { modelId: "y", score: 12, cost: 0 },
    ];
    expect(routePrompt("what is 2+2", model, weak, { qualityBias: "off" }).modelId).toBe("y");
  });
  it("falls back by tier for unknown models", () => {
    expect(tierFallbackScore("heavy")).toBeGreaterThan(tierFallbackScore("default"));
    expect(tierFallbackScore("default")).toBeGreaterThan(tierFallbackScore("light"));
    expect(tierFallbackScore("light")).toBeGreaterThan(tierFallbackScore("free"));
  });
});
describe("router quality preset", () => {
  it("merges bias + quality into one understandable preset", () => {
    expect(ROUTER_QUALITY_PRESETS.balanced.bias).toBe("off");
    expect(ROUTER_QUALITY_PRESETS.balanced.qualityDelta).toBe(0);
    expect(ROUTER_QUALITY_PRESETS.economy.bias).toBe("prefer-cheap");
    expect(ROUTER_QUALITY_PRESETS.power.bias).toBe("prefer-powerful");
  });
  it("qualityForPreset is monotone in power and clamped to [0.6, 0.95]", () => {
    const qEco = qualityForPreset("economy", "high");
    const qBal = qualityForPreset("balanced", "high");
    const qPow = qualityForPreset("power", "high");
    expect(qEco).toBeLessThan(qBal);
    expect(qBal).toBeLessThan(qPow);
    for (const p of ["balanced", "economy", "power"] as const) {
      expect(qualityForPreset(p, "max")).toBeLessThanOrEqual(0.95);
      expect(qualityForPreset(p, "none")).toBeGreaterThanOrEqual(0.6);
    }
  });
});
describe("router v2 calibration", () => {
  it("produces a graded, domain-aware required score", () => {
    const calib = loadCalib();
    const caps = loadCaps();
    const easy = requiredScore(0.85, "code", calib, caps, 0.8);
    const hard = requiredScore(0.1, "code", calib, caps, 0.8);
    expect(hard).toBeGreaterThan(easy);
    const agenticMod = requiredScore(0.5, "agentic", calib, caps, 0.8);
    const codeMod = requiredScore(0.5, "code", calib, caps, 0.8);
    expect(agenticMod).toBeGreaterThanOrEqual(codeMod);
    expect(requiredScore(0.5, "reasoning", calib, caps, 0.9)).toBeGreaterThanOrEqual(
      requiredScore(0.5, "reasoning", calib, caps, 0.7),
    );
    const g = requiredScore(0.5, "general", calib, caps, 0.8);
    expect(g).toBeGreaterThanOrEqual(14);
    expect(g).toBeLessThanOrEqual(63);
  });
  it("classifies prompts into domains", () => {
    const dom = loadDomains();
    const code = classifyDomain("fix the null pointer in the payment service and add tests", dom);
    expect(dom.classes).toContain(code);
    const agentic = classifyDomain("book a flight from new york to london for next friday and confirm the total", dom);
    expect(agentic).toBe("agentic");
    expect(domainScores("what is 2+2", dom)).toBeTruthy();
  });
  it("is latency/health aware when scores are tied", () => {
    const model = loadModel();
    const calib = loadCalib();
    const caps = loadCaps();
    const ctx = { calibration: calib, capability: caps };
    const fleet = [
      { modelId: "slow-weak", score: 45, cost: 0, latencyMs: 11000, health: 100 },
      { modelId: "fast-strong", score: 48, cost: 0, latencyMs: 2000, health: 100 },
      { modelId: "fast-weak", score: 40, cost: 0, latencyMs: 1500, health: 100 },
    ];
    const easy = routePrompt("what is 2+2", model, fleet, ctx, { quality: 0.8 });
    expect(easy.modelId).toBe("fast-weak");
    const hard = routePrompt("implement a garbage collector with precise stack scanning and handle all edge cases", model, fleet, ctx, { quality: 0.8 });
    expect(hard.requiredScore).toBeGreaterThan(45);
    expect(hard.modelId).toBe("fast-strong");
  });
  it("down-ranks unhealthy (flaky) models", () => {
    const model = loadModel();
    const ctx = { calibration: loadCalib(), capability: loadCaps() };
    const fleet = [
      { modelId: "healthy", score: 52, cost: 0, latencyMs: 2000, health: 100 },
      { modelId: "flaky", score: 60, cost: 0, latencyMs: 2000, health: 8 },
    ];
    const hard = routePrompt("implement a garbage collector with precise stack scanning and handle all edge cases", model, fleet, ctx, { quality: 0.8 });
    expect(hard.requiredScore).toBeGreaterThan(45);
    expect(hard.modelId).toBe("healthy");
  });
  it("excludes unscored models (score 0) from selection", () => {
    const model = loadModel();
    const ctx = { calibration: loadCalib(), capability: loadCaps() };
    const fleet = [
      { modelId: "unknown", score: 0, cost: 0 },
      { modelId: "real", score: 45, cost: 0 },
    ];
    const r = routePrompt("what is 2+2", model, fleet, ctx, { quality: 0.8 });
    expect(r.modelId).toBe("real");
  });
  it("per-user tau raises the bar", () => {
    const model = loadModel();
    const ctx = { calibration: loadCalib(), capability: loadCaps() };
    const fleet = [
      { modelId: "light", score: 34, cost: 0, latencyMs: 1500, health: 100 },
      { modelId: "strong", score: 52, cost: 0, latencyMs: 2500, health: 100 },
    ];
    const hard = "prove that the square root of 2 is irrational";
    const noTau = routePrompt(hard, model, fleet, ctx, { quality: 0.8 });
    const withTau = routePrompt(hard, model, fleet, ctx, { quality: 0.8, tau: 6 });
    expect(withTau.requiredScore).toBeGreaterThan(noTau.requiredScore);
  });
});
describe("router aa list", () => {
  const SEED: AAModel[] = [
    { name: "Claude Opus 5", slug: "claude-opus-5", provider: "anthropic", score: 63 },
    { name: "Claude Sonnet 5", slug: "claude-sonnet-5", provider: "anthropic", score: 55 },
    { name: "GLM 5.2", slug: "glm-5-2", provider: "z-ai", score: 53 },
    { name: "DeepSeek V4 Flash", slug: "deepseek-v4-flash", provider: "deepseek", score: 52 },
    { name: "Gemma 4 31B", slug: "gemma-4-31b", provider: "google", score: 30 },
    { name: "Nemotron 3 Nano", slug: "nemotron-3-nano", provider: "nvidia", score: 15 },
  ];
  beforeAll(() => {
    setAAList(SEED);
  });
  it("matches configured model ids and labels", () => {
    expect(lookupIntelligence("glm-5-2")?.score).toBe(53);
    expect(lookupIntelligence("deepseek-v4-flash")?.score).toBe(52);
    expect(lookupIntelligence("whatever", "Claude Opus 5")?.score).toBe(63);
    expect(lookupIntelligence("unknown-model")).toBeUndefined();
  });
  it("fuzzy-matches suffixed ids and approximate labels", () => {
    expect(matchIntelligence("gemma-4-31b-mr204qvj", "Gemma 4 31B")?.confidence).toBe(1);
    const nemotron = matchIntelligence("nemotron-3-nano-mqwcj2ru", "Nemotron 3 Nano");
    expect(nemotron?.entry.name).toBe("Nemotron 3 Nano");
    expect(nemotron!.confidence).toBeGreaterThan(0.5);
    const sonnet = matchIntelligence("claude-sonnet-4-5", "Claude Sonnet 4.5");
    expect(sonnet?.confidence).toBeGreaterThan(0.5);
  });
});
describe("openrouter consolidation", () => {
  const model = (id: string, name: string, aa: Record<string, number | null> | null) =>
    ({ id, name, created: 1788000000, ...(aa ? { benchmarks: { artificial_analysis: aa } } : {}) });
  const payload = (models: unknown[]) => JSON.stringify({ data: models });
  const FULL = { intelligence_index: 60, coding_index: 50, agentic_index: 40 };
  it("strips vendor prefixes, composes the weighted score, and sorts by score", () => {
    const rows = consolidateOpenRouterModels(payload([
      model("anthropic/claude-fable-5.1", "Anthropic: Claude Fable 5.1", FULL),
      model("z-ai/glm-5.3", "Z.ai: GLM 5.3", { intelligence_index: 59.5, coding_index: 55, agentic_index: 45 }),
      model("qwen/qwen3.8-27b", "Qwen: Qwen3.8 27B", { intelligence_index: 52 }),
    ]));
    expect(rows.map((r) => ({ name: r.name, slug: r.slug, provider: r.provider, score: r.score }))).toEqual([
      { name: "GLM 5.3", slug: "glm-5.3", provider: "z-ai", score: 54.3 },
      { name: "Claude Fable 5.1", slug: "claude-fable-5.1", provider: "anthropic", score: 52 },
      { name: "Qwen3.8 27B", slug: "qwen3.8-27b", provider: "qwen", score: 52 },
    ]);
    expect(rows[0].aa).toEqual({ intelligence: 59.5, coding: 55, agentic: 45 });
  });
  it("agentic outweighs coding at equal intelligence", () => {
    const rows = consolidateOpenRouterModels(payload([
      model("a/coder", "A: Coder", { intelligence_index: 60, coding_index: 70, agentic_index: 30 }),
      model("b/agent", "B: Agent", { intelligence_index: 60, coding_index: 30, agentic_index: 70 }),
    ]));
    const agent = rows.find((r) => r.slug === "agent");
    const coder = rows.find((r) => r.slug === "coder");
    expect(agent!.score!).toBeGreaterThan(coder!.score!);
  });
  it("renormalizes when component indexes are missing", () => {
    const rows = consolidateOpenRouterModels(payload([
      model("a/intel-only", "A: Intel Only", { intelligence_index: 50 }),
      model("b/partial", "B: Partial", { intelligence_index: 50, coding_index: 40 }),
    ]));
    expect(rows.find((r) => r.slug === "intel-only")!.score).toBe(50);
    expect(rows.find((r) => r.slug === "partial")!.score).toBe(47.1);
  });
  it("keeps paid and free variants as separate rows, skips unscored and malformed rows", () => {
    const rows = consolidateOpenRouterModels(payload([
      model("z-ai/glm-5.3:batch", "Z.ai: GLM 5.3 (batch)", FULL),
      model("z-ai/glm-5.3:free", "Z.ai: GLM 5.3 (free)", FULL),
      model("z-ai/glm-5.3", "Z.ai: GLM 5.3", FULL),
      model("x/unscored", "X: Unscored", null),
      model("x/noindexes", "X: No Indexes", { design_arena: 1 }),
      model("nopercent", "No Slash", FULL),
      { id: "x/no-name", benchmarks: { artificial_analysis: { intelligence_index: 50 } } },
    ]));
    expect(rows.map((r) => r.slug)).toEqual(["glm-5.3", "glm-5.3:batch", "glm-5.3:free", "no-name"]);
  });
  it("keeps the highest score when names collide", () => {
    const rows = consolidateOpenRouterModels(payload([
      model("a/alpha", "A: Alpha", { intelligence_index: 40 }),
      model("b/alpha-2", "B: Alpha", { intelligence_index: 44.5 }),
    ]));
    expect(rows.map((r) => ({ slug: r.slug, provider: r.provider, score: r.score }))).toEqual([
      { slug: "alpha-2", provider: "b", score: 44.5 },
    ]);
  });
  it("rejects non-array payloads", () => {
    expect(() => consolidateOpenRouterModels(JSON.stringify({ data: "nope" }))).toThrow();
  });
});
describe("aa live loader", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-aa-"));
  const SEED_MODELS: AAModel[] = [{ name: "Claude Opus 5", slug: "claude-opus-5", provider: "anthropic", score: 63 }];
  const FILLER = Array.from({ length: 60 }, (_, i) => ({ id: `v${i}/m${i}`, name: `V: M${i}`, created: 1788000000, benchmarks: { artificial_analysis: { intelligence_index: 10 + i / 10 } } }));
  const FIXTURE = JSON.stringify({ data: [...FILLER, { id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5", created: 1788000000, benchmarks: { artificial_analysis: { intelligence_index: 63 } } }] });
  const fetchOk = (body: string): typeof fetch =>
    (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  it("fetches and caches the model list", async () => {
    const d = dir();
    let calls = 0;
    const impl = (async () => { calls++; return new Response(FIXTURE, { status: 200 }); }) as unknown as typeof fetch;
    expect(await ensureAAList({ fetchImpl: impl, dir: d })).toBe(true);
    expect(calls).toBe(1);
    expect(lookupIntelligence("claude-opus-5")?.score).toBe(63);
    const cache = JSON.parse(fs.readFileSync(path.join(d, "aa-scores.json"), "utf8")) as { models: AAModel[]; fetched: number };
    expect(cache.models.length).toBeGreaterThan(50);
  });
  it("serves a fresh cache without refetching", async () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "aa-scores.json"), JSON.stringify({ fetched: Date.now(), models: SEED_MODELS }));
    expect(await ensureAAList({ fetchImpl: fetchOk(FIXTURE), dir: d })).toBe(false);
    expect(lookupIntelligence("claude-opus-5")?.score).toBe(63);
  });
  it("refreshes a stale cache and keeps data on fetch failure", async () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "aa-scores.json"), JSON.stringify({ fetched: Date.now() - 8 * 24 * 60 * 60 * 1000, models: SEED_MODELS }));
    const fail = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await ensureAAList({ fetchImpl: fail, dir: d })).toBe(false);
    expect(lookupIntelligence("claude-opus-5")?.score).toBe(63);
    expect(await ensureAAList({ fetchImpl: fetchOk(FIXTURE), dir: d })).toBe(true);
    expect(lookupIntelligence("claude-opus-5")?.score).toBe(63);
  });
  it("starts empty and stays empty when nothing ever loads", async () => {
    setAAList([]);
    const d = dir();
    expect(await ensureAAList({ fetchImpl: fetchOk("{}"), dir: d })).toBe(false);
    expect(getAAList()).toEqual([]);
    expect(lookupIntelligence("claude-opus-5")).toBeUndefined();
  });
  it("dedupes concurrent refreshes", async () => {
    const d = dir();
    let resolveFetch: (v: Response) => void;
    const gate = new Promise<Response>((r) => { resolveFetch = r as (v: Response) => void; });
    let calls = 0;
    const impl = (async () => { calls++; return gate; }) as unknown as typeof fetch;
    const a = ensureAAList({ fetchImpl: impl, dir: d });
    const b = ensureAAList({ fetchImpl: impl, dir: d });
    resolveFetch!(new Response(FIXTURE, { status: 200 }));
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(calls).toBe(1);
  });
});