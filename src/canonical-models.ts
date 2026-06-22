export type CostTier = "cheap" | "standard" | "premium" | "unknown";
export type ModelProfile = "deep" | "fast" | "coder" | "balanced" | "vision" | "frontier";

export interface CanonicalMeta {
  key: string;
  costTier: CostTier;
  profiles: ModelProfile[];
  frontier: boolean;
  source?: string;
}

export const CANONICAL_MODELS: CanonicalMeta[] = [
  { key: "gpt-5.5", costTier: "premium", profiles: ["coder", "balanced", "frontier"], frontier: true },
  { key: "gpt-5.4", costTier: "premium", profiles: ["coder", "balanced", "frontier"], frontier: true },
  { key: "gpt-5.4-mini", costTier: "standard", profiles: ["coder", "balanced"], frontier: false },
  { key: "gpt-5.3-codex-spark", costTier: "standard", profiles: ["coder", "fast"], frontier: false },
  { key: "deepseek-v4-pro", costTier: "standard", profiles: ["deep", "balanced"], frontier: false },
  { key: "deepseek-v4-flash", costTier: "cheap", profiles: ["fast", "balanced"], frontier: false },
  { key: "glm-5.2", costTier: "premium", profiles: ["deep", "balanced"], frontier: true },
  { key: "kimi-k2.7-code", costTier: "standard", profiles: ["coder", "balanced"], frontier: false },
  { key: "kimi-k2.7-code-highspeed", costTier: "premium", profiles: ["fast", "coder"], frontier: false },
];
