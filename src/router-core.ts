import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { CANONICAL_MODELS, findRampModels, type CanonicalMeta, type CanonicalScores, type CostTier, type ModelProfile, type RampMeta } from "./canonical-models.ts";
import { DEFAULT_QUOTA_CONFIG, filterPoolByQuotaPlanPrefix, QuotaState, type QuotaConfig } from "./quota.ts";

/**
 * Keep capability targets, effective cost, and reasoning effort independent: task difficulty sets
 * the quality floor, economics choose among qualifying variants, and benchmark effort configures the
 * selected provider call.
 */
export type Tier = "cheap" | "strong";
export type RouteClass = Tier | "model";
export type Confidence = "high" | "medium" | "low";
/** Which benchmark drives every model's capability + cost. The two are never merged; selection is wholesale. */
export type CapabilitySource = "aa" | "ramp";
export type CapabilityMode = "low" | "medium" | "high" | "ultra";
/** Task hardness, ordered. Sets how far up the capability frontier selection climbs (the willingness budget). */
export type Hardness = "trivial" | "normal" | "hard" | "max";
export const HARDNESS_ORDER: Hardness[] = ["trivial", "normal", "hard", "max"];
const CAPABILITY_MODE_ORDER: CapabilityMode[] = ["low", "medium", "high", "ultra"];
const HARDNESS_SCORE_BOUNDS: [number, number][] = [[0, 0.3], [0.3, 0.52], [0.52, 0.74], [0.74, 1]];
const MODE_SOLVE_BOUNDS: [number, number][] = [[0, 75], [75, 80], [80, 85], [85, 100]];

/** Choose provider reasoning: auto uses its measured model-effort variant; forced models honor Pi. */
export function routingReasoning(
  benchmarkEffort: ThinkingLevel | undefined,
  requestedReasoning: ThinkingLevel | undefined,
  forcedModel: boolean,
): ThinkingLevel | "off" {
  if (forcedModel) return requestedReasoning ?? benchmarkEffort ?? "off";
  return benchmarkEffort ?? requestedReasoning ?? "off";
}

/** Fallback capability numbers for models with no canonical match and no override. */
const FALLBACK_INTELLIGENCE = 25;
const FALLBACK_PRICE = 3;

export interface CanonicalResolution {
  canonical: CanonicalMeta | null;
  costTier: CostTier;
  capabilityMode?: CapabilityMode;
  profiles: ModelProfile[];
  frontier: boolean;
  intelligence: number;
  priceBlended: number;
  scores?: CanonicalScores;
  tps?: number;
  /** Pi-normalized effort used by the benchmark row backing this resolution, if known. */
  benchmarkEffort?: ThinkingLevel;
  /** Whether the active capability source has data for this model. Unsupported models are not auto-routed. */
  supported: boolean;
  confidence: Confidence;
  reason: string;
}

export interface ResolvedModel {
  model: Model<Api>;
  acceptsImage: boolean;
  canonicalKey: string | null;
  costTier: CostTier;
  capabilityMode?: CapabilityMode;
  profiles: ModelProfile[];
  frontier: boolean;
  /** Synthetic intelligence index; capability axis for `balanced`/fallback profiles. */
  intelligence: number;
  /** List price $/1M tokens (blended 3:1). The Pareto cost axis; NOT marginal/subscription cost. */
  priceBlended: number;
  scores?: CanonicalScores;
  tps?: number;
  /** Pi-normalized effort used by the benchmark row backing this routing variant, if known. */
  benchmarkEffort?: ThinkingLevel;
  /** Whether the active capability source covers this model (or a user override does). Drives auto-pool inclusion. */
  supported: boolean;
  confidence: Confidence;
  matchReason: string;
  /** Time-of-day shadow-price windows, carried through so the price can be re-evaluated per turn
   *  (see `repriceForTimeOfDay`) without rebuilding the pool. `priceBlended` here is time-neutral. */
  costCoefHours?: CostCoefWindow[];
}

export interface Pool {
  cheapPool: ResolvedModel[];
  strongPool: ResolvedModel[];
  standardPool: ResolvedModel[];
  unknownPool: ResolvedModel[];
  all: ResolvedModel[];
}

export interface ModelOverride {
  canonical?: string;
  costTier?: CostTier;
  capabilityMode?: CapabilityMode;
  profiles?: ModelProfile[];
  frontier?: boolean;
  intelligence?: number;
  priceBlended?: number;
  scores?: CanonicalScores;
  tps?: number;
  /** Override the benchmark-backed effort metadata for private or manually classified models. */
  benchmarkEffort?: ThinkingLevel;
  /**
   * Shadow-price coefficient: multiplies the model's base cost-axis price (Ramp cost-per-task under
   * `ramp`). It folds *my* economics into the shared capability frontier without touching the quality
   * axis, and stays dimensionless so it can never put the axis into a foreign unit. <1 = cheaper to me
   * than Ramp measured (an already-paid subscription, a discounted PAYG deal); >1 = pricier. Default 1
   * = pure Ramp. Keep a shared/finite subscription a *positive* shadow price, not ~0: a near-zero coef
   * makes an already-strong model dominate the whole frontier and starves the cheap PAYG floor.
   */
  costCoef?: number;
  /** Time-of-day multipliers stacked on `costCoef` (e.g. GLM burns 3× quota 14:00–18:00). */
  costCoefHours?: CostCoefWindow[];
}

export interface CostCoefWindow {
  /** [start, end) in local 24h hours; wraps when start > end (e.g. [22, 2] = 22:00–02:00). */
  hours: [number, number];
  factor: number;
}

export interface ModelFilter {
  include: string[];
  exclude: string[];
}

export interface RouterConfig {
  /** Which benchmark drives capability + cost. `ramp` (default) = real SWE-bench outcomes; `aa` = synthetic. Never merged. */
  capabilitySource: CapabilitySource;
  threshold: number;
  weights: {
    contextTokens: number;
    lastUserLen: number;
    toolDensity: number;
  };
  log: boolean;
  tierModels: Partial<Record<Tier, string>>;
  /** Restrict the automatically built pool by provider/id/name/canonical substring. Empty include means allow all. */
  modelFilter: ModelFilter;
  /** User-supplied metadata for unknown/private/local models. Keys may be provider/id, model id, or normalized model id. */
  modelOverrides: Record<string, ModelOverride>;
  /**
   * Willingness to pay for capability, by task hardness: the max extra list-price ($/1M) spent for
   * one more point of quality on the chosen axis. Selection walks the Pareto frontier from the
   * cheapest point upward, taking each step whose marginal $/quality-point is within budget — so the
   * hardness signal (driven by task content) positions us on the frontier and steep low-value
   * steps (a near-tie flagship at 2× price) are only taken at `max`. The single routing knob, axis-
   * agnostic. Raise a row to climb further for that hardness; `max: Infinity` = "top of frontier".
   */
  willingness: Record<Hardness, number>;
  /**
   * Cross-turn cache stickiness. Once a model has a warm prompt cache (a "lease"), switching to a
   * freshly-picked model pays a cache-write tax; we only switch when the economics win — cheaper warm
   * reads on a downgrade, or enough capability gain on an upgrade. Layered on top of the Pareto pick.
   */
  cacheAware: {
    enabled: boolean;
    /** Extra USD the downgrade's read savings must beat the switch tax by, before switching down. */
    downgradeMarginUsd: number;
    /** Minimum capability gain (axis points: resolve-rate / intelligence) to switch up. */
    upgradeQualityMargin: number;
    /** USD of switch tax that counts as one required extra quality point when upgrading. */
    upgradeTaxPenaltyScaleUsd: number;
    /** Minimum user turns between model switches. */
    minTurnsBetweenSwitches: number;
  };
  quota: QuotaConfig;
  classifier: ClassifierConfig;
  /** Explicit provider/model or variant ref for the optional LLM classifier. Empty means choose the cheapest eligible pool model. */
  classifierModel?: string;
}

export interface ClassifierConfig {
  enabled: boolean;
  failureThreshold: number;
  cooldownTurns: number;
  timeoutMs: number;
}

export interface Decision {
  cls: RouteClass;
  score: number;
  chosen: string;
  /** Task hardness index into HARDNESS_ORDER; sets how far selection climbs the capability frontier. */
  hardnessBucket: number;
  requestedProfile?: ModelProfile;
  reason?: string;
}

export interface ClassificationResult {
  hardness: Hardness;
  profile?: ModelProfile;
  score?: number;
  reason?: string;
}

export interface TaskClassifier {
  classify(context: Context, cfg: RouterConfig): ClassificationResult;
}

export interface ClassifierState {
  models: Record<string, { failures: number; disabledUntilTurn?: number }>;
}

export interface Selection {
  selected: ResolvedModel;
  profile: ModelProfile;
  /** Pi-normalized effort selected with the model when the benchmark source provides one. */
  benchmarkEffort?: ThinkingLevel;
  reason: string;
  alternatives: string[];
}

/** A warm prompt-cache hold on a model: switching away from it pays a fresh cache-write tax. */
export interface CacheLease {
  modelKey: string;
  provider: string;
  /** Raw registry cost fields for the leased model (per-token or per-1M; normalized at use). */
  cost: { input: number; cacheRead: number; cacheWrite: number };
  warmTokens: number;
  establishedAtTurn: number;
  lastUsedTurn: number;
}

/** Per-session routing memory for cache-aware stickiness. */
export interface RoutingState {
  lease?: CacheLease;
  lastSwitchTurn: number;
  observedCacheReadRatio: number;
  realizedCostByModel: Record<string, { usd: number }>;
  lastUsage?: Usage;
}

export type CacheReason =
  | "disabled"
  | "no-lease"
  | "same-model"
  | "switch-cooldown"
  | "downgrade-break-even"
  | "downgrade-not-worth-it"
  | "upgrade-quality"
  | "upgrade-not-worth-it";

export interface CacheAwareResult {
  selection: Selection;
  cacheReason: CacheReason;
  taxUsd?: number;
  expectedSavingsUsd?: number;
}

/**
 * Default willingness per source. The cost axis differs by source — AA is list price ($/1M tokens,
 * ~0.5–20), Ramp is measured cost per task ($, ~0.09–2.7) — so the $/quality-point budgets are on
 * different scales and must not be shared. `loadConfig` picks the table matching `capabilitySource`
 * unless the user sets `willingness` explicitly.
 */
export const AA_WILLINGNESS: Record<Hardness, number> = { trivial: 0.1, normal: 0.4, hard: 1.0, max: Infinity };
export const RAMP_WILLINGNESS: Record<Hardness, number> = { trivial: 0.02, normal: 0.06, hard: 0.2, max: Infinity };

export const DEFAULT_CONFIG: RouterConfig = {
  capabilitySource: "ramp",
  threshold: 0.45,
  weights: {
    contextTokens: 0.3,
    lastUserLen: 0.5,
    toolDensity: 0.2,
  },
  log: false,
  tierModels: {},
  modelFilter: { include: [], exclude: [] },
  modelOverrides: {},
  willingness: RAMP_WILLINGNESS,
  cacheAware: {
    enabled: true,
    downgradeMarginUsd: 0.001,
    upgradeQualityMargin: 3,
    upgradeTaxPenaltyScaleUsd: 0.02,
    minTurnsBetweenSwitches: 1,
  },
  quota: DEFAULT_QUOTA_CONFIG,
  classifier: {
    enabled: true,
    failureThreshold: 3,
    cooldownTurns: 20,
    timeoutMs: 3_000,
  },
};

export interface RouteModelRequest {
  models: Model<Api>[];
  hint: string;
  context?: Context;
  nowHour?: number;
  cfg?: RouterConfig;
  filterQuota?: boolean;
  agentDir?: string;
}

export interface RouteModelSelection {
  key: string;
}

function mergeRouterConfig(raw: unknown): RouterConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const record = raw as Record<string, unknown>;
  const router = (record.router && typeof record.router === "object" ? record.router : record) as Partial<RouterConfig> & {
    models?: RouterConfig["tierModels"];
    overrides?: RouterConfig["modelOverrides"];
  };
  const capabilitySource = router.capabilitySource === "aa" ? "aa" : "ramp";
  const baseWillingness = capabilitySource === "aa" ? AA_WILLINGNESS : RAMP_WILLINGNESS;
  const classifier = mergeClassifierConfig((router as Record<string, unknown>).classifier);
  const classifierModel = typeof (router as Record<string, unknown>).classifierModel === "string"
    ? (router as Record<string, string>).classifierModel
    : DEFAULT_CONFIG.classifierModel;
  return {
    ...DEFAULT_CONFIG,
    ...router,
    capabilitySource,
    weights: { ...DEFAULT_CONFIG.weights, ...(router.weights ?? {}) },
    tierModels: { ...DEFAULT_CONFIG.tierModels, ...(router.tierModels ?? router.models ?? {}) },
    modelFilter: { ...DEFAULT_CONFIG.modelFilter, ...(router.modelFilter ?? {}) },
    modelOverrides: { ...DEFAULT_CONFIG.modelOverrides, ...(router.modelOverrides ?? router.overrides ?? {}) },
    willingness: { ...baseWillingness, ...(router.willingness ?? {}) },
    cacheAware: { ...DEFAULT_CONFIG.cacheAware, ...(router.cacheAware ?? {}) },
    quota: { ...DEFAULT_CONFIG.quota, ...(router.quota ?? {}) },
    classifier,
    classifierModel,
  };
}

export function mergeClassifierConfig(
  raw: unknown,
  base: ClassifierConfig = DEFAULT_CONFIG.classifier,
): ClassifierConfig {
  if (raw === "off" || raw === false) return { ...base, enabled: false };
  if (!raw || typeof raw !== "object") return base;
  return { ...base, ...(raw as Partial<ClassifierConfig>) };
}

export function inferFallbackProfile(context: Context): ModelProfile {
  return inferRequestedProfile(context);
}

/** Loads only the user-level model-router.json; project configuration requires trust context and is intentionally excluded. */
export function loadUserRouterConfig(agentDir = defaultAgentDir()): RouterConfig {
  const file = join(agentDir, "model-router.json");
  if (!existsSync(file)) return DEFAULT_CONFIG;
  try {
    return mergeRouterConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Resolves a routing hint without requiring ExtensionContext or invoking a model provider. */
export function resolveRouteModel(request: RouteModelRequest): RouteModelSelection | undefined {
  const hint = request.hint.trim();
  const normalizedHint = hint.toLowerCase();
  const concrete = request.models.find((candidate) => modelKey(candidate).toLowerCase() === normalizedHint);
  if (normalizedHint !== "cheap" && normalizedHint !== "strong" && normalizedHint !== "auto") {
    if (!concrete || normalizedHint === "pi-router/auto") return undefined;
    return { key: modelKey(concrete) };
  }

  const cfg = request.cfg ?? loadUserRouterConfig();
  const context = request.context ?? { messages: [] };
  let pool = buildAutoPool(request.models, cfg);
  if (request.filterQuota !== false && cfg.quota.enabled) {
    const quota = new QuotaState(cfg.quota);
    quota.load(join(request.agentDir ?? defaultAgentDir(), "quota-state.json"));
    pool = filterPoolByQuotaPlanPrefix(pool, quota, Date.now());
  }
  pool = repriceForTimeOfDay(pool, request.nowHour ?? new Date().getHours());
  const forced = normalizedHint === "cheap" || normalizedHint === "strong" ? { tier: normalizedHint } as const : undefined;
  const decision = decide(context, undefined, forced, cfg);
  const selection = selectFromPool(decision, pool, context, undefined, cfg);
  if (!selection) return undefined;
  const key = modelKey(selection.selected.model);
  return key.toLowerCase() === "pi-router/auto" ? undefined : { key };
}

export function normalizeModelKey(key: string): string {
  const withoutProvider = key.toLowerCase().split("/").at(-1) ?? key.toLowerCase();
  return withoutProvider.trim().replace(/\s*\((?:xhigh|high|medium|low|minimal|max)\)\s*$/i, "");
}

/** Resolve-rate at/above which a Ramp model is shown as a frontier/strong-pool candidate (display only). */
const RAMP_FRONTIER_RESOLVE = 75;

/** Map a Ramp solve rate (0–100) to the user-facing capability mode. */
export function rampCapabilityMode(resolveRate: number): CapabilityMode {
  if (resolveRate >= MODE_SOLVE_BOUNDS[3][0]) return "ultra";
  if (resolveRate >= MODE_SOLVE_BOUNDS[2][0]) return "high";
  if (resolveRate >= MODE_SOLVE_BOUNDS[1][0]) return "medium";
  return "low";
}

function rampCostTier(costPerTask: number): CostTier {
  if (costPerTask < 0.4) return "cheap";
  if (costPerTask <= 1.2) return "standard";
  return "premium";
}

export function resolveCanonicalModel(key: string, source: CapabilitySource = "ramp"): CanonicalResolution {
  return resolveCanonicalModels(key, source)[0];
}

export function resolveCanonicalModels(key: string, source: CapabilitySource = "ramp"): CanonicalResolution[] {
  const normalized = normalizeModelKey(key);
  const canonical = CANONICAL_MODELS
    .map((entry) => {
      const candidates = [entry.key, ...(entry.aliases ?? [])];
      const matchLength = Math.max(0, ...candidates.filter((candidate) => normalized.includes(candidate)).map((candidate) => candidate.length));
      return { entry, matchLength };
    })
    .filter((match) => match.matchLength > 0)
    .sort((a, b) => b.matchLength - a.matchLength || b.entry.key.length - a.entry.key.length)[0]?.entry;

  if (!canonical) {
    return [{
      canonical: null,
      costTier: "unknown",
      profiles: ["balanced"],
      frontier: false,
      intelligence: FALLBACK_INTELLIGENCE,
      priceBlended: FALLBACK_PRICE,
      supported: false,
      confidence: "low",
      reason: "no canonical match",
    }];
  }

  if (source === "ramp") {
    const variants = findRampModels(canonical.key);
    if (variants.length === 0) {
      // Canonical name is known, but Ramp never measured it — unsupported for auto-routing under `ramp`.
      return [{
        canonical,
        costTier: canonical.costTier,
        profiles: canonical.profiles,
        frontier: false,
        intelligence: FALLBACK_INTELLIGENCE,
        priceBlended: FALLBACK_PRICE,
        supported: false,
        confidence: "low",
        reason: `no Ramp result for ${canonical.key}`,
      }];
    }
    return variants.map((ramp) => rampResolution(canonical, ramp));
  }

  if (canonical.source?.startsWith("Ramp SWE-Bench")) {
    return [{
      canonical,
      costTier: canonical.costTier,
      profiles: canonical.profiles,
      frontier: false,
      intelligence: FALLBACK_INTELLIGENCE,
      priceBlended: FALLBACK_PRICE,
      supported: false,
      confidence: "low",
      reason: `no Artificial Analysis result for ${canonical.key}`,
    }];
  }

  return [{
    canonical,
    costTier: canonical.costTier,
    profiles: canonical.profiles,
    frontier: canonical.frontier,
    intelligence: canonical.intelligence,
    priceBlended: canonical.priceBlended,
    scores: canonical.scores,
    tps: canonical.tps,
    benchmarkEffort: canonical.benchmarkEffort,
    supported: true,
    confidence: "high",
    reason: `canonical match: ${canonical.key}${canonical.benchmarkEffort ? `@${canonical.benchmarkEffort}` : ""}`,
  }];
}

function rampResolution(canonical: CanonicalMeta, ramp: RampMeta): CanonicalResolution {
  // One real outcome (resolve-rate) is the axis for every profile; mirror it into the per-profile scores.
  const scores: CanonicalScores = { coding: ramp.resolveRate, agentic: ramp.resolveRate / 100 };
  return {
    canonical,
    costTier: rampCostTier(ramp.costPerTask),
    capabilityMode: rampCapabilityMode(ramp.resolveRate),
    profiles: canonical.profiles,
    frontier: ramp.resolveRate >= RAMP_FRONTIER_RESOLVE,
    intelligence: ramp.resolveRate,
    priceBlended: ramp.costPerTask,
    scores,
    tps: undefined,
    benchmarkEffort: ramp.effort,
    supported: true,
    confidence: "high",
    reason: `Ramp: ${canonical.key}@${ramp.effort} ${ramp.resolveRate}%@$${ramp.costPerTask}`,
  };
}

export function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function buildAutoPool(models: Model<Api>[], cfg: RouterConfig = DEFAULT_CONFIG): Pool {
  const all = models
    .filter((model) => model.provider !== "pi-router")
    .filter((model) => model.input?.includes("text"))
    .flatMap((model) => resolveModelVariants(model, cfg))
    // A model the active source has no data for (and no override) is not auto-routed.
    .filter((model) => model.supported)
    .filter((model) => matchesModelFilter(model, cfg.modelFilter))
    .sort(compareResolvedModels);

  return {
    cheapPool: all.filter((item) => item.costTier === "cheap"),
    standardPool: all.filter((item) => item.costTier === "standard"),
    strongPool: all.filter((item) => item.frontier || item.costTier === "premium"),
    unknownPool: all.filter((item) => item.costTier === "unknown"),
    all,
  };
}

export function selectClassifierModel(
  pool: Pool,
  cfg: RouterConfig,
  state: ClassifierState,
  turn: number,
): ResolvedModel | undefined {
  if (!cfg.classifier.enabled) return undefined;

  const candidates = pool.all.filter((item) => !isClassifierModelDisabled(state, modelKey(item.model), turn));
  if (cfg.classifierModel) {
    const ref = cfg.classifierModel.toLowerCase();
    return candidates.find((item) =>
      modelKey(item.model).toLowerCase() === ref ||
      variantKey(item).toLowerCase() === ref ||
      item.canonicalKey?.toLowerCase() === ref
    );
  }

  return [...candidates].sort((a, b) =>
    a.priceBlended - b.priceBlended ||
    modelKey(a.model).localeCompare(modelKey(b.model)),
  )[0];
}

export function resolveModel(model: Model<Api>, cfg: RouterConfig = DEFAULT_CONFIG): ResolvedModel {
  return resolveModelVariants(model, cfg)[0];
}

export function resolveModelVariants(model: Model<Api>, cfg: RouterConfig = DEFAULT_CONFIG): ResolvedModel[] {
  const key = modelKey(model);
  const resolutions = resolveCanonicalModels(key, cfg.capabilitySource);
  const resolution = resolutions[0];
  const override = findModelOverride(cfg, key, resolution.canonical?.key ?? null);
  // The base shadow-price coefficient folds the caller's real economics into the shared frontier: it
  // scales whatever base cost the source/override resolved, staying dimensionless so the axis keeps one
  // unit. Time-of-day windows are NOT folded here — they are re-applied per turn in repriceForTimeOfDay
  // so the clock can cross a window boundary mid-session without a pool rebuild.
  const coef = override?.costCoef ?? 1;

  if (override) {
    const base = override.priceBlended ?? blendedPriceFromCost(model) ?? resolution.priceBlended;
    return [{
      model,
      acceptsImage: model.input?.includes("image") ?? false,
      canonicalKey: override.canonical ?? resolution.canonical?.key ?? normalizeModelKey(key),
      costTier: override.costTier ?? resolution.costTier,
      capabilityMode: override.capabilityMode ?? resolution.capabilityMode,
      profiles: override.profiles ?? resolution.profiles,
      frontier: override.frontier ?? resolution.frontier,
      intelligence: override.intelligence ?? resolution.intelligence,
      priceBlended: base * coef,
      scores: override.scores ?? resolution.scores,
      tps: override.tps ?? resolution.tps,
      benchmarkEffort: override.benchmarkEffort ?? resolution.benchmarkEffort,
      // An explicit override always makes the model routable, even when the active source lacks data.
      supported: true,
      confidence: resolution.canonical ? "medium" : "high",
      matchReason: resolution.canonical
        ? `user override + ${resolution.reason}`
        : "user override for unknown model",
      costCoefHours: override.costCoefHours,
    }];
  }

  return resolutions.map((entry) => {
    const base = entry.supported ? entry.priceBlended : (blendedPriceFromCost(model) ?? entry.priceBlended);
    return {
      model,
      acceptsImage: model.input?.includes("image") ?? false,
      canonicalKey: entry.canonical?.key ?? null,
      costTier: entry.costTier,
      capabilityMode: entry.capabilityMode,
      profiles: entry.profiles,
      frontier: entry.frontier,
      intelligence: entry.intelligence,
      priceBlended: base * coef,
      scores: entry.scores,
      tps: entry.tps,
      benchmarkEffort: entry.benchmarkEffort,
      supported: entry.supported,
      confidence: entry.confidence,
      matchReason: entry.reason,
    };
  });
}

/** Product of the time-of-day window factors active at `nowHour` (1 when none apply). */
export function timeCostMultiplier(windows: CostCoefWindow[] | undefined, nowHour: number): number {
  if (!windows) return 1;
  let mult = 1;
  for (const window of windows) {
    if (hourInRange(nowHour, window.hours[0], window.hours[1])) mult *= window.factor;
  }
  return mult;
}

/**
 * Re-apply each model's time-of-day shadow-price windows against `nowHour`, returning a pool with
 * updated prices. Called once per user turn at the selection boundary (where the clock is read), so a
 * window like GLM's 14:00–18:00 3× starts and stops biting as time passes — no `/reload` needed. The
 * caller reads the clock once per turn and reuses the pick within the turn, so prices stay stable
 * across a turn's tool continuations.
 */
export function repriceForTimeOfDay(pool: Pool, nowHour: number): Pool {
  const reprice = (item: ResolvedModel): ResolvedModel => {
    const mult = timeCostMultiplier(item.costCoefHours, nowHour);
    return mult === 1 ? item : { ...item, priceBlended: item.priceBlended * mult };
  };
  return {
    cheapPool: pool.cheapPool.map(reprice),
    standardPool: pool.standardPool.map(reprice),
    strongPool: pool.strongPool.map(reprice),
    unknownPool: pool.unknownPool.map(reprice),
    all: pool.all.map(reprice),
  };
}

/** Whether `hour` falls in the half-open window [start, end), wrapping past midnight when start > end. */
function hourInRange(hour: number, start: number, end: number): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Best-effort list price ($/1M tokens, blended 3:1) from the registry's per-token cost, when present. */
function blendedPriceFromCost(model: Model<Api>): number | undefined {
  const input = model.cost?.input ?? 0;
  const output = model.cost?.output ?? 0;
  if (input <= 0 && output <= 0) return undefined;
  const perToken = (input * 3 + output) / 4;
  // Registries usually express cost per token; scale to per-1M. If already per-1M (large), leave as-is.
  return perToken < 0.001 ? perToken * 1_000_000 : perToken;
}

export function findModelOverride(
  cfg: RouterConfig,
  key: string,
  canonicalKey: string | null,
): ModelOverride | undefined {
  const candidates = [key, key.toLowerCase(), normalizeModelKey(key), canonicalKey].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const override = cfg.modelOverrides[candidate];
    if (override) return override;
  }
  return undefined;
}

export function matchesModelFilter(item: ResolvedModel, filter: ModelFilter): boolean {
  const include = filter.include.map(normalizeFilterPattern).filter(Boolean);
  const exclude = filter.exclude.map(normalizeFilterPattern).filter(Boolean);
  const haystack = modelFilterHaystack(item);

  if (exclude.some((pattern) => haystack.includes(pattern))) return false;
  if (include.length === 0) return true;
  return include.some((pattern) => haystack.includes(pattern));
}

function normalizeFilterPattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

function modelFilterHaystack(item: ResolvedModel): string {
  return [
    modelKey(item.model),
    item.model.provider,
    item.model.id,
    item.model.name,
    item.canonicalKey,
    normalizeModelKey(modelKey(item.model)),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

export function decide(
  context: Context,
  options: SimpleStreamOptions | undefined,
  forced: { tier: Tier } | { model: string } | undefined,
  cfg: RouterConfig,
  classifier: TaskClassifier = HEURISTIC_CLASSIFIER,
): Decision {
  if (forced && "model" in forced) return { cls: "model", score: 1, chosen: forced.model, hardnessBucket: 3, reason: "forced model" };
  if (forced && "tier" in forced) {
    return {
      cls: forced.tier,
      score: forced.tier === "strong" ? 1 : 0,
      chosen: "",
      // @cheap means "cheapest acceptable"; @strong means "the strong end".
      hardnessBucket: forced.tier === "strong" ? 3 : 0,
      requestedProfile: inferFallbackProfile(context),
      reason: "forced",
    };
  }

  const classification = classifier.classify(context, cfg);
  const requestedProfile = classification.profile ?? inferFallbackProfile(context);
  const hardnessBucket = hardnessBucketIndex(classification.hardness);
  const score = classification.score ?? representativeHardnessScore(classification.hardness);
  return {
    cls: hardnessBucket >= 2 ? "strong" : "cheap",
    score,
    chosen: "",
    hardnessBucket,
    requestedProfile,
    reason: classification.reason,
  };
}

/**
 * Continuous task-hardness bucket (index into HARDNESS_ORDER) for auto mode. The bucket — not a
 * binary cheap/strong split — drives the capability floor, so the whole frontier (incl. mid-tier
 * models) becomes reachable. Driven purely by task content: the thinking level is a passthrough that
 * controls how deeply the *chosen* model reasons, never which model is chosen.
 */
export function autoHardnessBucket(score: number): number {
  return score < 0.3 ? 0 : score < 0.52 ? 1 : score < 0.74 ? 2 : 3;
}

export function classify(context: Context, cfg: RouterConfig): number {
  const text = lastUserText(context);
  const contextTokens = estimateContextTokens(context);
  const toolDensity = Math.min(1, countRecentToolResults(context) / 8);

  const raw =
    normalize(contextTokens, 8_000, 120_000) * cfg.weights.contextTokens +
    normalize(text.length, 120, 1_200) * cfg.weights.lastUserLen +
    toolDensity * cfg.weights.toolDensity;

  return Math.max(0, Math.min(1, raw));
}

export const HEURISTIC_CLASSIFIER: TaskClassifier = {
  classify(context, cfg) {
    const score = classify(context, cfg);
    const hardness = HARDNESS_ORDER[autoHardnessBucket(score)];
    return { hardness, score, profile: inferRequestedProfile(context), reason: "heuristic" };
  },
};

export function parseClassificationOutput(text: string): ClassificationResult | undefined {
  const lower = text.toLowerCase();
  const hardness = matchEnum(lower, ["trivial", "normal", "hard", "max"]);
  if (!hardness) return undefined;

  const profile = matchEnum(lower, ["deep", "fast", "coder", "balanced", "vision"]);
  const score = parseScore(lower);
  return {
    hardness,
    profile,
    score,
    reason: "llm-classifier",
  };
}

function matchEnum<const T extends string>(text: string, values: readonly T[]): T | undefined {
  const alternation = values.join("|");
  const keyed = text.match(new RegExp(`\\b(?:hardness|difficulty|level|profile|task_profile)\\s*[:=]\\s*(${alternation})\\b`));
  const loose = keyed ?? text.match(new RegExp(`\\b(${alternation})\\b`));
  return loose?.[1] as T | undefined;
}

function parseScore(text: string): number | undefined {
  const match = text.match(/\bscore\s*[:=]\s*(0(?:\.\d+)?|1(?:\.0+)?)\b/);
  if (!match) return undefined;
  return Math.max(0, Math.min(1, Number(match[1])));
}

export function createClassifierState(): ClassifierState {
  return { models: {} };
}

export function isClassifierModelDisabled(state: ClassifierState, key: string, turn: number): boolean {
  const disabledUntil = state.models[key]?.disabledUntilTurn;
  return disabledUntil != null && disabledUntil > turn;
}

export function recordClassifierSuccess(state: ClassifierState, key: string): void {
  state.models[key] = { failures: 0 };
}

export function recordClassifierFailure(state: ClassifierState, key: string, turn: number, cfg: RouterConfig): void {
  const previous = state.models[key] ?? { failures: 0 };
  const failures = previous.failures + 1;
  state.models[key] = failures >= cfg.classifier.failureThreshold
    ? { failures: 0, disabledUntilTurn: turn + cfg.classifier.cooldownTurns }
    : { ...previous, failures };
}

function hardnessBucketIndex(hardness: Hardness): number {
  return HARDNESS_ORDER.indexOf(hardness);
}

function representativeHardnessScore(hardness: Hardness): number {
  return [0.15, 0.4, 0.63, 0.86][hardnessBucketIndex(hardness)] ?? 0.4;
}

export function inferRequestedProfile(context: Context): ModelProfile {
  if (contextHasImage(context)) return "vision";
  return "balanced";
}

/** Minimum intelligence a `fast`-profile pick must clear before maximizing throughput. */
const FAST_MIN_INTELLIGENCE = 33;

/** Approximate one axis from another when a model lacks the native metric (keeps the scale comparable). */
export function axisValue(item: ResolvedModel, profile: ModelProfile): number {
  if (profile === "coder") return item.scores?.coding ?? item.intelligence + 15;
  if (profile === "deep") return item.scores?.agentic != null ? item.scores.agentic * 100 : item.intelligence + 24;
  return item.intelligence; // balanced / vision / fallback
}

/** Models that pass the hard constraints (vision + context window) for this request. */
function eligibleModels(pool: Pool, context: Context): { eligible: ResolvedModel[]; overflow: boolean } {
  const needsImage = contextHasImage(context);
  const tokens = estimateContextTokens(context);
  const visionOk = pool.all.filter((item) => !needsImage || item.acceptsImage);

  if (needsImage && visionOk.length === 0) {
    throw new Error("Pi Router: no vision-capable authenticated model for an image request.");
  }

  const withinWindow = visionOk.filter((item) => !item.model.contextWindow || tokens <= item.model.contextWindow);
  // Window too tight everywhere: try anyway on the largest window rather than refuse outright.
  return withinWindow.length > 0 ? { eligible: withinWindow, overflow: false } : { eligible: visionOk, overflow: true };
}

/**
 * Capability Pareto frontier on (quality, list price): keep a model only if no other is at least as
 * capable AND no more expensive (strictly better on one). Dominated models — dumber *and* pricier —
 * are strict waste and never selected. This replaces the old hard-coded scoreCandidate.
 */
export function paretoFrontier(items: ResolvedModel[], profile: ModelProfile): ResolvedModel[] {
  return items.filter((a) => {
    const qa = axisValue(a, profile);
    return !items.some((b) => {
      if (b === a) return false;
      const qb = axisValue(b, profile);
      return qb >= qa && b.priceBlended <= a.priceBlended && (qb > qa || b.priceBlended < a.priceBlended);
    });
  });
}

/**
 * The frontier as a monotone chain, cheapest+weakest → priciest+strongest, with equal-(quality,price)
 * duplicates collapsed deterministically. This is the ordered set of operating points to climb.
 */
export function frontierChain(items: ResolvedModel[], profile: ModelProfile): ResolvedModel[] {
  const sorted = [...paretoFrontier(items, profile)].sort(
    (a, b) =>
      axisValue(a, profile) - axisValue(b, profile) ||
      a.priceBlended - b.priceBlended ||
      modelKey(a.model).localeCompare(modelKey(b.model)),
  );
  const chain: ResolvedModel[] = [];
  for (const item of sorted) {
    const prev = chain.at(-1);
    if (
      prev &&
      axisValue(prev, profile) === axisValue(item, profile) &&
      prev.priceBlended === item.priceBlended &&
      variantKey(prev) === variantKey(item)
    ) continue;
    chain.push(item);
  }
  return chain;
}

/** Walk the frontier upward, taking each step whose marginal $/quality-point is within budget. */
function climbFrontier(chain: ResolvedModel[], profile: ModelProfile, willingness: number): ResolvedModel {
  let pick = chain[0];
  for (let i = 1; i < chain.length; i++) {
    const dq = axisValue(chain[i], profile) - axisValue(pick, profile);
    const dp = chain[i].priceBlended - pick.priceBlended;
    if (dq > 0 && dp / dq > willingness) break;
    pick = chain[i];
  }
  return pick;
}

function rampModeTarget(decision: Decision): { mode: CapabilityMode; solveRate: number; position: number } {
  const bucket = Math.max(0, Math.min(CAPABILITY_MODE_ORDER.length - 1, Math.trunc(decision.hardnessBucket)));
  const [scoreLow, scoreHigh] = HARDNESS_SCORE_BOUNDS[bucket];
  const score = Number.isFinite(decision.score) ? decision.score : scoreLow;
  const position = (Math.max(scoreLow, Math.min(scoreHigh, score)) - scoreLow) / (scoreHigh - scoreLow);
  const [solveLow, solveHigh] = MODE_SOLVE_BOUNDS[bucket];
  return {
    mode: CAPABILITY_MODE_ORDER[bucket],
    solveRate: solveLow + position * (solveHigh - solveLow),
    position,
  };
}

function cheapestMeetingFloor(items: ResolvedModel[], solveRate: number): ResolvedModel | undefined {
  return [...items]
    .filter((item) => item.intelligence >= solveRate)
    .sort((a, b) =>
      a.priceBlended - b.priceBlended ||
      b.intelligence - a.intelligence ||
      modelKey(a.model).localeCompare(modelKey(b.model)),
    )[0];
}

function finiteWillingness(cfg: RouterConfig, hardness: Hardness): number {
  const configured = cfg.willingness[hardness];
  if (Number.isFinite(configured)) return Math.max(0, configured);
  return Math.max(0, ...Object.values(cfg.willingness).filter(Number.isFinite));
}

function climbWithinMode(base: ResolvedModel, items: ResolvedModel[], willingness: number): ResolvedModel {
  let pick = base;
  const stronger = items
    .filter((item) => item.intelligence > base.intelligence)
    .sort((a, b) => a.intelligence - b.intelligence || a.priceBlended - b.priceBlended);
  for (const item of stronger) {
    const qualityGain = item.intelligence - pick.intelligence;
    const priceIncrease = item.priceBlended - pick.priceBlended;
    if (qualityGain > 0 && priceIncrease / qualityGain > willingness) break;
    pick = item;
  }
  return pick;
}

function nearestModeFallback(items: ResolvedModel[], targetMode: CapabilityMode): ResolvedModel | undefined {
  const targetRank = CAPABILITY_MODE_ORDER.indexOf(targetMode);
  const ranked = items
    .map((item) => ({ item, rank: item.capabilityMode ? CAPABILITY_MODE_ORDER.indexOf(item.capabilityMode) : -1 }))
    .filter(({ rank }) => rank >= 0);
  const strongerRank = Math.min(...ranked.filter(({ rank }) => rank > targetRank).map(({ rank }) => rank));
  if (Number.isFinite(strongerRank)) {
    return ranked
      .filter(({ rank }) => rank === strongerRank)
      .map(({ item }) => item)
      .sort((a, b) => a.priceBlended - b.priceBlended || b.intelligence - a.intelligence)[0];
  }

  const weakerRank = Math.max(...ranked.filter(({ rank }) => rank < targetRank).map(({ rank }) => rank));
  return ranked
    .filter(({ rank }) => rank === weakerRank)
    .map(({ item }) => item)
    .sort((a, b) => b.intelligence - a.intelligence || a.priceBlended - b.priceBlended)[0];
}

export function selectFromPool(
  decision: Decision,
  pool: Pool,
  context: Context,
  options: SimpleStreamOptions | undefined,
  cfg: RouterConfig,
): Selection | undefined {
  const profile = decision.requestedProfile ?? inferRequestedProfile(context);
  const { eligible, overflow } = eligibleModels(pool, context);
  if (eligible.length === 0) return undefined;

  const bucket = decision.hardnessBucket;
  const hardness = HARDNESS_ORDER[Math.max(0, Math.min(HARDNESS_ORDER.length - 1, bucket))];

  // `fast` is orthogonal: gate on a low capability floor, then maximize throughput.
  if (profile === "fast") {
    const usable = eligible.filter((item) => item.intelligence >= FAST_MIN_INTELLIGENCE);
    const pickFrom = usable.length > 0 ? usable : eligible;
    const selected = [...pickFrom].sort((a, b) =>
      (b.tps ?? 0) - (a.tps ?? 0) ||
      a.priceBlended - b.priceBlended ||
      b.intelligence - a.intelligence ||
      modelKey(a.model).localeCompare(modelKey(b.model)),
    )[0];
    return buildSelection(selected, eligible, profile, `fast: top throughput${overflowNote(overflow)}`);
  }

  // First remove strictly dominated variants; every later choice stays on this economic frontier.
  const chain = frontierChain(eligible, profile);

  // Ramp maps task difficulty to a solve-rate floor, then spends only on affordable upgrades inside
  // that Mode. AA has no comparable solve-rate scale and retains the source-specific frontier climb.
  if (cfg.capabilitySource === "ramp") {
    const target = rampModeTarget(decision);
    const sameMode = chain.filter((item) => item.capabilityMode === target.mode);
    if (sameMode.length > 0) {
      const base = cheapestMeetingFloor(sameMode, target.solveRate) ?? [...sameMode].sort((a, b) =>
        b.intelligence - a.intelligence ||
        a.priceBlended - b.priceBlended ||
        modelKey(a.model).localeCompare(modelKey(b.model)),
      )[0];
      const willingness = finiteWillingness(cfg, hardness) * target.position;
      const selected = climbWithinMode(base, sameMode, willingness);
      const reason = `${target.mode} floor≥${target.solveRate.toFixed(1)} w≤$${willingness.toFixed(3)}/pt → ${selected.intelligence.toFixed(1)}@$${selected.priceBlended}${overflowNote(overflow)}`;
      return buildSelection(selected, chain, profile, reason);
    }

    const selected = nearestModeFallback(chain, target.mode);
    if (selected) {
      const reason = `${target.mode} unavailable → ${selected.capabilityMode} ${selected.intelligence.toFixed(1)}@$${selected.priceBlended}${overflowNote(overflow)}`;
      return buildSelection(selected, chain, profile, reason);
    }
  }

  const willingness = cfg.willingness[hardness];
  const selected = climbFrontier(chain, profile, willingness);

  const budget = willingness === Infinity ? "∞" : willingness.toString();
  const reason = `${hardness}/${profile} w≤$${budget}/pt → ${axisValue(selected, profile).toFixed(0)}@$${selected.priceBlended}${overflowNote(overflow)}`;
  return buildSelection(selected, chain, profile, reason);
}

function buildSelection(
  selected: ResolvedModel,
  frontier: ResolvedModel[],
  profile: ModelProfile,
  reason: string,
): Selection {
  return {
    selected,
    profile,
    benchmarkEffort: selected.benchmarkEffort,
    reason,
    alternatives: frontier.filter((item) => item !== selected).map(variantKey),
  };
}

function overflowNote(overflow: boolean): string {
  return overflow ? "; context may overflow" : "";
}

// ── Cross-turn cache-aware stickiness ────────────────────────────────────────
// Layered on top of the Pareto pick. The Pareto pass says which model best fits this turn's
// hardness; this pass asks whether a warm cache lease is worth keeping instead of switching to it.

export function createRoutingState(): RoutingState {
  return { lastSwitchTurn: Number.NEGATIVE_INFINITY, observedCacheReadRatio: 0, realizedCostByModel: {} };
}

/** Monotonic user-turn counter (number of user messages) — no harness turn hooks needed. */
export function userTurnIndex(context: Context): number {
  return context.messages.reduce((count, message) => (message.role === "user" ? count + 1 : count), 0);
}

/** Normalize a registry cost field to USD-per-token, tolerating per-token or per-1M conventions. */
function costPerTokenUsd(cost: number): number {
  return cost >= 0.001 ? cost / 1_000_000 : cost;
}

/**
 * Given the fresh Pareto selection, decide whether to keep the warm lease instead. Returns the fresh
 * pick when there is no lease, when the fresh pick already is the lease, or when an economic switch wins.
 */
export function cacheAwareSelect(
  fresh: Selection,
  state: RoutingState,
  pool: Pool,
  context: Context,
  cfg: RouterConfig,
): CacheAwareResult {
  if (!cfg.cacheAware.enabled) return { selection: fresh, cacheReason: "disabled" };

  const lease = state.lease;
  const leaseItem = lease ? pool.all.find((item) => modelKey(item.model) === lease.modelKey) : undefined;
  // No warm lease, or the leased model is no longer eligible (deauthed / cooled down) → take the fresh pick.
  if (!lease || !leaseItem) return { selection: fresh, cacheReason: "no-lease" };
  if (modelKey(fresh.selected.model) === lease.modelKey) return { selection: fresh, cacheReason: "same-model" };

  const profile = fresh.profile;
  const stay = leaseSelection(leaseItem, fresh, profile);

  if (userTurnIndex(context) - state.lastSwitchTurn < cfg.cacheAware.minTurnsBetweenSwitches) {
    return { selection: { ...stay, reason: "cache-stay: switch cooldown" }, cacheReason: "switch-cooldown" };
  }

  const contextTokens = state.lastUsage && state.lastUsage.totalTokens > 0 ? state.lastUsage.totalTokens : estimateContextTokens(context);
  const taxUsd = switchTaxUsd(contextTokens, lease, fresh.selected);
  const qLease = axisValue(leaseItem, profile);
  const qFresh = axisValue(fresh.selected, profile);

  if (qFresh <= qLease) {
    const expectedSavingsUsd = expectedDowngradeSavingsUsd(contextTokens, lease, fresh.selected, state);
    if (expectedSavingsUsd >= Math.max(0, taxUsd) + cfg.cacheAware.downgradeMarginUsd) {
      return {
        selection: { ...fresh, reason: `${fresh.reason}; downgrade saves ${formatUsd(expectedSavingsUsd)} > tax ${formatUsd(taxUsd)}` },
        cacheReason: "downgrade-break-even",
        taxUsd,
        expectedSavingsUsd,
      };
    }
    return {
      selection: { ...stay, reason: `cache-stay: downgrade saves ${formatUsd(expectedSavingsUsd)} < tax ${formatUsd(taxUsd)}` },
      cacheReason: "downgrade-not-worth-it",
      taxUsd,
      expectedSavingsUsd,
    };
  }

  const gain = qFresh - qLease;
  const taxPenalty = Math.max(0, taxUsd) / Math.max(cfg.cacheAware.upgradeTaxPenaltyScaleUsd, 1e-6);
  if (gain >= cfg.cacheAware.upgradeQualityMargin + taxPenalty) {
    return {
      selection: { ...fresh, reason: `${fresh.reason}; upgrade +${gain.toFixed(0)}pt covers tax` },
      cacheReason: "upgrade-quality",
      taxUsd,
    };
  }
  return {
    selection: { ...stay, reason: `cache-stay: upgrade +${gain.toFixed(0)}pt below margin` },
    cacheReason: "upgrade-not-worth-it",
    taxUsd,
  };
}

function leaseSelection(leaseItem: ResolvedModel, fresh: Selection, profile: ModelProfile): Selection {
  const leaseKey = variantKey(leaseItem);
  return {
    selected: leaseItem,
    profile,
    benchmarkEffort: leaseItem.benchmarkEffort,
    reason: "warm cache lease",
    alternatives: [variantKey(fresh.selected), ...fresh.alternatives.filter((key) => key !== leaseKey)],
  };
}

/** Record the realized usage of a turn: refresh cache-read ratio and re-establish the lease. */
export function recordRoutingUsage(state: RoutingState, selected: ResolvedModel, usage: Usage, context: Context): void {
  const key = modelKey(selected.model);
  const totalPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const cacheReadRatio = totalPromptTokens > 0 ? usage.cacheRead / totalPromptTokens : 0;
  state.observedCacheReadRatio = movingAverage(state.observedCacheReadRatio, cacheReadRatio, 0.25);
  state.realizedCostByModel[key] = { usd: (state.realizedCostByModel[key]?.usd ?? 0) + usage.cost.total };
  state.lastUsage = usage;

  const turn = userTurnIndex(context);
  if (state.lease && state.lease.modelKey !== key) state.lastSwitchTurn = turn;
  state.lease = {
    modelKey: key,
    provider: selected.model.provider,
    cost: { input: selected.model.cost.input, cacheRead: selected.model.cost.cacheRead, cacheWrite: selected.model.cost.cacheWrite },
    warmTokens: totalPromptTokens,
    establishedAtTurn: state.lease?.modelKey === key ? state.lease.establishedAtTurn : turn,
    lastUsedTurn: turn,
  };
}

/** Switching pays a cache-write on the candidate instead of re-reading the warm lease. */
function switchTaxUsd(contextTokens: number, lease: CacheLease, candidate: ResolvedModel): number {
  const stayCost = contextTokens * costPerTokenUsd(lease.cost.cacheRead);
  const switchCost = contextTokens * costPerTokenUsd(candidate.model.cost.cacheWrite);
  return switchCost - stayCost;
}

/** Downgrading earns cheaper warm reads for the rest of the domain. */
function expectedDowngradeSavingsUsd(contextTokens: number, lease: CacheLease, candidate: ResolvedModel, state: RoutingState): number {
  const warmTokens = Math.max(contextTokens * state.observedCacheReadRatio, lease.warmTokens);
  const readDelta = Math.max(0, costPerTokenUsd(lease.cost.cacheRead) - costPerTokenUsd(candidate.model.cost.cacheRead));
  return warmTokens * readDelta;
}

function movingAverage(previous: number, next: number, weight: number): number {
  return previous === 0 ? next : previous * (1 - weight) + next * weight;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function contextHasImage(context: Context): boolean {
  return context.messages.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
  );
}

export function lastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role !== "user") continue;
    return userMessageText(message);
  }
  return "";
}

export function routingTurnKey(context: Context): string {
  let userCount = 0;
  let lastText = "";

  for (const message of context.messages) {
    if (message.role !== "user") continue;
    userCount += 1;
    lastText = userMessageText(message);
  }

  return `${userCount}:${stableHash(lastText)}`;
}

export function shouldReuseTurnSelection(context: Context): boolean {
  return context.messages.at(-1)?.role === "toolResult";
}

function userMessageText(message: Extract<Context["messages"][number], { role: "user" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function stableHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

export function estimateContextTokens(context: Context): number {
  const system = context.systemPrompt?.length ?? 0;
  const chars = context.messages.reduce((sum, message) => {
    if (typeof message.content === "string") return sum + message.content.length;

    return sum + message.content.reduce((inner, part) => {
      if (part.type === "text") return inner + part.text.length;
      if (part.type === "thinking") return inner + part.thinking.length;
      if (part.type === "toolCall") return inner + JSON.stringify(part.arguments).length + part.name.length;
      return inner + 1024;
    }, 0);
  }, system);

  return Math.ceil(chars / 4);
}

function resolveCostRank(tier: CostTier): number {
  if (tier === "cheap") return 0;
  if (tier === "standard") return 1;
  if (tier === "premium") return 2;
  return 3;
}

function compareResolvedModels(a: ResolvedModel, b: ResolvedModel): number {
  return resolveCostRank(a.costTier) - resolveCostRank(b.costTier) || variantKey(a).localeCompare(variantKey(b));
}

export function variantKey(item: ResolvedModel): string {
  return item.benchmarkEffort ? `${modelKey(item.model)}@${item.benchmarkEffort}` : modelKey(item.model);
}

function countRecentToolResults(context: Context): number {
  return context.messages.slice(-12).filter((message) => message.role === "toolResult").length;
}

function normalize(value: number, low: number, high: number): number {
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
}
