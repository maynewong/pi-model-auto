import { describe, expect, it } from "vitest";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  AA_WILLINGNESS,
  DEFAULT_CONFIG,
  buildAutoPool,
  decide,
  normalizeModelKey,
  resolveCanonicalModel,
  routingTurnKey,
  selectFromPool,
  shouldReuseTurnSelection,
  type RouterConfig,
} from "./router-core.ts";

// The default source is `ramp`; this is the explicit `aa` counterpart for tests that exercise the
// Artificial Analysis table (the two sources are never merged).
const AA: RouterConfig = { ...DEFAULT_CONFIG, capabilitySource: "aa", willingness: AA_WILLINGNESS };

function strongDecision(ctx: Context, cfg: RouterConfig = DEFAULT_CONFIG) {
  return decide(ctx, undefined, { tier: "strong" }, cfg);
}

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

  it("defaults to the Ramp capability source", () => {
    expect(DEFAULT_CONFIG.capabilitySource).toBe("ramp");
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

  it("draws capability numbers from the active source, never merged", () => {
    const ramp = resolveCanonicalModel("gateway/kimi-k2.7-code", "ramp");
    expect(ramp.supported).toBe(true);
    expect(ramp.intelligence).toBe(78.8); // resolve-rate
    expect(ramp.priceBlended).toBe(0.89); // measured cost per task

    const aa = resolveCanonicalModel("gateway/kimi-k2.7-code", "aa");
    expect(aa.supported).toBe(true);
    expect(aa.intelligence).toBe(41.9); // synthetic intelligence index

    // Canonical name known, but Ramp never ran it: unsupported under ramp, supported under aa.
    expect(resolveCanonicalModel("gateway/gemini-3.5-flash", "ramp").supported).toBe(false);
    expect(resolveCanonicalModel("gateway/gemini-3.5-flash", "aa").supported).toBe(true);
  });

  it("does not classify frontier models as cheap when costs are zero (aa)", () => {
    const pool = buildAutoPool(
      [
        model("gateway-codex", "gpt-5.5"),
        model("gateway-codex", "gpt-5.4"),
        model("gateway", "deepseek-v4-flash"),
        model("gateway", "kimi-k2.7-code-highspeed"),
      ],
      AA,
    );

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
      { ...AA, modelFilter: { include: ["gateway"], exclude: [] } },
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

  it("drops models the active source has no data for from the auto-pool", () => {
    // No canonical match at all.
    const unknown = buildAutoPool([model("local", "Qwen3.6-35B-A3B-UD-MLX-4bit")]);
    expect(unknown.all).toHaveLength(0);
    expect(unknown.cheapPool).toHaveLength(0);
    expect(unknown.strongPool).toHaveLength(0);
    expect(unknown.unknownPool).toHaveLength(0);

    // Canonical name known, but no Ramp result: out under ramp, in under aa.
    const noRamp = [model("gateway", "gemini-3.5-flash")];
    expect(buildAutoPool(noRamp).all).toHaveLength(0);
    expect(buildAutoPool(noRamp, AA).all).toHaveLength(1);
  });

  it("allows users to classify unsupported models with modelOverrides", () => {
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

  it("forced @strong climbs to the top of the capability frontier (aa)", () => {
    const pool = buildAutoPool(
      [
        model("gateway-codex", "gpt-5.5"),
        model("gateway", "glm-5.2"),
        model("gateway", "kimi-k2.7-code-highspeed"),
      ],
      AA,
    );

    // @strong = unlimited willingness → top of frontier on each axis.
    const deep = context("debug root cause and plan architecture");
    expect(selectFromPool(strongDecision(deep, AA), pool, deep, undefined, AA)?.selected.canonicalKey).toBe("gpt-5.5");
    const coder = context("general coding task");
    expect(selectFromPool(strongDecision(coder, AA), pool, coder, undefined, AA)?.selected.canonicalKey).toBe("gpt-5.5");
    // fast: highest throughput regardless of tier.
    const fast = context("need a fast coding response");
    expect(selectFromPool(strongDecision(fast, AA), pool, fast, undefined, AA)?.selected.canonicalKey).toBe("kimi-k2.7-code-highspeed");
  });

  it("climbs the frontier by hardness so the whole spread is reachable (aa)", () => {
    const pool = buildAutoPool(
      [
        model("gateway", "deepseek-v4-flash"),
        model("gateway", "deepseek-v4-pro"),
        model("gateway", "kimi-k2.7-code"),
        model("gateway", "glm-5.2"),
        model("gateway-codex", "gpt-5.4"),
        model("gateway-codex", "gpt-5.5"),
      ],
      AA,
    );
    const coder = context("implement a typescript helper");

    const pick = (opts: { reasoning: "medium" | "high" | "xhigh" } | undefined) =>
      selectFromPool(decide(coder, opts, undefined, AA), pool, coder, opts, AA)?.selected.canonicalKey;

    // off → cheap end; medium → mid value point (pro→kimi step too steep to climb past);
    // high → glm; xhigh → top of frontier.
    expect(pick(undefined)).toBe("deepseek-v4-flash");
    expect(pick({ reasoning: "medium" })).toBe("deepseek-v4-pro");
    expect(pick({ reasoning: "high" })).toBe("glm-5.2");
    expect(pick({ reasoning: "xhigh" })).toBe("gpt-5.5");
  });

  it("climbs the Ramp frontier by hardness on real resolve-rate (default source)", () => {
    const pool = buildAutoPool([
      model("gateway", "gpt-5.4-nano"),
      model("gateway", "qwen3.7-plus"),
      model("gateway", "qwen3.6-plus"),
      model("gateway-codex", "gpt-5.4"),
      model("gateway", "kimi-k2.7-code"),
      model("gateway-codex", "gpt-5.5"),
      model("anthropic", "claude-fable-5"),
    ]);
    const coder = context("implement a typescript helper");

    const pick = (opts: { reasoning: "medium" | "high" | "xhigh" } | undefined) =>
      selectFromPool(decide(coder, opts, undefined, DEFAULT_CONFIG), pool, coder, opts, DEFAULT_CONFIG)?.selected.canonicalKey;

    // Real Ramp frontier: nano → qwen3.7 → qwen3.6 → gpt-5.4 → kimi-k2.7-code → gpt-5.5 → fable.
    expect(pick(undefined)).toBe("qwen3.7-plus");
    expect(pick({ reasoning: "medium" })).toBe("kimi-k2.7-code");
    expect(pick({ reasoning: "high" })).toBe("gpt-5.5");
    expect(pick({ reasoning: "xhigh" })).toBe("claude-fable-5");
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
