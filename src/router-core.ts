import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { CANONICAL_MODELS, findRampModels, type CanonicalMeta, type CanonicalScores, type ModelProfile, type RampMeta } from "./canonical-models.ts";
import { DEFAULT_QUOTA_CONFIG, filterPoolByQuotaPlanPrefix, QuotaState, type QuotaConfig } from "./quota.ts";

/**
 * Keep capability, cost preference, and reasoning effort independent: task difficulty selects a
 * capability mode, policy chooses the strongest or cheapest model in that mode, and benchmark effort
 * configures the selected provider call.
 */
export type RouteClass = CapabilityMode | "model";
export type Confidence = "high" | "medium" | "low";
/** Which benchmark drives every model's capability + cost. The two are never merged; selection is wholesale. */
export type CapabilitySource = "aa" | "ramp";
export type CapabilityMode = "low" | "medium" | "high" | "ultra";
/** User-facing capability modes, ordered from least to most capable. */
const CAPABILITY_MODE_ORDER: CapabilityMode[] = ["low", "medium", "high", "ultra"];
const MODE_SCORE_BOUNDS: [number, number][] = [[0, 0.3], [0.3, 0.52], [0.52, 0.74], [0.74, 1]];
/** Ramp capability modes are SWE-bench solve-rate bands. */
const RAMP_MODE_BOUNDS: [number, number][] = [[0, 75], [75, 80], [80, 85], [85, 100]];
/** How to choose a model after the required capability mode is known. */
export type SelectionPolicy = "quality" | "cost";

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
  capabilityMode?: CapabilityMode;
  profiles: ModelProfile[];
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
  capabilityMode?: CapabilityMode;
  profiles: ModelProfile[];
  /** Synthetic intelligence index; capability axis for `balanced`/fallback profiles. */
  intelligence: number;
  /** Effective price after personal coefficients: AA blended $/1M tokens or Ramp measured $/task. */
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
  all: ResolvedModel[];
}

export interface ModelOverride {
  canonical?: string;
  capabilityMode?: CapabilityMode;
  profiles?: ModelProfile[];
  intelligence?: number;
  priceBlended?: number;
  scores?: CanonicalScores;
  tps?: number;
  /** Override the benchmark-backed effort metadata for private or manually classified models. */
  benchmarkEffort?: ThinkingLevel;
  /**
   * Multiplies the active source's base price without changing capability. Values below 1 represent
   * a discount or prepaid subscription; values above 1 represent a personal surcharge. This mainly
   * affects `selectionPolicy: "cost"` (and quality-policy price tie-breaks).
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
  /** @deprecated Retained for configuration compatibility; discrete capability modes do not use it. */
  threshold: number;
  weights: {
    contextTokens: number;
    lastUserLen: number;
    toolDensity: number;
  };
  log: boolean;
  /** Pin an exact provider/model for a user-facing capability mode. */
  modeModels: Partial<Record<CapabilityMode, string>>;
  /** Restrict the automatically built pool by provider/id/name/canonical substring. Empty include means allow all. */
  modelFilter: ModelFilter;
  /** User-supplied metadata for unknown/private/local models. Keys may be provider/id, model id, or normalized model id. */
  modelOverrides: Record<string, ModelOverride>;
  /** Within the selected capability mode, prefer the strongest model (default) or the cheapest one. */
  selectionPolicy: SelectionPolicy;
  /** Keep a warm model for the session; switch automatically only when the required mode increases. */
  cacheAware: { enabled: boolean };
  quota: QuotaConfig;
  classifier: ClassifierConfig;
  /** Exact provider/model or variant ref for the optional LLM classifier. Empty disables it. */
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
  /** Capability mode index into CAPABILITY_MODE_ORDER. */
  modeBucket: number;
  requestedProfile?: ModelProfile;
  reason?: string;
}

export interface ClassificationResult {
  mode: CapabilityMode;
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
  /** Capability mode under which this endpoint was selected (important for cross-mode pins). */
  capabilityMode?: CapabilityMode;
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
  | "lease-ineligible"
  | "same-model"
  | "sticky-session"
  | "capability-upgrade";

export interface CacheAwareResult {
  selection: Selection;
  cacheReason: CacheReason;
  taxUsd?: number;
  expectedSavingsUsd?: number;
}

export const DEFAULT_CONFIG: RouterConfig = {
  capabilitySource: "ramp",
  threshold: 0.45,
  weights: {
    contextTokens: 0.3,
    lastUserLen: 0.5,
    toolDensity: 0.2,
  },
  log: false,
  modeModels: {},
  modelFilter: { include: [], exclude: [] },
  modelOverrides: {},
  selectionPolicy: "quality",
  cacheAware: { enabled: true },
  quota: DEFAULT_QUOTA_CONFIG,
  classifier: {
    enabled: false,
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
    models?: RouterConfig["modeModels"];
    modeModels?: RouterConfig["modeModels"];
    overrides?: RouterConfig["modelOverrides"];
  };
  const capabilitySource = router.capabilitySource === "aa" ? "aa" : "ramp";
  const selectionPolicy: SelectionPolicy = router.selectionPolicy === "cost" ? "cost" : "quality";
  const rawClassifier = (router as Record<string, unknown>).classifier;
  const classifierModel = typeof (router as Record<string, unknown>).classifierModel === "string"
    ? (router as Record<string, string>).classifierModel
    : DEFAULT_CONFIG.classifierModel;
  const classifier = enableClassifierForPinnedModel(
    mergeClassifierConfig(rawClassifier),
    classifierModel,
    rawClassifier,
  );
  return {
    ...DEFAULT_CONFIG,
    ...router,
    capabilitySource,
    selectionPolicy,
    weights: { ...DEFAULT_CONFIG.weights, ...(router.weights ?? {}) },
    modeModels: { ...DEFAULT_CONFIG.modeModels, ...(router.modeModels ?? router.models ?? {}) },
    modelFilter: { ...DEFAULT_CONFIG.modelFilter, ...(router.modelFilter ?? {}) },
    modelOverrides: { ...DEFAULT_CONFIG.modelOverrides, ...(router.modelOverrides ?? router.overrides ?? {}) },
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

export function enableClassifierForPinnedModel(
  classifier: ClassifierConfig,
  classifierModel: string | undefined,
  rawClassifier: unknown,
): ClassifierConfig {
  if (!classifierModel || classifierExplicitlyDisabled(rawClassifier)) return classifier;
  return { ...classifier, enabled: true };
}

function classifierExplicitlyDisabled(raw: unknown): boolean {
  return raw === "off" || raw === false ||
    Boolean(raw && typeof raw === "object" && (raw as Partial<ClassifierConfig>).enabled === false);
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
  const modeHint = parseCapabilityMode(normalizedHint);
  const concrete = request.models.find((candidate) => modelKey(candidate).toLowerCase() === normalizedHint);
  if (!modeHint && normalizedHint !== "auto") {
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
  const forced = modeHint ? { mode: modeHint } as const : undefined;
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

/** Map a Ramp solve rate (0–100) to the user-facing capability mode. */
export function rampCapabilityMode(resolveRate: number): CapabilityMode {
  return capabilityModeForValue(resolveRate, RAMP_MODE_BOUNDS);
}

/** Map AA Intelligence Index onto the same user-facing capability modes. */
export function aaCapabilityMode(intelligence: number): CapabilityMode {
  if (intelligence >= 52) return "ultra";
  if (intelligence >= 47) return "high";
  if (intelligence >= 40) return "medium";
  return "low";
}

export function parseCapabilityMode(value: string): CapabilityMode | undefined {
  const normalized = value.trim().toLowerCase();
  return CAPABILITY_MODE_ORDER.includes(normalized as CapabilityMode) ? normalized as CapabilityMode : undefined;
}

function capabilityModeForValue(value: number, bounds: readonly [number, number][]): CapabilityMode {
  if (value >= bounds[3][0]) return "ultra";
  if (value >= bounds[2][0]) return "high";
  if (value >= bounds[1][0]) return "medium";
  return "low";
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
      profiles: ["balanced"],
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
        profiles: canonical.profiles,
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
      profiles: canonical.profiles,
      intelligence: FALLBACK_INTELLIGENCE,
      priceBlended: FALLBACK_PRICE,
      supported: false,
      confidence: "low",
      reason: `no Artificial Analysis result for ${canonical.key}`,
    }];
  }

  return [{
    canonical,
    capabilityMode: aaCapabilityMode(canonical.intelligence),
    profiles: canonical.profiles,
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
    capabilityMode: rampCapabilityMode(ramp.resolveRate),
    profiles: canonical.profiles,
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
  const routableModels = models
    .filter((model) => model.provider !== "pi-router")
    .filter((model) => model.input?.includes("text"));
  const all = routableModels
    .flatMap((model) => resolveModelVariants(model, cfg))
    // A model the active source has no data for (and no override) is not auto-routed.
    .filter((model) => model.supported)
    .filter((model) => matchesModelFilter(model, cfg.modelFilter));

  // An explicit mode pin may refer to a private model with no benchmark metadata. Include it so the
  // selector can honor the pin, while still applying the normal model filter and hard eligibility.
  for (const mode of CAPABILITY_MODE_ORDER) {
    const ref = cfg.modeModels[mode];
    if (!ref || all.some((item) => modelRefMatches(item, ref))) continue;
    const pinnedModel = routableModels.find((model) => modelKey(model).toLowerCase() === ref.toLowerCase());
    if (!pinnedModel) continue;
    const pinned = { ...resolveModel(pinnedModel, cfg), capabilityMode: mode, supported: true };
    if (matchesModelFilter(pinned, cfg.modelFilter)) all.push(pinned);
  }
  all.sort((a, b) => variantKey(a).localeCompare(variantKey(b)));

  return { all };
}

export function selectClassifierModel(
  pool: Pool,
  cfg: RouterConfig,
  state: ClassifierState,
  turn: number,
): ResolvedModel | undefined {
  if (!cfg.classifier.enabled) return undefined;

  if (!cfg.classifierModel) return undefined;

  const ref = cfg.classifierModel.toLowerCase();
  const candidates = pool.all.filter((item) => !isClassifierModelDisabled(state, modelKey(item.model), turn));
  return candidates.find((item) =>
    modelKey(item.model).toLowerCase() === ref ||
    variantKey(item).toLowerCase() === ref ||
    item.canonicalKey?.toLowerCase() === ref
  );
}

export function resolveModel(model: Model<Api>, cfg: RouterConfig = DEFAULT_CONFIG): ResolvedModel {
  return resolveModelVariants(model, cfg)[0];
}

export function resolveModelVariants(model: Model<Api>, cfg: RouterConfig = DEFAULT_CONFIG): ResolvedModel[] {
  const key = modelKey(model);
  const resolutions = resolveCanonicalModels(key, cfg.capabilitySource);
  const resolution = resolutions[0];
  const override = findModelOverride(cfg, key, resolution.canonical?.key ?? null);
  // Apply personal economics only to price. Time-of-day windows are re-applied per turn so the clock
  // can cross a configured window boundary mid-session without rebuilding the pool.
  const coef = override?.costCoef ?? 1;

  if (override) {
    const base = override.priceBlended ?? blendedPriceFromCost(model) ?? resolution.priceBlended;
    return [{
      model,
      acceptsImage: model.input?.includes("image") ?? false,
      canonicalKey: override.canonical ?? resolution.canonical?.key ?? normalizeModelKey(key),
      capabilityMode: override.capabilityMode ?? resolution.capabilityMode,
      profiles: override.profiles ?? resolution.profiles,
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
      capabilityMode: entry.capabilityMode,
      profiles: entry.profiles,
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
  return { all: pool.all.map(reprice) };
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
    if (override && hasRoutingOverride(override)) return override;
  }
  return undefined;
}

function hasRoutingOverride(override: ModelOverride): boolean {
  const recognized = new Set([
    "canonical", "capabilityMode", "profiles", "intelligence", "priceBlended", "scores", "tps",
    "benchmarkEffort", "costCoef", "costCoefHours",
  ]);
  return Object.keys(override).some((key) => recognized.has(key));
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
  forced: { mode: CapabilityMode } | { model: string } | undefined,
  cfg: RouterConfig,
  classifier: TaskClassifier = HEURISTIC_CLASSIFIER,
): Decision {
  if (forced && "model" in forced) return { cls: "model", score: 1, chosen: forced.model, modeBucket: 3, reason: "forced model" };
  if (forced && "mode" in forced) {
    const modeBucket = CAPABILITY_MODE_ORDER.indexOf(forced.mode);
    return {
      cls: forced.mode,
      score: MODE_SCORE_BOUNDS[modeBucket][0],
      chosen: "",
      modeBucket,
      requestedProfile: inferFallbackProfile(context),
      reason: `forced ${forced.mode}`,
    };
  }

  const classification = classifier.classify(context, cfg);
  const requestedProfile = classification.profile ?? inferFallbackProfile(context);
  const modeBucket = capabilityModeBucketIndex(classification.mode);
  const score = classification.score ?? representativeModeScore(classification.mode);
  return {
    cls: classification.mode,
    score,
    chosen: "",
    modeBucket: modeBucket,
    requestedProfile,
    reason: classification.reason,
  };
}

/** Map the language-neutral task score to one of the four discrete capability modes. */
export function autoModeBucket(score: number): number {
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
    const mode = CAPABILITY_MODE_ORDER[autoModeBucket(score)];
    return { mode, score, profile: inferRequestedProfile(context), reason: "heuristic" };
  },
};

export function parseClassificationOutput(text: string): ClassificationResult | undefined {
  const lower = text.toLowerCase();
  const mode = matchEnum(lower, ["low", "medium", "high", "ultra"]);
  if (!mode) return undefined;

  const profile = matchEnum(lower, ["deep", "fast", "coder", "balanced", "vision"]);
  const score = parseScore(lower);
  return {
    mode,
    profile,
    score,
    reason: "llm-classifier",
  };
}

function matchEnum<const T extends string>(text: string, values: readonly T[]): T | undefined {
  const alternation = values.join("|");
  const keyed = text.match(new RegExp(`\\b(?:mode|capability|level|profile|task_profile)\\s*[:=]\\s*(${alternation})\\b`));
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

function capabilityModeBucketIndex(mode: CapabilityMode): number {
  return CAPABILITY_MODE_ORDER.indexOf(mode);
}

function representativeModeScore(mode: CapabilityMode): number {
  return [0.15, 0.4, 0.63, 0.86][capabilityModeBucketIndex(mode)] ?? 0.4;
}

export function inferRequestedProfile(context: Context): ModelProfile {
  if (contextHasImage(context)) return "vision";
  return "balanced";
}

/** Use the general index when a profile-specific sub-index is unavailable. */
export function axisValue(item: ResolvedModel, profile: ModelProfile): number {
  if (profile === "coder") return item.scores?.coding ?? item.intelligence;
  if (profile === "deep") return item.scores?.agentic != null ? item.scores.agentic * 100 : item.intelligence;
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

function nearestModeCandidates(items: ResolvedModel[], targetMode: CapabilityMode): ResolvedModel[] {
  const targetRank = CAPABILITY_MODE_ORDER.indexOf(targetMode);
  const ranked = items
    .map((item) => ({ item, rank: item.capabilityMode ? CAPABILITY_MODE_ORDER.indexOf(item.capabilityMode) : -1 }))
    .filter(({ rank }) => rank >= 0);
  const strongerRank = Math.min(...ranked.filter(({ rank }) => rank > targetRank).map(({ rank }) => rank));
  if (Number.isFinite(strongerRank)) return ranked.filter(({ rank }) => rank === strongerRank).map(({ item }) => item);
  const weakerRank = Math.max(...ranked.filter(({ rank }) => rank < targetRank).map(({ rank }) => rank));
  return Number.isFinite(weakerRank)
    ? ranked.filter(({ rank }) => rank === weakerRank).map(({ item }) => item)
    : [];
}

function modelRefMatches(item: ResolvedModel, ref: string): boolean {
  const normalized = ref.toLowerCase();
  return modelKey(item.model).toLowerCase() === normalized ||
    variantKey(item).toLowerCase() === normalized ||
    item.canonicalKey?.toLowerCase() === normalized;
}

function selectByPolicy(items: ResolvedModel[], profile: ModelProfile, policy: SelectionPolicy): ResolvedModel {
  const capability = (item: ResolvedModel) => profile === "fast" ? (item.tps ?? 0) : axisValue(item, profile);
  return [...items].sort((a, b) => policy === "cost"
    ? a.priceBlended - b.priceBlended || capability(b) - capability(a) || modelKey(a.model).localeCompare(modelKey(b.model))
    : capability(b) - capability(a) || a.priceBlended - b.priceBlended || modelKey(a.model).localeCompare(modelKey(b.model))
  )[0];
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

  const bucket = Math.max(0, Math.min(CAPABILITY_MODE_ORDER.length - 1, decision.modeBucket));
  const targetMode = CAPABILITY_MODE_ORDER[bucket];
  const pinnedRef = cfg.modeModels[targetMode];
  const pinned = pinnedRef ? eligible.find((item) => modelRefMatches(item, pinnedRef)) : undefined;
  if (pinned) {
    const selected = { ...pinned, capabilityMode: targetMode };
    return buildSelection(selected, eligible, profile, `${targetMode}/pinned: ${pinnedRef}${overflowNote(overflow)}`);
  }

  const exact = eligible.filter((item) => item.capabilityMode === targetMode);
  const candidates = exact.length > 0 ? exact : nearestModeCandidates(eligible, targetMode);
  const pickFrom = candidates.length > 0 ? candidates : eligible;
  const selected = selectByPolicy(pickFrom, profile, cfg.selectionPolicy);
  const actualMode = selected.capabilityMode ?? "unknown";
  const fallback = actualMode === targetMode ? "" : `; ${targetMode} unavailable → ${actualMode}`;
  const metric = profile === "fast" ? `${(selected.tps ?? 0).toFixed(0)} tps` : `${axisValue(selected, profile).toFixed(1)} capability`;
  const reason = `${targetMode}/${cfg.selectionPolicy}: ${metric}@$${selected.priceBlended}${fallback}${overflowNote(overflow)}`;
  return buildSelection(selected, pickFrom, profile, reason);
}

function buildSelection(
  selected: ResolvedModel,
  candidates: ResolvedModel[],
  profile: ModelProfile,
  reason: string,
): Selection {
  return {
    selected,
    profile,
    benchmarkEffort: selected.benchmarkEffort,
    reason,
    alternatives: candidates.filter((item) => variantKey(item) !== variantKey(selected)).map(variantKey),
  };
}

function overflowNote(overflow: boolean): string {
  return overflow ? "; context may overflow" : "";
}

// ── Cross-turn cache-aware stickiness ────────────────────────────────────────
// Session stickiness is intentionally asymmetric: keep the warm model for the same or a lower mode,
// and sacrifice its cache only when the required capability mode increases.

export function createRoutingState(): RoutingState {
  return { lastSwitchTurn: Number.NEGATIVE_INFINITY, observedCacheReadRatio: 0, realizedCostByModel: {} };
}

/** Monotonic user-turn counter (number of user messages) — no harness turn hooks needed. */
export function userTurnIndex(context: Context): number {
  return context.messages.reduce((count, message) => (message.role === "user" ? count + 1 : count), 0);
}

/** Keep the current model sticky; automatically switch only for a higher capability mode. */
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
  if (!lease || !leaseItem) return { selection: fresh, cacheReason: "no-lease" };
  const needsImage = contextHasImage(context);
  const exceedsWindow = Boolean(leaseItem.model.contextWindow && estimateContextTokens(context) > leaseItem.model.contextWindow);
  if ((needsImage && !leaseItem.acceptsImage) || exceedsWindow) {
    return { selection: fresh, cacheReason: "lease-ineligible" };
  }
  if (modelKey(fresh.selected.model) === lease.modelKey) return { selection: fresh, cacheReason: "same-model" };

  const leaseMode = lease.capabilityMode ?? leaseItem.capabilityMode;
  const leaseRank = leaseMode ? CAPABILITY_MODE_ORDER.indexOf(leaseMode) : -1;
  const freshRank = fresh.selected.capabilityMode ? CAPABILITY_MODE_ORDER.indexOf(fresh.selected.capabilityMode) : -1;
  if (freshRank > leaseRank) {
    return {
      selection: { ...fresh, reason: `${fresh.reason}; capability upgrade ${leaseMode ?? "unknown"}→${fresh.selected.capabilityMode ?? "unknown"}` },
      cacheReason: "capability-upgrade",
    };
  }

  const stay = leaseSelection({ ...leaseItem, capabilityMode: leaseMode }, fresh, fresh.profile);
  return {
    selection: { ...stay, reason: `sticky session: keep ${leaseMode ?? "unknown"} model` },
    cacheReason: "sticky-session",
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
    capabilityMode: selected.capabilityMode,
    cost: { input: selected.model.cost.input, cacheRead: selected.model.cost.cacheRead, cacheWrite: selected.model.cost.cacheWrite },
    warmTokens: totalPromptTokens,
    establishedAtTurn: state.lease?.modelKey === key ? state.lease.establishedAtTurn : turn,
    lastUsedTurn: turn,
  };
}

function movingAverage(previous: number, next: number, weight: number): number {
  return previous === 0 ? next : previous * (1 - weight) + next * weight;
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
