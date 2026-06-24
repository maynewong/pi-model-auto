export type CostTier = "cheap" | "standard" | "premium" | "unknown";
export type ModelProfile = "deep" | "fast" | "coder" | "balanced" | "vision" | "frontier";

/**
 * Per-profile capability sub-scores. Used to pick the right Pareto axis per task:
 * coding tasks compare on `coding`, agentic/deep tasks on `agentic`, everything else
 * falls back to the synthetic `intelligence` index. Values are facts (benchmark scores),
 * transcribed offline — we ship only the derived constants for the models we route to,
 * never a third-party dataset. See docs/routing-redesign.md §6.
 */
export interface CanonicalScores {
  /** coding_index (~0–80). Axis for the `coder` profile. */
  coding?: number;
  /** terminalbench v2 (0–1). Axis for the `deep`/agentic profile; scaled ×100 at use. */
  agentic?: number;
  /** instruction-following (ifbench, 0–1). Informational. */
  ifbench?: number;
}

export interface CanonicalMeta {
  key: string;
  /** Synthetic intelligence index (~3–60). Axis for the `balanced` profile and the floor scale. */
  intelligence: number;
  /** List price, $/1M tokens, blended 3:1 input:output. NOT marginal/subscription cost. */
  priceBlended: number;
  scores?: CanonicalScores;
  /** Output tokens/sec. Axis for the `fast` profile. */
  tps?: number;
  costTier: CostTier;
  profiles: ModelProfile[];
  frontier: boolean;
  /** Provenance of the numeric fields. */
  source?: string;
}

const AA = "Artificial Analysis, 2026-06";

/**
 * Curated frontier + recent-two-generation models across major labs. The numeric fields
 * (intelligence/priceBlended/scores/tps) drive the data-driven Pareto routing in router-core;
 * costTier/profiles/frontier remain as display hints and pool-bucketing only.
 *
 * `key` matches the provider model id (substring, longest-match wins), so dotted vendor naming
 * is intentional. Add models you actually have access to; unmatched keys are simply inert.
 */
export const CANONICAL_MODELS: CanonicalMeta[] = [
  // OpenAI
  { key: "gpt-5.5", intelligence: 53.1, priceBlended: 11.25, scores: { coding: 71.6, agentic: 0.794, ifbench: 0.716 }, tps: 83, costTier: "premium", profiles: ["coder", "balanced", "frontier"], frontier: true, source: AA },
  { key: "gpt-5.4", intelligence: 51.4, priceBlended: 5.625, scores: { coding: 71.1, agentic: 0.783, ifbench: 0.739 }, tps: 168, costTier: "premium", profiles: ["coder", "balanced", "frontier"], frontier: true, source: AA },
  { key: "gpt-5.4-mini", intelligence: 40.0, priceBlended: 1.688, scores: { coding: 56.1, agentic: 0.592, ifbench: 0.733 }, tps: 202, costTier: "standard", profiles: ["coder", "balanced"], frontier: false, source: AA },
  { key: "gpt-5.4-nano", intelligence: 38.2, priceBlended: 0.463, scores: { coding: 56.1, agentic: 0.607, ifbench: 0.759 }, tps: 168, costTier: "cheap", profiles: ["coder", "fast"], frontier: false, source: AA },
  { key: "gpt-5.3-codex-spark", intelligence: 44.3, priceBlended: 4.813, scores: { coding: 62.0, agentic: 0.62, ifbench: 0.754 }, tps: 130, costTier: "standard", profiles: ["coder", "fast"], frontier: false, source: `${AA} (coding/agentic estimated)` },
  { key: "gpt-oss-120b", intelligence: 23.8, priceBlended: 0.262, scores: { coding: 30.4, agentic: 0.262, ifbench: 0.690 }, tps: 347, costTier: "cheap", profiles: ["balanced"], frontier: false, source: AA },
  // Anthropic
  { key: "claude-fable-5", intelligence: 59.9, priceBlended: 20, scores: { coding: 76.5, agentic: 0.846, ifbench: 0.635 }, tps: 70, costTier: "premium", profiles: ["deep", "coder", "balanced", "frontier"], frontier: true, source: AA },
  { key: "claude-opus-4-8", intelligence: 55.7, priceBlended: 10, scores: { coding: 74.3, agentic: 0.846, ifbench: 0.622 }, tps: 70, costTier: "premium", profiles: ["deep", "coder", "balanced", "frontier"], frontier: true, source: AA },
  { key: "claude-opus-4-7", intelligence: 53.5, priceBlended: 10, scores: { coding: 73.6, agentic: 0.831, ifbench: 0.586 }, tps: 58, costTier: "premium", profiles: ["deep", "coder", "balanced"], frontier: false, source: AA },
  { key: "claude-sonnet-4-6", intelligence: 47.2, priceBlended: 6, scores: { coding: 63.0, agentic: 0.712, ifbench: 0.566 }, tps: 69, costTier: "premium", profiles: ["coder", "balanced"], frontier: false, source: AA },
  { key: "claude-4-5-haiku", intelligence: 29.6, priceBlended: 2, scores: { coding: 43.9, agentic: 0.442, ifbench: 0.543 }, tps: 173, costTier: "standard", profiles: ["fast", "balanced"], frontier: false, source: AA },
  // Google
  { key: "gemini-3.5-flash", intelligence: 50.2, priceBlended: 3.375, scores: { coding: 70.1, agentic: 0.787, ifbench: 0.763 }, tps: 247, costTier: "premium", profiles: ["coder", "balanced", "frontier"], frontier: true, source: AA },
  { key: "gemini-3.1-pro", intelligence: 46.5, priceBlended: 4.5, scores: { coding: 68.8, agentic: 0.738, ifbench: 0.771 }, tps: 152, costTier: "premium", profiles: ["deep", "balanced", "frontier"], frontier: true, source: AA },
  { key: "gemini-3.1-flash-lite", intelligence: 25.0, priceBlended: 0.563, scores: { coding: 34.7, agentic: 0.311, ifbench: 0.772 }, tps: 355, costTier: "cheap", profiles: ["fast", "balanced"], frontier: false, source: AA },
  // DeepSeek
  { key: "deepseek-v4-pro", intelligence: 44.3, priceBlended: 0.544, scores: { coding: 59.4, agentic: 0.640, ifbench: 0.765 }, tps: 104, costTier: "standard", profiles: ["deep", "balanced"], frontier: false, source: AA },
  { key: "deepseek-v4-flash", intelligence: 40.3, priceBlended: 0.175, scores: { coding: 56.2, agentic: 0.618, ifbench: 0.792 }, tps: 113, costTier: "cheap", profiles: ["fast", "balanced"], frontier: false, source: AA },
  // xAI
  { key: "grok-4.3", intelligence: 37.6, priceBlended: 1.563, scores: { coding: 42.2, agentic: 0.397, ifbench: 0.813 }, tps: 185, costTier: "standard", profiles: ["balanced"], frontier: false, source: AA },
  // Alibaba Qwen
  { key: "qwen3.7-max", intelligence: 46.0, priceBlended: 3.75, scores: { coding: 66.0, agentic: 0.745, ifbench: 0.805 }, tps: 203, costTier: "premium", profiles: ["coder", "balanced", "frontier"], frontier: true, source: AA },
  { key: "qwen3.7-plus", intelligence: 39.0, priceBlended: 0.59, scores: { coding: 55.9, agentic: 0.610, ifbench: 0.780 }, tps: 51, costTier: "standard", profiles: ["coder", "balanced"], frontier: false, source: AA },
  { key: "qwen3.6-plus", intelligence: 39.6, priceBlended: 1.125, scores: { coding: 54.5, agentic: 0.614, ifbench: 0.752 }, tps: 52, costTier: "standard", profiles: ["coder", "balanced"], frontier: false, source: AA },
  // Z AI GLM
  { key: "glm-5.2", intelligence: 51.1, priceBlended: 2.15, scores: { coding: 68.8, agentic: 0.779, ifbench: 0.733 }, tps: 104, costTier: "premium", profiles: ["deep", "balanced"], frontier: true, source: AA },
  { key: "glm-5.1", intelligence: 40.2, priceBlended: 2.15, scores: { coding: 55.8, agentic: 0.618, ifbench: 0.763 }, tps: 105, costTier: "standard", profiles: ["deep", "balanced"], frontier: false, source: AA },
  // Kimi (Moonshot)
  { key: "kimi-k2.7-code-highspeed", intelligence: 41.9, priceBlended: 1.712, scores: { coding: 60.8, agentic: 0.674, ifbench: 0.631 }, tps: 180, costTier: "premium", profiles: ["fast", "coder"], frontier: false, source: `${AA} (highspeed serving of kimi-k2.7-code)` },
  { key: "kimi-k2.7-code", intelligence: 41.9, priceBlended: 1.712, scores: { coding: 60.8, agentic: 0.674, ifbench: 0.631 }, tps: 53, costTier: "standard", profiles: ["coder", "balanced"], frontier: false, source: AA },
  { key: "kimi-k2.6", intelligence: 42.8, priceBlended: 1.712, scores: { coding: 56.0, agentic: 0.573, ifbench: 0.760 }, tps: 61, costTier: "standard", profiles: ["coder", "balanced"], frontier: false, source: AA },
  // MiniMax
  { key: "minimax-m3", intelligence: 44.4, priceBlended: 0.525, scores: { coding: 58.6, agentic: 0.652, ifbench: 0.829 }, tps: 56, costTier: "standard", profiles: ["balanced", "coder"], frontier: false, source: AA },
  { key: "minimax-m2.7", intelligence: 38.1, priceBlended: 0.525, scores: { coding: 52.6, agentic: 0.554, ifbench: 0.757 }, tps: 48, costTier: "standard", profiles: ["coder", "balanced"], frontier: false, source: AA },
  // Xiaomi MiMo
  { key: "mimo-v2.5-pro", intelligence: 42.2, priceBlended: 0.544, scores: { coding: 60.2, agentic: 0.652, ifbench: 0.799 }, tps: 51, costTier: "standard", profiles: ["coder", "balanced"], frontier: false, source: AA },
  // Meta
  { key: "muse-spark", intelligence: 43.1, priceBlended: 0, scores: { coding: 58.6, agentic: 0.622, ifbench: 0.759 }, tps: 60, costTier: "standard", profiles: ["deep", "coder", "balanced"], frontier: false, source: AA },
  { key: "llama-4-maverick", intelligence: 14.3, priceBlended: 0.475, scores: { coding: 16.3, agentic: 0.0787, ifbench: 0.430 }, tps: 122, costTier: "cheap", profiles: ["fast", "balanced"], frontier: false, source: AA },
  // NVIDIA
  { key: "nemotron-3-ultra", intelligence: 37.8, priceBlended: 1.175, scores: { coding: 49.3, agentic: 0.539, ifbench: 0.814 }, tps: 148, costTier: "standard", profiles: ["balanced"], frontier: false, source: AA },
];

/**
 * Per-model results from the Ramp SWE-Bench run (mini-swe-agent harness, 80 tasks): real agentic
 * resolve-rate and measured per-task cost (API list pricing, prompt-cache included). This is a
 * SEPARATE source from the Artificial Analysis numbers above — the router consumes one or the other
 * (`capabilitySource`), never a merge: mixing real outcomes and synthetic scores on one scale is
 * meaningless. Keyed by canonical model key. A model absent here has no Ramp result and is therefore
 * not auto-routed when `capabilitySource` is `ramp` (reach it via `modelOverrides` or a forced route).
 *
 * Caveat: a single harness/run, reasoning fixed at high/xhigh, billed at API list (no subscription),
 * no vision and no throughput metric. It is a real-task coding slice, not a universal capability score.
 */
export interface RampMeta {
  /** Canonical model key; matches a `CanonicalMeta.key` above. */
  key: string;
  /** SWE-bench resolve rate, 0–100. The capability axis for every profile under the `ramp` source. */
  resolveRate: number;
  /** Mean measured cost per task, USD (API list pricing). The Pareto cost axis under `ramp`. */
  costPerTask: number;
  /** Mean tool-call turns to complete. Informational (shown in `/router`). */
  turns: number;
  source: string;
}

const RAMP = "Ramp SWE-Bench (mini-swe-agent), 2026-06";

export const RAMP_MODELS: RampMeta[] = [
  { key: "claude-fable-5", resolveRate: 87.5, costPerTask: 2.66, turns: 48, source: RAMP },
  { key: "claude-opus-4-7", resolveRate: 83.8, costPerTask: 2.24, turns: 71, source: RAMP },
  { key: "gpt-5.5", resolveRate: 83.8, costPerTask: 1.81, turns: 52, source: RAMP },
  { key: "glm-5.2", resolveRate: 80.0, costPerTask: 1.88, turns: 98, source: RAMP },
  { key: "kimi-k2.7-code", resolveRate: 78.8, costPerTask: 0.89, turns: 77, source: RAMP },
  { key: "claude-opus-4-8", resolveRate: 77.5, costPerTask: 1.09, turns: 39, source: RAMP },
  { key: "gemini-3.1-pro", resolveRate: 73.8, costPerTask: 1.03, turns: 55, source: RAMP },
  { key: "claude-sonnet-4-6", resolveRate: 72.5, costPerTask: 0.79, turns: 49, source: RAMP },
  { key: "gpt-5.4", resolveRate: 72.5, costPerTask: 0.66, turns: 28, source: RAMP },
  { key: "kimi-k2.6", resolveRate: 72.5, costPerTask: 0.69, turns: 81, source: RAMP },
  { key: "glm-5.1", resolveRate: 71.2, costPerTask: 1.08, turns: 78, source: RAMP },
  { key: "deepseek-v4-pro", resolveRate: 65.0, costPerTask: 0.80, turns: 55, source: RAMP },
  { key: "qwen3.6-plus", resolveRate: 65.0, costPerTask: 0.29, turns: 107, source: RAMP },
  { key: "qwen3.7-plus", resolveRate: 61.3, costPerTask: 0.16, turns: 54, source: RAMP },
  { key: "gpt-5.4-mini", resolveRate: 58.8, costPerTask: 0.23, turns: 29, source: RAMP },
  { key: "claude-4-5-haiku", resolveRate: 50.0, costPerTask: 0.51, turns: 72, source: RAMP },
  { key: "gpt-5.4-nano", resolveRate: 48.8, costPerTask: 0.09, turns: 54, source: RAMP },
];

const RAMP_BY_KEY = new Map(RAMP_MODELS.map((entry) => [entry.key, entry]));

export function findRampModel(canonicalKey: string | null | undefined): RampMeta | undefined {
  return canonicalKey ? RAMP_BY_KEY.get(canonicalKey) : undefined;
}
