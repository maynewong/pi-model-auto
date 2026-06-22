import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { CANONICAL_MODELS, type CanonicalMeta, type CostTier, type ModelProfile } from "./canonical-models.ts";

export type Tier = "cheap" | "strong";
export type RouteClass = Tier | "model";
export type Confidence = "high" | "medium" | "low";

export interface CanonicalResolution {
  canonical: CanonicalMeta | null;
  costTier: CostTier;
  profiles: ModelProfile[];
  frontier: boolean;
  confidence: Confidence;
  reason: string;
}

export interface ResolvedModel {
  model: Model<Api>;
  acceptsImage: boolean;
  canonicalKey: string | null;
  costTier: CostTier;
  profiles: ModelProfile[];
  frontier: boolean;
  confidence: Confidence;
  matchReason: string;
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
  costTier: CostTier;
  profiles?: ModelProfile[];
  frontier?: boolean;
}

export interface ModelFilter {
  include: string[];
  exclude: string[];
}

export interface RouterConfig {
  threshold: number;
  weights: {
    contextTokens: number;
    lastUserLen: number;
    keyword: number;
    reasoning: number;
    toolDensity: number;
  };
  log: boolean;
  tierModels: Partial<Record<Tier, string>>;
  /** Restrict the automatically built pool by provider/id/name/canonical substring. Empty include means allow all. */
  modelFilter: ModelFilter;
  /** User-supplied metadata for unknown/private/local models. Keys may be provider/id, model id, or normalized model id. */
  modelOverrides: Record<string, ModelOverride>;
  forceStrongOnHighReasoning: boolean;
}

export interface Decision {
  cls: RouteClass;
  score: number;
  chosen: string;
  requestedProfile?: ModelProfile;
  reason?: string;
}

export interface Selection {
  selected: ResolvedModel;
  profile: ModelProfile;
  reason: string;
  alternatives: string[];
}

export const DEFAULT_CONFIG: RouterConfig = {
  threshold: 0.45,
  weights: {
    contextTokens: 0.25,
    lastUserLen: 0.15,
    keyword: 0.35,
    reasoning: 0.15,
    toolDensity: 0.1,
  },
  log: false,
  tierModels: {},
  modelFilter: { include: [], exclude: [] },
  modelOverrides: {},
  forceStrongOnHighReasoning: false,
};

export function normalizeModelKey(key: string): string {
  const withoutProvider = key.toLowerCase().split("/").at(-1) ?? key.toLowerCase();
  return withoutProvider.trim().replace(/\s*\((?:high|medium|low)\)\s*$/i, "");
}

export function resolveCanonicalModel(key: string): CanonicalResolution {
  const normalized = normalizeModelKey(key);
  const canonical = CANONICAL_MODELS
    .filter((entry) => normalized.includes(entry.key))
    .sort((a, b) => b.key.length - a.key.length)[0];

  if (!canonical) {
    return {
      canonical: null,
      costTier: "unknown",
      profiles: ["balanced"],
      frontier: false,
      confidence: "low",
      reason: "no canonical match",
    };
  }

  return {
    canonical,
    costTier: canonical.costTier,
    profiles: canonical.profiles,
    frontier: canonical.frontier,
    confidence: "high",
    reason: `canonical match: ${canonical.key}`,
  };
}

export function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function buildAutoPool(models: Model<Api>[], cfg: RouterConfig = DEFAULT_CONFIG): Pool {
  const all = models
    .filter((model) => model.provider !== "pi-router")
    .filter((model) => model.input?.includes("text"))
    .map((model) => resolveModel(model, cfg))
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

export function resolveModel(model: Model<Api>, cfg: RouterConfig = DEFAULT_CONFIG): ResolvedModel {
  const key = modelKey(model);
  const resolution = resolveCanonicalModel(key);
  const override = findModelOverride(cfg, key, resolution.canonical?.key ?? null);

  if (override) {
    return {
      model,
      acceptsImage: model.input?.includes("image") ?? false,
      canonicalKey: override.canonical ?? resolution.canonical?.key ?? normalizeModelKey(key),
      costTier: override.costTier,
      profiles: override.profiles ?? resolution.profiles,
      frontier: override.frontier ?? resolution.frontier,
      confidence: resolution.canonical ? "medium" : "high",
      matchReason: resolution.canonical
        ? `user override + ${resolution.reason}`
        : "user override for unknown model",
    };
  }

  return {
    model,
    acceptsImage: model.input?.includes("image") ?? false,
    canonicalKey: resolution.canonical?.key ?? null,
    costTier: resolution.costTier,
    profiles: resolution.profiles,
    frontier: resolution.frontier,
    confidence: resolution.confidence,
    matchReason: resolution.reason,
  };
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
): Decision {
  if (forced && "model" in forced) return { cls: "model", score: 1, chosen: forced.model, reason: "forced model" };
  if (forced && "tier" in forced) {
    return {
      cls: forced.tier,
      score: forced.tier === "strong" ? 1 : 0,
      chosen: "",
      requestedProfile: inferRequestedProfile(context),
      reason: "forced",
    };
  }

  const score = classify(context, options, cfg);
  return {
    cls: score >= cfg.threshold ? "strong" : "cheap",
    score,
    chosen: "",
    requestedProfile: inferRequestedProfile(context),
  };
}

export function classify(context: Context, options: SimpleStreamOptions | undefined, cfg: RouterConfig): number {
  const text = lastUserText(context).toLowerCase();
  const contextTokens = estimateContextTokens(context);
  const reasoning = options?.reasoning && ["medium", "high", "xhigh"].includes(options.reasoning) ? 1 : 0;
  const toolDensity = Math.min(1, countRecentToolResults(context) / 8);

  const raw =
    normalize(contextTokens, 8_000, 120_000) * cfg.weights.contextTokens +
    normalize(text.length, 120, 1_200) * cfg.weights.lastUserLen +
    keywordScore(text) * cfg.weights.keyword +
    reasoning * cfg.weights.reasoning +
    toolDensity * cfg.weights.toolDensity;

  return Math.max(0, Math.min(1, raw));
}

export function inferRequestedProfile(context: Context): ModelProfile {
  if (contextHasImage(context)) return "vision";

  const text = lastUserText(context).toLowerCase();
  if (/\b(root cause|debug|architecture|design|plan|race condition|concurrency)\b|根因|调试|架构|设计|方案|计划|并发/.test(text)) {
    return "deep";
  }
  if (/\b(fast|quick|high frequency|low latency|speed)\b|快速|快点|低延迟|高速/.test(text)) {
    return "fast";
  }
  if (/\b(code|coding|refactor|multi-file|implement|test|typescript|elixir|ruby|go)\b|代码|重构|实现|测试|多文件/.test(text)) {
    return "coder";
  }
  return "balanced";
}

export function selectFromPool(
  cls: Tier,
  pool: Pool,
  context: Context,
  options: SimpleStreamOptions | undefined,
  cfg: RouterConfig,
): Selection | undefined {
  let effectiveClass = cls;
  if (cfg.forceStrongOnHighReasoning && (options?.reasoning === "high" || options?.reasoning === "xhigh")) {
    effectiveClass = "strong";
  }

  const profile = inferRequestedProfile(context);
  const primary = effectiveClass === "cheap" ? pool.cheapPool : pool.strongPool;
  const fallback = effectiveClass === "cheap"
    ? [pool.standardPool, pool.strongPool, pool.unknownPool]
    : [pool.standardPool, pool.cheapPool, pool.unknownPool];
  const candidates = firstNonEmpty([primary, ...fallback]);
  if (!candidates) return undefined;

  const selected = rankCandidates(candidates, profile, context, options)[0];
  const alternatives = candidates.filter((item) => item !== selected).map((item) => modelKey(item.model));
  const degraded = primary.length === 0 ? `; ${effectiveClass} pool empty fallback` : "";
  const profileReason = selected.profiles.includes(profile) ? `${selected.costTier} + ${profile} match` : `${selected.costTier} + balanced/frontier fallback`;

  return {
    selected,
    profile,
    reason: `${profileReason}${degraded}`,
    alternatives,
  };
}

export function rankCandidates(
  candidates: ResolvedModel[],
  profile: ModelProfile,
  context: Context,
  options: SimpleStreamOptions | undefined,
): ResolvedModel[] {
  const contextTokens = estimateContextTokens(context);
  const needsImage = contextHasImage(context);

  return [...candidates].sort((a, b) => scoreCandidate(b, profile, needsImage, contextTokens, options) - scoreCandidate(a, profile, needsImage, contextTokens, options) || modelKey(a.model).localeCompare(modelKey(b.model)));
}

export function scoreCandidate(
  item: ResolvedModel,
  profile: ModelProfile,
  needsImage: boolean,
  contextTokens: number,
  _options: SimpleStreamOptions | undefined,
): number {
  let score = 0;
  if (item.profiles.includes(profile)) score += 100;
  if (profile === "balanced" && item.frontier) score += 80;
  if (profile === "coder" && item.frontier) score += 50;
  if (item.profiles.includes("balanced")) score += 20;
  if (item.frontier) score += 15;
  if (item.canonicalKey === "gpt-5.5") score += 5;
  if (needsImage && item.acceptsImage) score += 1000;
  if (needsImage && !item.acceptsImage) score -= 1000;
  if (item.model.contextWindow && contextTokens <= item.model.contextWindow * 0.8) score += 10;
  if (item.model.contextWindow && contextTokens > item.model.contextWindow * 0.8) score -= 1000;
  if (item.confidence === "low") score -= 50;
  return score;
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
  return resolveCostRank(a.costTier) - resolveCostRank(b.costTier) || modelKey(a.model).localeCompare(modelKey(b.model));
}

function firstNonEmpty<T>(pools: T[][]): T[] | undefined {
  return pools.find((items) => items.length > 0);
}

function countRecentToolResults(context: Context): number {
  return context.messages.slice(-12).filter((message) => message.role === "toolResult").length;
}

function keywordScore(text: string): number {
  const cheap = /\b(format|lint|typo|rename|docs?|readme|translate|summari[sz]e|grep|search)\b|格式化|排版|错别字|文档|翻译|总结|搜索|查找|简单/.test(text);
  const strong = /\b(architecture|design|debug|root cause|race condition|refactor|multi-file|security|performance|concurrency|plan)\b|架构|设计|根因|并发|性能|安全|重构|复杂|方案|计划/.test(text);
  if (strong) return 1;
  if (cheap) return 0;
  return 0.45;
}

function normalize(value: number, low: number, high: number): number {
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
}
