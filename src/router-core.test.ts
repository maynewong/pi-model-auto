import { describe, expect, it } from "vitest";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, buildAutoPool, normalizeModelKey, resolveCanonicalModel, selectFromPool } from "./router-core.ts";

function model(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function context(text: string): Context {
  return { messages: [{ role: "user", content: text, timestamp: Date.now() }] };
}

describe("canonical model routing", () => {
  it("normalizes conservatively", () => {
    expect(normalizeModelKey("magi/Kimi-K2.7-Code-Highspeed(high)")).toBe("kimi-k2.7-code-highspeed");
    expect(normalizeModelKey("vibeproxy/gpt-5.5(medium)")).toBe("gpt-5.5");
    expect(normalizeModelKey("magi/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("uses longest substring matching", () => {
    expect(resolveCanonicalModel("magi/kimi-k2.7-code-highspeed").canonical?.key).toBe("kimi-k2.7-code-highspeed");
    expect(resolveCanonicalModel("magi/kimi-k2.7-code").canonical?.key).toBe("kimi-k2.7-code");
  });

  it("does not classify frontier models as cheap when costs are zero", () => {
    const pool = buildAutoPool([
      model("magi-codex", "gpt-5.5"),
      model("magi-codex", "gpt-5.4"),
      model("magi", "deepseek-v4-flash"),
      model("magi", "kimi-k2.7-code-highspeed"),
    ]);

    expect(pool.cheapPool.map((item) => item.canonicalKey)).toEqual(["deepseek-v4-flash"]);
    expect(pool.strongPool.map((item) => item.canonicalKey).sort()).toEqual([
      "gpt-5.4",
      "gpt-5.5",
      "kimi-k2.7-code-highspeed",
    ]);
  });

  it("keeps unknown models out of cheap/strong inferred pools", () => {
    const pool = buildAutoPool([model("local", "Qwen3.6-35B-A3B-UD-MLX-4bit")]);
    expect(pool.cheapPool).toHaveLength(0);
    expect(pool.strongPool).toHaveLength(0);
    expect(pool.unknownPool).toHaveLength(1);
    expect(pool.unknownPool[0].confidence).toBe("low");
  });

  it("allows users to classify unknown models with modelOverrides", () => {
    const pool = buildAutoPool([model("local", "Qwen3.6-35B-A3B-UD-MLX-4bit")], {
      ...DEFAULT_CONFIG,
      modelOverrides: {
        "local/Qwen3.6-35B-A3B-UD-MLX-4bit": {
          canonical: "qwen3.6-35b-a3b-ud-mlx-4bit",
          costTier: "cheap",
          profiles: ["fast", "coder"],
          frontier: false,
        },
      },
    });

    expect(pool.unknownPool).toHaveLength(0);
    expect(pool.cheapPool[0].canonicalKey).toBe("qwen3.6-35b-a3b-ud-mlx-4bit");
    expect(pool.cheapPool[0].profiles).toEqual(["fast", "coder"]);
    expect(pool.cheapPool[0].matchReason).toBe("user override for unknown model");
  });

  it("selects deep and fast profiles from the strong pool", () => {
    const pool = buildAutoPool([
      model("magi-codex", "gpt-5.5"),
      model("magi", "glm-5.2"),
      model("magi", "kimi-k2.7-code-highspeed"),
    ]);

    expect(selectFromPool("strong", pool, context("debug root cause and plan architecture"), undefined, DEFAULT_CONFIG)?.selected.canonicalKey).toBe("glm-5.2");
    expect(selectFromPool("strong", pool, context("need a fast coding response"), undefined, DEFAULT_CONFIG)?.selected.canonicalKey).toBe("kimi-k2.7-code-highspeed");
    expect(selectFromPool("strong", pool, context("general coding task"), undefined, DEFAULT_CONFIG)?.selected.canonicalKey).toBe("gpt-5.5");
  });
});
