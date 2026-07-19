import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Api, Context, Model, Usage } from "@earendil-works/pi-ai";
import {
  AA_WILLINGNESS,
  DEFAULT_CONFIG,
  buildAutoPool,
  cacheAwareSelect,
  classify,
  createClassifierState,
  createRoutingState,
  decide,
  inferRequestedProfile,
  isClassifierModelDisabled,
  mergeClassifierConfig,
  normalizeModelKey,
  parseClassificationOutput,
  recordClassifierFailure,
  recordClassifierSuccess,
  recordRoutingUsage,
  repriceForTimeOfDay,
  resolveRouteModel,
  loadUserRouterConfig,
  selectClassifierModel,
  timeCostMultiplier,
  resolveCanonicalModel,
  resolveModelVariants,
  routingTurnKey,
  selectFromPool,
  shouldReuseTurnSelection,
  userTurnIndex,
  variantKey,
  type ResolvedModel,
  type RouterConfig,
  type Selection,
  type TaskClassifier,
} from "./router-core.ts";
import { buildPlanKey, QuotaState } from "./quota.ts";

// The default source is `ramp`; this is the explicit `aa` counterpart for tests that exercise the
// Artificial Analysis table (the two sources are never merged).
const AA: RouterConfig = { ...DEFAULT_CONFIG, capabilitySource: "aa", willingness: AA_WILLINGNESS };

function strongDecision(ctx: Context, cfg: RouterConfig = DEFAULT_CONFIG) {
  return decide(ctx, undefined, { tier: "strong" }, cfg);
}

function cheapDecision(ctx: Context, cfg: RouterConfig = DEFAULT_CONFIG) {
  return decide(ctx, undefined, { tier: "cheap" }, cfg);
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
  it("exports the core contract through the package subpath", async () => {
    const core = await import("pi-model-auto/core");
    expect(typeof core.resolveRouteModel).toBe("function");
    expect(typeof core.loadUserRouterConfig).toBe("function");
    expect(core.resolveRouteModel({
      models: [model("gateway", "gpt-5.4-nano")],
      hint: "gateway/gpt-5.4-nano",
      cfg: DEFAULT_CONFIG,
    })).toEqual({ key: "gateway/gpt-5.4-nano" });
  });

  it("resolves cheap, strong, auto, and concrete core hints", () => {
    const models = [
      model("gateway", "gpt-5.4-nano"),
      model("gateway", "qwen3.7-plus"),
      model("gateway-codex", "gpt-5.5"),
    ];
    expect(resolveRouteModel({ models, hint: "cheap", context: context("small task"), cfg: DEFAULT_CONFIG })?.key)
      .toBe("gateway/qwen3.7-plus");
    expect(resolveRouteModel({ models, hint: "strong", context: context("small task"), cfg: DEFAULT_CONFIG })?.key)
      .toBe("gateway-codex/gpt-5.5");
    expect(resolveRouteModel({ models, hint: "auto", context: context("design a complex multi-file architecture"), cfg: DEFAULT_CONFIG })?.key)
      .not.toBe("pi-router/auto");
    expect(resolveRouteModel({ models, hint: "gateway/qwen3.7-plus", cfg: DEFAULT_CONFIG }))
      .toEqual({ key: "gateway/qwen3.7-plus" });
  });

  it("never returns the router pseudo-model and returns undefined for unavailable models", () => {
    const models = [model("pi-router", "auto"), model("gateway", "gpt-5.4-nano")];
    expect(resolveRouteModel({ models, hint: "pi-router/auto", cfg: DEFAULT_CONFIG })).toBeUndefined();
    expect(resolveRouteModel({ models, hint: "missing/model", cfg: DEFAULT_CONFIG })).toBeUndefined();
    expect(resolveRouteModel({ models: [model("pi-router", "auto")], hint: "auto", cfg: DEFAULT_CONFIG })).toBeUndefined();
  });

  it("loads only the user-level router configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-model-auto-config-"));
    try {
      writeFileSync(join(root, "model-router.json"), JSON.stringify({
        router: {
          capabilitySource: "aa",
          modelFilter: { include: ["gateway"] },
          modelOverrides: { custom: { costCoef: 0.2 } },
          classifier: "off",
          classifierModel: "gateway/gpt-5.6-luna",
        },
      }));
      const cfg = loadUserRouterConfig(root);
      expect(cfg.capabilitySource).toBe("aa");
      expect(cfg.modelFilter.include).toEqual(["gateway"]);
      expect(cfg.modelOverrides.custom?.costCoef).toBe(0.2);
      expect(cfg.willingness).toEqual(AA_WILLINGNESS);
      expect(cfg.classifier.enabled).toBe(false);
      expect(cfg.classifierModel).toBe("gateway/gpt-5.6-luna");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges partial classifier config without disabling it", () => {
    expect(mergeClassifierConfig({ timeoutMs: 10_000 })).toMatchObject({
      enabled: true,
      timeoutMs: 10_000,
      failureThreshold: DEFAULT_CONFIG.classifier.failureThreshold,
    });
    expect(mergeClassifierConfig({ timeoutMs: 10_000 }, { ...DEFAULT_CONFIG.classifier, enabled: false })).toMatchObject({
      enabled: false,
      timeoutMs: 10_000,
    });
  });

  it("filters cooled-down quota plans by default and allows opting out", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-model-auto-quota-"));
    try {
      const models = [model("cheap-provider", "qwen3.7-plus"), model("fallback-provider", "gpt-5.4")];
      const quota = new QuotaState(DEFAULT_CONFIG.quota);
      const now = Date.now();
      quota.recordRateLimited(
        buildPlanKey({ provider: "cheap-provider", baseUrl: "https://example.invalid", apiKey: "test-token" }),
        60_000,
        undefined,
        now,
      );
      quota.persist(join(root, "quota-state.json"));

      expect(resolveRouteModel({ models, hint: "cheap", context: context("small task"), cfg: DEFAULT_CONFIG, agentDir: root })?.key)
        .toBe("fallback-provider/gpt-5.4");
      expect(resolveRouteModel({ models, hint: "cheap", context: context("small task"), cfg: DEFAULT_CONFIG, agentDir: root, filterQuota: false })?.key)
        .toBe("cheap-provider/qwen3.7-plus");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    expect(normalizeModelKey("anthropic/claude-fable-5(xhigh)")).toBe("claude-fable-5");
    expect(normalizeModelKey("openai/gpt-5.6-sol(max)")).toBe("gpt-5.6-sol");
    expect(normalizeModelKey("gateway/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("uses longest substring matching", () => {
    expect(resolveCanonicalModel("gateway/kimi-k2.7-code-highspeed").canonical?.key).toBe("kimi-k2.7-code-highspeed");
    expect(resolveCanonicalModel("gateway/kimi-k2.7-code").canonical?.key).toBe("kimi-k2.7-code");
    expect(resolveCanonicalModel("gateway/kimi-k3").canonical?.key).toBe("kimi-k3");
    expect(resolveCanonicalModel("gateway/deepseek-flash").canonical?.key).toBe("deepseek-v4-flash");
    expect(resolveCanonicalModel("fireworks_ai/qwen3p7-plus-high").canonical?.key).toBe("qwen3.7-plus");
  });

  it("draws capability numbers from the active source, never merged", () => {
    const ramp = resolveCanonicalModel("gateway/kimi-k2.7-code", "ramp");
    expect(ramp.supported).toBe(true);
    expect(ramp.intelligence).toBe(79.7); // resolve-rate
    expect(ramp.priceBlended).toBe(0.88); // measured cost per task

    const aa = resolveCanonicalModel("gateway/kimi-k2.7-code", "aa");
    expect(aa.supported).toBe(true);
    expect(aa.intelligence).toBe(41.9); // synthetic intelligence index

    // Canonical name known, but Ramp never ran it: unsupported under ramp, supported under aa.
    expect(resolveCanonicalModel("gateway/gemini-3.5-flash", "ramp").supported).toBe(false);
    expect(resolveCanonicalModel("gateway/gemini-3.5-flash", "aa").supported).toBe(true);

    // GPT-5.6 is present in both tables; the active source still decides which numbers route.
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "ramp").supported).toBe(true);
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "ramp").intelligence).toBe(82.3);
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "ramp").benchmarkEffort).toBe("xhigh");
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "aa").supported).toBe(true);
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "aa").intelligence).toBe(58.9);
    expect(resolveCanonicalModel("gateway/kimi-k3", "aa").supported).toBe(true);
  });

  it("represents benchmark results as model-effort routing variants", () => {
    const variants = resolveModelVariants(model("anthropic", "claude-fable-5"), DEFAULT_CONFIG);
    expect(variants.map(variantKey)).toEqual(["anthropic/claude-fable-5@xhigh"]);
    expect(variants[0].matchReason).toContain("claude-fable-5@xhigh");
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

    // @strong = unlimited willingness → top of the language-neutral fallback frontier.
    const request = context("general task");
    expect(selectFromPool(strongDecision(request, AA), pool, request, undefined, AA)?.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("keeps deterministic fallback classification language-neutral", () => {
    const englishKeywords = "debug root cause architecture";
    const neutralSameLength = "plain neutral request".padEnd(englishKeywords.length, "x");

    expect(classify(context(englishKeywords), DEFAULT_CONFIG)).toBe(classify(context(neutralSameLength), DEFAULT_CONFIG));
    expect(inferRequestedProfile(context(englishKeywords))).toBe("balanced");
  });

  it("lets tests inject a classifier result for hardness and profile", () => {
    const pool = buildAutoPool(
      [
        model("gateway-codex", "gpt-5.5"),
        model("gateway", "glm-5.2"),
        model("gateway", "kimi-k2.7-code-highspeed"),
      ],
      AA,
    );
    const fakeClassifier: TaskClassifier = {
      classify: () => ({ hardness: "max", profile: "fast", reason: "fake classifier" }),
    };
    const request = context("同样的请求文本");
    const decision = decide(request, undefined, undefined, AA, fakeClassifier);

    expect(decision.hardnessBucket).toBe(3);
    expect(decision.score).toBe(0.86);
    expect(decision.requestedProfile).toBe("fast");
    expect(selectFromPool(decision, pool, request, undefined, AA)?.selected.canonicalKey).toBe("kimi-k2.7-code-highspeed");
  });

  it("does not let stale classifier profiles affect forced tiers", () => {
    const pool = buildAutoPool(
      [
        model("gateway-codex", "gpt-5.5"),
        model("gateway", "glm-5.2"),
        model("gateway", "kimi-k2.7-code-highspeed"),
      ],
      AA,
    );
    const staleClassifier: TaskClassifier = {
      classify: () => ({ hardness: "max", profile: "fast", reason: "stale classifier" }),
    };
    const request = context("@strong should ignore stale fast profile");
    const decision = decide(request, undefined, { tier: "strong" }, AA, staleClassifier);

    expect(decision.requestedProfile).toBe("balanced");
    expect(selectFromPool(decision, pool, request, undefined, AA)?.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("parses noisy classifier output and falls back when hardness is missing", () => {
    expect(parseClassificationOutput("Sure.\nprofile: coder\nhardness = hard\nscore: 0.72")).toMatchObject({
      hardness: "hard",
      profile: "coder",
      score: 0.72,
    });
    expect(parseClassificationOutput("profile: coder only")).toBeUndefined();
  });

  it("selects the cheapest available classifier model and honors cooldown", () => {
    const pool = buildAutoPool([
      model("gateway", "gpt-5.6-luna"),
      model("gateway", "gpt-5.6-sol"),
      model("gateway", "kimi-k3"),
    ], AA);
    const state = createClassifierState();

    expect(selectClassifierModel(pool, AA, state, 1)?.canonicalKey).toBe("gpt-5.6-luna");

    const explicit: RouterConfig = { ...AA, classifierModel: "gateway/kimi-k3" };
    expect(selectClassifierModel(pool, explicit, state, 1)?.canonicalKey).toBe("kimi-k3");

    recordClassifierFailure(state, "gateway/gpt-5.6-luna", 1, { ...AA, classifier: { ...AA.classifier, failureThreshold: 1 } });
    expect(isClassifierModelDisabled(state, "gateway/gpt-5.6-luna", 2)).toBe(true);
    expect(selectClassifierModel(pool, AA, state, 2)?.canonicalKey).toBe("kimi-k3");

    recordClassifierSuccess(state, "gateway/gpt-5.6-luna");
    expect(isClassifierModelDisabled(state, "gateway/gpt-5.6-luna", 3)).toBe(false);
  });

  // Hardness drives the climb directly (content-derived in production); reasoning level never does.
  const pickAtBucket = (
    pool: ReturnType<typeof buildAutoPool>,
    ctx: Context,
    cfg: RouterConfig,
    bucket: number,
  ) =>
    selectFromPool(
      { cls: bucket >= 2 ? "strong" : "cheap", score: 0, chosen: "", hardnessBucket: bucket },
      pool,
      ctx,
      undefined,
      cfg,
    )?.selected.canonicalKey;

  it("climbs the language-neutral frontier by hardness (aa)", () => {
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
    const pick = (bucket: number) => pickAtBucket(pool, coder, AA, bucket);

    // On the balanced fallback axis, flash is dominated and normal climbs to the mid frontier point.
    expect(pick(0)).toBe("deepseek-v4-pro");
    expect(pick(1)).toBe("glm-5.2");
    expect(pick(2)).toBe("glm-5.2");
    expect(pick(3)).toBe("gpt-5.5");
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
    const pick = (bucket: number) => pickAtBucket(pool, coder, DEFAULT_CONFIG, bucket);

    // Real Ramp frontier: nano → qwen3.7 → qwen3.6 → gpt-5.4 → kimi-k2.7-code → gpt-5.5 → fable.
    expect(pick(0)).toBe("qwen3.7-plus");
    expect(pick(1)).toBe("kimi-k2.7-code");
    expect(pick(2)).toBe("kimi-k2.7-code");
    expect(pick(3)).toBe("claude-fable-5");
  });

  it("carries benchmark effort through the selected routing variant", () => {
    const pool = buildAutoPool([
      model("gateway", "qwen3.7-plus"),
      model("gateway-codex", "gpt-5.4"),
      model("gateway", "glm-5.2"),
      model("anthropic", "claude-fable-5"),
    ]);
    const coder = context("implement a typescript helper");
    const selection = selectFromPool(strongDecision(coder), pool, coder, { reasoning: "high" }, DEFAULT_CONFIG);

    expect(selection?.selected.canonicalKey).toBe("claude-fable-5");
    expect(selection?.benchmarkEffort).toBe("xhigh");
    expect(selection?.alternatives).toContain("gateway/glm-5.2@high");
  });

  it("scales the cost axis by the shadow-price coefficient", () => {
    expect(item(buildAutoPool([model("gateway", "glm-5.2")]), "glm-5.2").priceBlended).toBe(1.89);

    const discounted = buildAutoPool([model("gateway", "glm-5.2")], {
      ...DEFAULT_CONFIG,
      modelOverrides: { "gateway/glm-5.2": { costCoef: 0.25 } },
    });
    expect(item(discounted, "glm-5.2").priceBlended).toBeCloseTo(0.47);
  });

  it("lets a paid subscription win cheap turns it would lose at measured cost", () => {
    // gpt-5.4 (73.4@$0.66) vs glm-5.2 (81@$1.89): at list cost an easy coder turn takes the cheap gpt-5.4.
    const models = [model("gateway-codex", "gpt-5.4"), model("gateway", "glm-5.2")];
    const coder = context("implement a typescript helper");
    const pick = (cfg: RouterConfig) =>
      selectFromPool(decide(coder, undefined, undefined, cfg), buildAutoPool(models, cfg), coder, undefined, cfg)?.selected.canonicalKey;

    expect(pick(DEFAULT_CONFIG)).toBe("gpt-5.4");

    // Price GLM as an already-paid subscription (coef 0.2 → $0.376): now it dominates and wins.
    const withSub: RouterConfig = { ...DEFAULT_CONFIG, modelOverrides: { "gateway/glm-5.2": { costCoef: 0.2 } } };
    expect(pick(withSub)).toBe("glm-5.2");
  });

  it("keeps the build-time price time-neutral and re-applies windows per turn", () => {
    const cfg: RouterConfig = {
      ...DEFAULT_CONFIG,
      modelOverrides: { "gateway/glm-5.2": { costCoef: 0.2, costCoefHours: [{ hours: [14, 18], factor: 3 }] } },
    };
    // Build is time-neutral: base coef only, no clock baked in.
    const pool = buildAutoPool([model("gateway", "glm-5.2")], cfg);
    expect(item(pool, "glm-5.2").priceBlended).toBeCloseTo(1.89 * 0.2);

    // Per-turn reprice applies the window without rebuilding: 10:00 off-peak, 15:00 inside the 3× window.
    expect(item(repriceForTimeOfDay(pool, 10), "glm-5.2").priceBlended).toBeCloseTo(1.89 * 0.2);
    expect(item(repriceForTimeOfDay(pool, 15), "glm-5.2").priceBlended).toBeCloseTo(1.89 * 0.6);
  });

  it("applies time-of-day repricing to forced @cheap tier selection", () => {
    const cfg: RouterConfig = {
      ...DEFAULT_CONFIG,
      modelOverrides: { "gateway/glm-5.2": { costCoef: 0.2, costCoefHours: [{ hours: [14, 18], factor: 3 }] } },
    };
    const pool = buildAutoPool([model("gateway-codex", "gpt-5.4"), model("gateway", "glm-5.2")], cfg);
    const coder = context("implement a typescript helper");

    expect(selectFromPool(cheapDecision(coder, cfg), pool, coder, undefined, cfg)?.selected.canonicalKey).toBe("glm-5.2");
    expect(selectFromPool(cheapDecision(coder, cfg), repriceForTimeOfDay(pool, 15), coder, undefined, cfg)?.selected.canonicalKey).toBe("gpt-5.4");
  });

  it("computes the time multiplier, including wraparound windows", () => {
    const windows = [{ hours: [22, 2] as [number, number], factor: 2 }];
    expect(timeCostMultiplier(windows, 23)).toBe(2);
    expect(timeCostMultiplier(windows, 1)).toBe(2);
    expect(timeCostMultiplier(windows, 12)).toBe(1);
    expect(timeCostMultiplier(undefined, 23)).toBe(1);
  });

  it("keeps one routing key for tool continuations within the same user turn", () => {
    const firstRequest = context("create mr");
    const continuation = toolContinuationContext("create mr");
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

function modelCost(provider: string, id: string, cost: Partial<Model<Api>["cost"]>): Model<Api> {
  return { ...model(provider, id), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost } };
}

function usage(over: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...over,
  };
}

function item(pool: ReturnType<typeof buildAutoPool>, canonicalKey: string): ResolvedModel {
  const found = pool.all.find((entry) => entry.canonicalKey === canonicalKey);
  if (!found) throw new Error(`missing ${canonicalKey}`);
  return found;
}

function freshSelection(selected: ResolvedModel): Selection {
  return { selected, profile: "coder", reason: "fresh pick", alternatives: [] };
}

describe("cache-aware stickiness", () => {
  const ctx = context("hello");

  it("records realized usage as a warm lease", () => {
    const state = createRoutingState();
    recordRoutingUsage(state, item(buildAutoPool([model("gateway", "gpt-5.5")]), "gpt-5.5"), usage({ input: 200, cacheRead: 800, totalTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.5 } }), ctx);
    expect(state.lease?.modelKey).toBe("gateway/gpt-5.5");
    expect(state.observedCacheReadRatio).toBeCloseTo(0.8);
    expect(state.realizedCostByModel["gateway/gpt-5.5"].usd).toBeCloseTo(1.5);
  });

  it("takes the fresh pick when there is no lease", () => {
    const pool = buildAutoPool([model("gateway", "gpt-5.5"), model("gateway", "qwen3.7-plus")]);
    const result = cacheAwareSelect(freshSelection(item(pool, "qwen3.7-plus")), createRoutingState(), pool, ctx, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("no-lease");
    expect(result.selection.selected.canonicalKey).toBe("qwen3.7-plus");
  });

  it("switches down when warm-read savings beat the switch tax", () => {
    const pool = buildAutoPool([model("gateway", "gpt-5.5"), modelCost("gateway", "qwen3.7-plus", { cacheWrite: 5e-7, cacheRead: 2e-7 })]);
    const state = createRoutingState();
    state.lease = { modelKey: "gateway/gpt-5.5", provider: "gateway", cost: { input: 0, cacheRead: 2e-6, cacheWrite: 0 }, warmTokens: 100_000, establishedAtTurn: 0, lastUsedTurn: 0 };
    state.lastUsage = usage({ totalTokens: 100_000 });

    const result = cacheAwareSelect(freshSelection(item(pool, "qwen3.7-plus")), state, pool, ctx, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("downgrade-break-even");
    expect(result.selection.selected.canonicalKey).toBe("qwen3.7-plus");
  });

  it("stays on the warm lease when a downgrade does not break even", () => {
    const pool = buildAutoPool([model("gateway", "gpt-5.5"), modelCost("gateway", "qwen3.7-plus", { cacheWrite: 3e-6, cacheRead: 2e-6 })]);
    const state = createRoutingState();
    state.lease = { modelKey: "gateway/gpt-5.5", provider: "gateway", cost: { input: 0, cacheRead: 2e-6, cacheWrite: 0 }, warmTokens: 100_000, establishedAtTurn: 0, lastUsedTurn: 0 };
    state.lastUsage = usage({ totalTokens: 100_000 });

    const result = cacheAwareSelect(freshSelection(item(pool, "qwen3.7-plus")), state, pool, ctx, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("downgrade-not-worth-it");
    expect(result.selection.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("switches up when the capability gain is large", () => {
    const pool = buildAutoPool([model("gateway", "qwen3.7-plus"), model("gateway", "gpt-5.5")]);
    const state = createRoutingState();
    state.lease = { modelKey: "gateway/qwen3.7-plus", provider: "gateway", cost: { input: 0, cacheRead: 1e-7, cacheWrite: 0 }, warmTokens: 100_000, establishedAtTurn: 0, lastUsedTurn: 0 };
    state.lastUsage = usage({ totalTokens: 100_000 });

    const result = cacheAwareSelect(freshSelection(item(pool, "gpt-5.5")), state, pool, ctx, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("upgrade-quality"); // +21.5 resolve points
    expect(result.selection.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("stays put when an upgrade is too small to justify the tax", () => {
    const pool = buildAutoPool([model("gateway", "claude-opus-4-8"), model("gateway", "kimi-k2.7-code")]);
    const state = createRoutingState();
    state.lease = { modelKey: "gateway/claude-opus-4-8", provider: "gateway", cost: { input: 0, cacheRead: 1e-7, cacheWrite: 0 }, warmTokens: 100_000, establishedAtTurn: 0, lastUsedTurn: 0 };
    state.lastUsage = usage({ totalTokens: 100_000 });

    const result = cacheAwareSelect(freshSelection(item(pool, "kimi-k2.7-code")), state, pool, ctx, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("upgrade-not-worth-it"); // only +1.2 points
    expect(result.selection.selected.canonicalKey).toBe("claude-opus-4-8");
  });

  it("counts user turns for the switch cooldown", () => {
    expect(userTurnIndex(context("one"))).toBe(1);
  });
});
