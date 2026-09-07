import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type ModelProfile = "deep" | "fast" | "coder" | "balanced" | "vision";

/**
 * Per-profile capability sub-scores used to rank models within a capability mode. Coding tasks use
 * `coding`, agentic/deep tasks use `agentic`, and missing values fall back to `intelligence`.
 * `agentic` is stored divided by 100 to preserve the package's existing 0–1 data contract.
 */
export interface CanonicalScores {
  /** coding_index (~0–80). Axis for the `coder` profile. */
  coding?: number;
  /** Artificial Analysis Agentic Index divided by 100. Axis for `deep`; scaled ×100 at use. */
  agentic?: number;
  /** instruction-following (ifbench, 0–1). Informational. */
  ifbench?: number;
}

export interface CanonicalMeta {
  key: string;
  /** Alternate provider or benchmark slugs that should resolve to this canonical key. */
  aliases?: string[];
  /** General Intelligence Index used for AA mode assignment and balanced ranking. */
  intelligence: number;
  /** List price, $/1M tokens, blended 3:1 input:output. */
  priceBlended: number;
  scores?: CanonicalScores;
  /** Output tokens/sec. Axis for the `fast` profile. */
  tps?: number;
  /** Pi-normalized effort used for the benchmark row, when the source reports one. */
  benchmarkEffort?: ThinkingLevel;
  profiles: ModelProfile[];
  /** Provenance of the numeric fields. */
  source?: string;
}

const AA_API = "Artificial Analysis Data API v4.2, fetched 2026-09-07";
const RAMP = "Ramp SWE-Bench (mini-swe-agent), 2026-08";

/**
 * Curated recent models across major labs. Most rows are AA-backed; Ramp-only rows can still resolve
 * under the default source without pretending to have AA scores. Capability and price fields drive
 * mode assignment and within-mode ranking.
 *
 * `key` matches the provider model id (substring, longest-match wins). Unmatched keys are inert.
 */
export const CANONICAL_MODELS: CanonicalMeta[] = [
  // OpenAI
  { key: "gpt-6-astra", intelligence: 54.7, priceBlended: 20, scores: { coding: 76.9, agentic: 0.516 }, tps: 62.47, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "gpt-5.6-sol", aliases: ["gpt-5-6-sol"], intelligence: 51.3, priceBlended: 8, scores: { coding: 77.4, agentic: 0.507 }, tps: 85.45, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "gpt-5.6-terra", aliases: ["gpt-5-6-terra"], intelligence: 46.8, priceBlended: 4.5, scores: { coding: 76.7, agentic: 0.439 }, tps: 109.94, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "gpt-5.6-luna", aliases: ["gpt-5-6-luna"], intelligence: 43.4, priceBlended: 0.45, scores: { coding: 71.4, agentic: 0.429 }, tps: 133.05, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "gpt-5.5", aliases: ["gpt-5-5"], intelligence: 45.6, priceBlended: 11.25, scores: { coding: 74.9, agentic: 0.375 }, tps: 84.71, benchmarkEffort: "xhigh", profiles: ["coder", "balanced"], source: AA_API },
  { key: "gpt-5.4", aliases: ["gpt-5-4"], intelligence: 42.8, priceBlended: 5.625, scores: { coding: 71.1 }, tps: 148.58, benchmarkEffort: "xhigh", profiles: ["coder", "balanced"], source: AA_API },
  { key: "gpt-5.4-mini", aliases: ["gpt-5-4-mini"], intelligence: 31.9, priceBlended: 1.6875, scores: { coding: 56.1, agentic: 0.198 }, tps: 155.73, benchmarkEffort: "xhigh", profiles: ["coder", "balanced"], source: AA_API },
  { key: "gpt-5.4-nano", aliases: ["gpt-5-4-nano"], intelligence: 30.9, priceBlended: 0.4625, scores: { coding: 56.1 }, tps: 171.66, benchmarkEffort: "xhigh", profiles: ["coder", "fast"], source: AA_API },
  { key: "gpt-4.1", aliases: ["gpt-4-1"], intelligence: 13.2, priceBlended: 3.5, tps: 160.72, profiles: ["fast", "balanced"], source: AA_API },
  { key: "gpt-oss-120b", intelligence: 15.6, priceBlended: 0.26, scores: { coding: 30.4, agentic: 0.063 }, tps: 162.16, benchmarkEffort: "high", profiles: ["balanced"], source: AA_API },
  // Anthropic
  { key: "claude-fable-5.1", aliases: ["claude-fable-5-1"], intelligence: 56.8, priceBlended: 20, scores: { coding: 81.6, agentic: 0.582 }, tps: 67.1, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "claude-opus-5", intelligence: 54.1, priceBlended: 10, scores: { coding: 78, agentic: 0.564 }, tps: 57.52, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "claude-fable-5", intelligence: 53.2, priceBlended: 20, scores: { coding: 76.5, agentic: 0.512 }, tps: 69.64, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "claude-opus-4-8", intelligence: 46.4, priceBlended: 10, scores: { coding: 74.3, agentic: 0.428 }, tps: 61.96, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "claude-opus-4-7", intelligence: 44.3, priceBlended: 10, scores: { coding: 73.6, agentic: 0.397 }, tps: 51.7, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "claude-opus-4-6", intelligence: 36.4, priceBlended: 10, tps: 42.97, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "claude-sonnet-5", intelligence: 45.1, priceBlended: 4, scores: { coding: 71.5, agentic: 0.445 }, tps: 74.6, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "claude-sonnet-4-6", intelligence: 38.5, priceBlended: 6, scores: { coding: 63, agentic: 0.333 }, tps: 58.93, benchmarkEffort: "xhigh", profiles: ["coder", "balanced"], source: AA_API },
  { key: "claude-4-5-haiku", aliases: ["claude-haiku-4-5"], intelligence: 22.5, priceBlended: 2, scores: { coding: 43.9, agentic: 0.104 }, tps: 99.76, benchmarkEffort: "high", profiles: ["fast", "balanced"], source: AA_API },
  // Google
  { key: "gemini-3.8-flash", aliases: ["gemini-3-8-flash"], intelligence: 47.1, priceBlended: 1.5, scores: { coding: 76.3, agentic: 0.412 }, benchmarkEffort: "high", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "gemini-3.7-flash", aliases: ["gemini-3-7-flash"], intelligence: 45.2, priceBlended: 1.5, scores: { coding: 76.1, agentic: 0.366 }, tps: 309.18, benchmarkEffort: "high", profiles: ["coder", "fast", "balanced"], source: AA_API },
  { key: "gemini-3.5-flash", aliases: ["gemini-3-5-flash"], intelligence: 41.9, priceBlended: 3.375, scores: { coding: 70.1, agentic: 0.274 }, tps: 205.75, benchmarkEffort: "high", profiles: ["coder", "balanced"], source: AA_API },
  { key: "gemini-3.1-pro", aliases: ["gemini-3.1-pro-preview", "gemini-3-1-pro-preview"], intelligence: 36.7, priceBlended: 4.5, scores: { coding: 68.8, agentic: 0.104 }, tps: 114.95, profiles: ["coder", "balanced"], source: AA_API },
  { key: "gemini-3.1-flash-lite", aliases: ["gemini-3-1-flash-lite-preview"], intelligence: 18.7, priceBlended: 0.5625, scores: { coding: 34.7, agentic: 0.033 }, tps: 291.79, profiles: ["fast", "balanced"], source: AA_API },
  // DeepSeek
  { key: "deepseek-v4-pro", intelligence: 42.1, priceBlended: 1.98, scores: { coding: 68.8, agentic: 0.425 }, tps: 65.92, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "deepseek-v4-flash", aliases: ["deepseek-flash"], intelligence: 40.8, priceBlended: 0.66, scores: { coding: 69.1, agentic: 0.419 }, tps: 134.18, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "fast", "balanced"], source: AA_API },
  // xAI
  { key: "grok-4.6", aliases: ["grok-4-6"], intelligence: 50.6, priceBlended: 3, scores: { coding: 76.8, agentic: 0.536 }, tps: 63.89, benchmarkEffort: "high", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "grok-4.5", aliases: ["grok-4-5"], intelligence: 45.5, priceBlended: 3, scores: { coding: 72.4, agentic: 0.424 }, tps: 57.57, benchmarkEffort: "high", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "grok-4.3", aliases: ["grok-4-3"], intelligence: 29.3, priceBlended: 1.5625, scores: { coding: 42.2, agentic: 0.173 }, tps: 141.27, benchmarkEffort: "high", profiles: ["balanced"], source: AA_API },
  // Alibaba Qwen
  { key: "qwen3.8-max", aliases: ["qwen3-8-max"], intelligence: 46.9, priceBlended: 3, scores: { coding: 71.8, agentic: 0.499 }, tps: 39.73, profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "qwen3.8-flash-next", aliases: ["qwen3-8-flash-next"], intelligence: 45.6, priceBlended: 0.23, scores: { coding: 73.1 }, tps: 65.96, profiles: ["coder", "balanced"], source: AA_API },
  { key: "qwen3.8-2.4t-a95b", aliases: ["qwen3-8-2-4t-a95b"], intelligence: 46.7, priceBlended: 3, scores: { coding: 71.9, agentic: 0.507 }, tps: 40.14, profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "qwen3.8-27b", aliases: ["qwen3-8-27b"], intelligence: 41.4, priceBlended: 1.125, scores: { coding: 68.1, agentic: 0.468 }, tps: 43.83, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "qwen3.7-max", aliases: ["qwen3-7-max"], intelligence: 37, priceBlended: 3.75, scores: { coding: 66, agentic: 0.239 }, tps: 202.32, profiles: ["coder", "fast", "balanced"], source: AA_API },
  { key: "qwen3.7-plus", aliases: ["qwen3p7-plus", "qwen3-7-plus"], intelligence: 30.8, priceBlended: 0.7, scores: { coding: 55.9 }, tps: 55.58, profiles: ["coder", "balanced"], source: AA_API },
  { key: "qwen3.6-plus", aliases: ["qwen3p6-plus", "qwen3-6-plus"], intelligence: 31.5, priceBlended: 1.125, scores: { coding: 54.5 }, tps: 55.28, profiles: ["coder", "balanced"], source: AA_API },
  // Z AI GLM
  { key: "glm-5.3", aliases: ["glm-5p3", "glm-5-3"], intelligence: 48.6, priceBlended: 2.15, scores: { coding: 74.8, agentic: 0.536 }, tps: 84.18, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "glm-5.3-flash", aliases: ["glm-5p3-flash", "glm-5-3-flash"], intelligence: 46.2, priceBlended: 0.2375, scores: { coding: 71.5, agentic: 0.515 }, tps: 46.82, profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "glm-5.2", aliases: ["glm-5p2", "glm-5-2"], intelligence: 42.5, priceBlended: 2.15, scores: { coding: 68.8, agentic: 0.397 }, tps: 71.39, benchmarkEffort: "xhigh", profiles: ["deep", "balanced"], source: AA_API },
  { key: "glm-5.1", aliases: ["glm-5p1", "glm-5-1"], intelligence: 31.9, priceBlended: 2, scores: { coding: 55.8, agentic: 0.254 }, tps: 51.63, profiles: ["deep", "balanced"], source: AA_API },
  // Kimi (Moonshot)
  { key: "kimi-k3", intelligence: 50.2, priceBlended: 6, scores: { coding: 76.2, agentic: 0.509 }, tps: 40.26, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "balanced"], source: AA_API },
  { key: "kimi-k2.7-code-highspeed", intelligence: 33.9, priceBlended: 1.7125, scores: { coding: 60.8 }, tps: 180, profiles: ["fast", "coder"], source: `${AA_API} (highspeed serving; capability copied from kimi-k2.7-code)` },
  { key: "kimi-k2.7-code", aliases: ["kimi-k2p7-code", "kimi-k2-7-code"], intelligence: 33.9, priceBlended: 1.7125, scores: { coding: 60.8 }, tps: 45.45, profiles: ["coder", "balanced"], source: AA_API },
  { key: "kimi-k2.6", aliases: ["kimi-k2p6", "kimi-k2-6"], intelligence: 35.8, priceBlended: 1.7125, scores: { coding: 61.8, agentic: 0.222 }, tps: 46.42, profiles: ["coder", "balanced"], source: AA_API },
  // MiniMax
  { key: "minimax-m3", intelligence: 35.7, priceBlended: 0.525, scores: { coding: 58.6, agentic: 0.31 }, tps: 86.27, profiles: ["balanced", "coder"], source: AA_API },
  { key: "minimax-m2.7", aliases: ["minimax-m2-7"], intelligence: 30.1, priceBlended: 0.525, scores: { coding: 52.6 }, tps: 71.44, profiles: ["coder", "balanced"], source: AA_API },
  // Xiaomi MiMo
  { key: "mimo-v2.5-pro", aliases: ["mimo-v2-5-pro"], intelligence: 32.6, priceBlended: 0.54, scores: { coding: 60.2, agentic: 0.227 }, tps: 35.32, profiles: ["coder", "balanced"], source: AA_API },
  // Meta
  { key: "muse-spark-1.3", aliases: ["muse-spark-1-3"], intelligence: 53, priceBlended: 2, scores: { coding: 76.3, agentic: 0.556 }, tps: 190.12, benchmarkEffort: "xhigh", profiles: ["deep", "coder", "fast", "balanced"], source: AA_API },
  { key: "muse-spark", intelligence: 35.8, priceBlended: 3, scores: { coding: 58.6 }, profiles: ["coder", "balanced"], source: `${AA_API} (pricing unavailable; fallback price)` },
  { key: "llama-4-maverick", intelligence: 8.5, priceBlended: 0.4225, scores: { coding: 16.3, agentic: 0.006 }, tps: 82.14, profiles: ["fast", "balanced"], source: AA_API },
  // NVIDIA
  { key: "nemotron-3-ultra", aliases: ["nvidia-nemotron-3-ultra-550b-a55b"], intelligence: 29.6, priceBlended: 1.1, scores: { coding: 49.3, agentic: 0.217 }, tps: 169.41, profiles: ["fast", "balanced"], source: AA_API },
];

/**
 * Per-model/effort results from the Ramp SWE-Bench run (mini-swe-agent harness, 78 tasks): real agentic
 * resolve-rate and measured per-task cost (API list pricing, prompt-cache included). This is a
 * SEPARATE source from the Artificial Analysis numbers above — the router consumes one or the other
 * (`capabilitySource`), never a merge: mixing real outcomes and synthetic scores on one scale is
 * meaningless. Keyed by canonical model key plus Pi-normalized effort. A model absent here has no Ramp
 * result and is therefore not auto-routed when `capabilitySource` is `ramp` (reach it via
 * `modelOverrides` or a forced route).
 *
 * Caveat: the current table has one published effort row per model across 78 tasks, billed at API
 * list (no subscription), no vision and no throughput metric. It is a real-task coding slice, not a
 * universal capability score.
 */
export interface RampMeta {
  /** Canonical model key; matches a `CanonicalMeta.key` above. */
  key: string;
  /** Pi-normalized effort used for this measured run. Provider values like `max` map through model metadata. */
  effort: ThinkingLevel;
  /** SWE-bench resolve rate, 0–100. The capability axis for every profile under the `ramp` source. */
  resolveRate: number;
  /** Mean measured cost per task, USD (API list pricing). */
  costPerTask: number;
  /** Mean tool-call turns to complete. Informational (shown in `/router`). */
  turns: number;
  source: string;
}

export const RAMP_MODELS: RampMeta[] = [
  { key: "claude-opus-5", effort: "high", resolveRate: 88.5, costPerTask: 1.84, turns: 52, source: RAMP },
  { key: "claude-fable-5", effort: "xhigh", resolveRate: 88.5, costPerTask: 2.62, turns: 48, source: RAMP },
  { key: "kimi-k3", effort: "high", resolveRate: 87.2, costPerTask: 1.6, turns: 91, source: RAMP },
  { key: "gpt-5.5", effort: "high", resolveRate: 83.3, costPerTask: 1.83, turns: 52, source: RAMP },
  { key: "claude-opus-4-7", effort: "xhigh", resolveRate: 83.3, costPerTask: 2.26, turns: 71, source: RAMP },
  { key: "gpt-5.6-sol", effort: "high", resolveRate: 83.3, costPerTask: 0.99, turns: 44, source: RAMP },
  { key: "grok-4.5", effort: "high", resolveRate: 82.1, costPerTask: 1.09, turns: 54, source: RAMP },
  { key: "glm-5.2", effort: "high", resolveRate: 82.1, costPerTask: 1.84, turns: 96, source: RAMP },
  { key: "kimi-k2.7-code", effort: "high", resolveRate: 80.8, costPerTask: 0.88, turns: 77, source: RAMP },
  { key: "claude-opus-4-6", effort: "high", resolveRate: 80.8, costPerTask: 1.41, turns: 57, source: RAMP },
  { key: "deepseek-v4-flash", effort: "high", resolveRate: 79.5, costPerTask: 0.12, turns: 92, source: RAMP },
  { key: "claude-opus-4-8", effort: "xhigh", resolveRate: 78.2, costPerTask: 1.09, turns: 39, source: RAMP },
  { key: "gpt-5.6-terra", effort: "high", resolveRate: 76.9, costPerTask: 0.26, turns: 29, source: RAMP },
  { key: "claude-sonnet-5", effort: "medium", resolveRate: 75.6, costPerTask: 1.19, turns: 49, source: RAMP },
  { key: "gemini-3.1-pro", effort: "high", resolveRate: 74.4, costPerTask: 1.03, turns: 55, source: RAMP },
  { key: "gpt-5.6-luna", effort: "high", resolveRate: 74.4, costPerTask: 0.04, turns: 36, source: RAMP },
  { key: "gpt-5.4", effort: "high", resolveRate: 74.4, costPerTask: 0.64, turns: 28, source: RAMP },
  { key: "claude-sonnet-4-6", effort: "medium", resolveRate: 73.1, costPerTask: 0.72, turns: 48, source: RAMP },
  { key: "kimi-k2.6", effort: "high", resolveRate: 73.1, costPerTask: 0.69, turns: 81, source: RAMP },
  { key: "glm-5.1", effort: "high", resolveRate: 70.5, costPerTask: 1.08, turns: 77, source: RAMP },
  { key: "qwen3.6-plus", effort: "high", resolveRate: 66.7, costPerTask: 0.29, turns: 105, source: RAMP },
  { key: "deepseek-v4-pro", effort: "high", resolveRate: 65.4, costPerTask: 0.81, turns: 55, source: RAMP },
  { key: "qwen3.7-plus", effort: "high", resolveRate: 62.8, costPerTask: 0.15, turns: 53, source: RAMP },
  { key: "gpt-5.4-mini", effort: "high", resolveRate: 60.3, costPerTask: 0.22, turns: 29, source: RAMP },
  { key: "gpt-5.4-nano", effort: "medium", resolveRate: 50, costPerTask: 0.09, turns: 54, source: RAMP },
  { key: "claude-4-5-haiku", effort: "high", resolveRate: 50, costPerTask: 0.49, turns: 72, source: RAMP },
  { key: "gpt-4.1", effort: "high", resolveRate: 15.4, costPerTask: 1.53, turns: 96, source: RAMP },
];

const RAMP_BY_KEY = new Map<string, RampMeta[]>();
for (const entry of RAMP_MODELS) {
  const variants = RAMP_BY_KEY.get(entry.key) ?? [];
  variants.push(entry);
  RAMP_BY_KEY.set(entry.key, variants);
}

export function findRampModel(canonicalKey: string | null | undefined): RampMeta | undefined {
  return findRampModels(canonicalKey)[0];
}

export function findRampModels(canonicalKey: string | null | undefined): RampMeta[] {
  return canonicalKey ? (RAMP_BY_KEY.get(canonicalKey) ?? []) : [];
}
