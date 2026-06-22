import { describe, expect, it } from "vitest";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_CONFIG,
  buildAutoPool,
  normalizeModelKey,
  resolveCanonicalModel,
  routingTurnKey,
  selectFromPool,
  shouldReuseTurnSelection,
} from "./router-core.ts";

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

function toolContinuationContext(text: string): Context {
  return {
    messages: [
      { role: "user", content: text, timestamp: 1 },
      {
        role: "assistant",
        api: "openai-completions",
        provider: "gateway",
        model: "deepseek-v4-flash",
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "git status" } }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: " M file.ex" }],
        isError: false,
        timestamp: 3,
      },
    ],
  };
}

describe("canonical model routing", () => {
  it("enables quota-aware routing by default without in-turn retry", () => {
    expect(DEFAULT_CONFIG.quota).toMatchObject({
      enabled: true,
      reserveRatio: 0.05,
      inTurnRetry: false,
      maxRetries: 2,
      defaultCooldownMs: 300_000,
    });
  });

  it("normalizes conservatively", () => {
    expect(normalizeModelKey("gateway/Kimi-K2.7-Code-Highspeed(high)")).toBe("kimi-k2.7-code-highspeed");
    expect(normalizeModelKey("vibeproxy/gpt-5.5(medium)")).toBe("gpt-5.5");
    expect(normalizeModelKey("gateway/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("uses longest substring matching", () => {
    expect(resolveCanonicalModel("gateway/kimi-k2.7-code-highspeed").canonical?.key).toBe("kimi-k2.7-code-highspeed");
    expect(resolveCanonicalModel("gateway/kimi-k2.7-code").canonical?.key).toBe("kimi-k2.7-code");
  });

  it("does not classify frontier models as cheap when costs are zero", () => {
    const pool = buildAutoPool([
      model("gateway-codex", "gpt-5.5"),
      model("gateway-codex", "gpt-5.4"),
      model("gateway", "deepseek-v4-flash"),
      model("gateway", "kimi-k2.7-code-highspeed"),
    ]);

    expect(pool.cheapPool.map((item) => item.canonicalKey)).toEqual(["deepseek-v4-flash"]);
    expect(pool.strongPool.map((item) => item.canonicalKey).sort()).toEqual([
      "gpt-5.4",
      "gpt-5.5",
      "kimi-k2.7-code-highspeed",
    ]);
  });

  it("filters models by provider/id/name/canonical substring", () => {
    const pool = buildAutoPool(
      [
        model("deepseek", "deepseek-v4-flash"),
        model("gateway", "deepseek-v4-flash"),
        model("gateway-codex", "gpt-5.5"),
        model("openai-codex", "gpt-5.5"),
      ],
      { ...DEFAULT_CONFIG, modelFilter: { include: ["gateway"], exclude: [] } },
    );

    expect(pool.all.map((item) => `${item.model.provider}/${item.model.id}`)).toEqual([
      "gateway/deepseek-v4-flash",
      "gateway-codex/gpt-5.5",
    ]);
    expect(pool.cheapPool.map((item) => item.model.provider)).toEqual(["gateway"]);
    expect(pool.strongPool.map((item) => item.model.provider)).toEqual(["gateway-codex"]);
  });

  it("applies exclude after include", () => {
    const pool = buildAutoPool(
      [model("gateway-codex", "gpt-5.5"), model("gateway", "glm-5.2")],
      { ...DEFAULT_CONFIG, modelFilter: { include: ["gateway"], exclude: ["codex"] } },
    );

    expect(pool.all.map((item) => `${item.model.provider}/${item.model.id}`)).toEqual(["gateway/glm-5.2"]);
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
      model("gateway-codex", "gpt-5.5"),
      model("gateway", "glm-5.2"),
      model("gateway", "kimi-k2.7-code-highspeed"),
    ]);

    expect(selectFromPool("strong", pool, context("debug root cause and plan architecture"), undefined, DEFAULT_CONFIG)?.selected.canonicalKey).toBe("glm-5.2");
    expect(selectFromPool("strong", pool, context("need a fast coding response"), undefined, DEFAULT_CONFIG)?.selected.canonicalKey).toBe("kimi-k2.7-code-highspeed");
    expect(selectFromPool("strong", pool, context("general coding task"), undefined, DEFAULT_CONFIG)?.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("keeps one routing key for tool continuations within the same user turn", () => {
    const firstRequest = context("创建 mr");
    const continuation = toolContinuationContext("创建 mr");
    const nextUser = {
      messages: [
        ...continuation.messages,
        { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-completions", provider: "gateway", model: "deepseek-v4-flash", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4 },
        { role: "user", content: "reply ok", timestamp: 5 },
      ],
    } satisfies Context;

    expect(routingTurnKey(continuation)).toBe(routingTurnKey(firstRequest));
    expect(shouldReuseTurnSelection(firstRequest)).toBe(false);
    expect(shouldReuseTurnSelection(continuation)).toBe(true);
    expect(routingTurnKey(nextUser)).not.toBe(routingTurnKey(firstRequest));
    expect(shouldReuseTurnSelection(nextUser)).toBe(false);
  });
});
