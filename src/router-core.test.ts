import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Api, Context, Model, Usage } from "@earendil-works/pi-ai";
import {
  DEFAULT_CONFIG,
  axisValue,
  aaCapabilityMode,
  buildAutoPool,
  cacheAwareSelect,
  classify,
  createClassifierState,
  createRoutingState,
  decide,
  inferRequestedProfile,
  isClassifierModelDisabled,
  mergeClassifierConfig,
  modelKey,
  normalizeModelKey,
  parseClassificationOutput,
  recordClassifierFailure,
  recordClassifierSuccess,
  recordRoutingUsage,
  rampCapabilityMode,
  routingReasoning,
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
const AA: RouterConfig = { ...DEFAULT_CONFIG, capabilitySource: "aa" };
const COST_RAMP: RouterConfig = { ...DEFAULT_CONFIG, selectionPolicy: "cost" };
const COST_AA: RouterConfig = { ...AA, selectionPolicy: "cost" };

function ultraDecision(ctx: Context, cfg: RouterConfig = DEFAULT_CONFIG) {
  return decide(ctx, undefined, { mode: "ultra" }, cfg);
}

function lowDecision(ctx: Context, cfg: RouterConfig = DEFAULT_CONFIG) {
  return decide(ctx, undefined, { mode: "low" }, cfg);
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

  it("resolves Low/Medium/High/Ultra, auto, and concrete core hints", () => {
    const models = [
      model("gateway", "gpt-5.4-nano"),
      model("gateway", "qwen3.7-plus"),
      model("gateway", "deepseek-v4-flash"),
      model("gateway", "kimi-k2.7-code"),
      model("gateway", "glm-5.2"),
      model("gateway-codex", "gpt-5.5"),
      model("anthropic", "claude-fable-5"),
    ];
    expect(resolveRouteModel({ models, hint: "low", context: context("small task"), cfg: DEFAULT_CONFIG })?.key)
      .toBe("gateway/qwen3.7-plus");
    expect(resolveRouteModel({ models, hint: "medium", context: context("small task"), cfg: DEFAULT_CONFIG })?.key)
      .toBe("gateway/deepseek-v4-flash");
    expect(resolveRouteModel({ models, hint: "high", context: context("small task"), cfg: DEFAULT_CONFIG })?.key)
      .toBe("gateway-codex/gpt-5.5");
    expect(resolveRouteModel({ models, hint: "ultra", context: context("small task"), cfg: DEFAULT_CONFIG })?.key)
      .toBe("anthropic/claude-fable-5");
    expect(resolveRouteModel({ models, hint: "cheap", context: context("small task"), cfg: DEFAULT_CONFIG })).toBeUndefined();
    expect(resolveRouteModel({ models, hint: "strong", context: context("small task"), cfg: DEFAULT_CONFIG })).toBeUndefined();
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
          selectionPolicy: "cost",
          modelFilter: { include: ["gateway"] },
          modeModels: { ultra: "gateway/gpt-5.6-luna" },
          modelOverrides: { custom: { costCoef: 0.2 } },
          classifier: "off",
          classifierModel: "gateway/gpt-5.6-luna",
        },
      }));
      const cfg = loadUserRouterConfig(root);
      expect(cfg.capabilitySource).toBe("aa");
      expect(cfg.modelFilter.include).toEqual(["gateway"]);
      expect(cfg.modeModels.ultra).toBe("gateway/gpt-5.6-luna");
      expect(cfg.modelOverrides.custom?.costCoef).toBe(0.2);
      expect(cfg.selectionPolicy).toBe("cost");
      expect(cfg.classifier.enabled).toBe(false);
      expect(cfg.classifierModel).toBe("gateway/gpt-5.6-luna");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enables classifier when classifierModel is configured", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-model-auto-classifier-"));
    try {
      writeFileSync(join(root, "model-router.json"), JSON.stringify({
        router: { classifierModel: "gateway/gpt-5.4-nano" },
      }));
      const cfg = loadUserRouterConfig(root);
      expect(cfg.classifier.enabled).toBe(true);
      expect(cfg.classifierModel).toBe("gateway/gpt-5.4-nano");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps classifier disabled by default while merging tuning options", () => {
    expect(mergeClassifierConfig({ timeoutMs: 10_000 })).toMatchObject({
      enabled: false,
      timeoutMs: 10_000,
      failureThreshold: DEFAULT_CONFIG.classifier.failureThreshold,
    });
    expect(mergeClassifierConfig({ enabled: true, timeoutMs: 10_000 })).toMatchObject({
      enabled: true,
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

      expect(resolveRouteModel({ models, hint: "low", context: context("small task"), cfg: COST_RAMP, agentDir: root })?.key)
        .toBe("fallback-provider/gpt-5.4");
      expect(resolveRouteModel({ models, hint: "low", context: context("small task"), cfg: COST_RAMP, agentDir: root, filterQuota: false })?.key)
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

  it("maps Ramp solve-rate boundaries to capability modes", () => {
    expect(rampCapabilityMode(85)).toBe("ultra");
    expect(rampCapabilityMode(84.9)).toBe("high");
    expect(rampCapabilityMode(80)).toBe("high");
    expect(rampCapabilityMode(79.9)).toBe("medium");
    expect(rampCapabilityMode(75)).toBe("medium");
    expect(rampCapabilityMode(74.9)).toBe("low");
  });

  it("maps AA v4.2 Intelligence Index boundaries to capability modes", () => {
    expect(aaCapabilityMode(52)).toBe("ultra");
    expect(aaCapabilityMode(51.9)).toBe("high");
    expect(aaCapabilityMode(47)).toBe("high");
    expect(aaCapabilityMode(46.9)).toBe("medium");
    expect(aaCapabilityMode(40)).toBe("medium");
    expect(aaCapabilityMode(39.9)).toBe("low");
  });

  it("assigns Ramp capability modes independently from continuous price", () => {
    expect(resolveCanonicalModel("gateway/claude-fable-5", "ramp")).toMatchObject({ capabilityMode: "ultra", priceBlended: 2.62 });
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "ramp")).toMatchObject({ capabilityMode: "high", priceBlended: 0.99 });
    expect(resolveCanonicalModel("gateway/gpt-5.6-terra", "ramp")).toMatchObject({ capabilityMode: "medium", priceBlended: 0.26 });
    expect(resolveCanonicalModel("gateway/gpt-5.4", "ramp")).toMatchObject({ capabilityMode: "low", priceBlended: 0.64 });
  });

  it("uses benchmark effort for auto routes and UI effort for forced models", () => {
    expect(routingReasoning("high", "medium", false)).toBe("high");
    expect(routingReasoning("xhigh", "high", false)).toBe("xhigh");
    expect(routingReasoning(undefined, "medium", false)).toBe("medium");
    expect(routingReasoning("high", "medium", true)).toBe("medium");
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
    expect(ramp.intelligence).toBe(80.8); // resolve-rate
    expect(ramp.priceBlended).toBe(0.88); // measured cost per task

    const aa = resolveCanonicalModel("gateway/kimi-k2.7-code", "aa");
    expect(aa.supported).toBe(true);
    expect(aa.intelligence).toBe(33.9); // Artificial Analysis Intelligence Index v4.2

    // Canonical name known, but Ramp never ran it: unsupported under ramp, supported under aa.
    expect(resolveCanonicalModel("gateway/gemini-3.5-flash", "ramp").supported).toBe(false);
    expect(resolveCanonicalModel("gateway/gemini-3.5-flash", "aa").supported).toBe(true);

    // GPT-5.6 is present in both tables; the active source still decides which numbers route.
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "ramp").supported).toBe(true);
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "ramp").intelligence).toBe(83.3);
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "ramp").benchmarkEffort).toBe("high");
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "aa").supported).toBe(true);
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "aa").intelligence).toBe(51.3);
    expect(resolveCanonicalModel("gateway/kimi-k3", "ramp")).toMatchObject({
      supported: true,
      intelligence: 87.2,
      priceBlended: 1.6,
      benchmarkEffort: "high",
      capabilityMode: "ultra",
    });
    expect(resolveCanonicalModel("gateway/kimi-k3", "aa")).toMatchObject({ supported: true, capabilityMode: "high" });
    expect(resolveCanonicalModel("gateway/gpt-5.6-luna", "aa")).toMatchObject({ capabilityMode: "medium", priceBlended: 0.45 });
    expect(resolveCanonicalModel("gateway/claude-fable-5.1", "aa")).toMatchObject({ capabilityMode: "ultra", intelligence: 56.8 });
    expect(resolveCanonicalModel("gateway/deepseek-v4-flash", "ramp")).toMatchObject({
      supported: true,
      intelligence: 79.5,
      priceBlended: 0.12,
      benchmarkEffort: "high",
      capabilityMode: "medium",
    });
  });

  it("uses the general AA index when a profile sub-index is missing", () => {
    const [item] = buildAutoPool([model("gateway", "qwen3.7-plus")], AA).all;
    expect(item.scores?.agentic).toBeUndefined();
    expect(axisValue(item, "deep")).toBe(item.intelligence);
  });

  it("supports quality-first and cost-first selection inside an AA mode", () => {
    const models = [model("gateway", "gemini-3.8-flash"), model("gateway", "glm-5.3"), model("gateway", "gpt-5.6-sol")];
    const coder = context("implement a typescript helper");
    const decision = { cls: "high" as const, score: 0.6, chosen: "", modeBucket: 2, requestedProfile: "coder" as const };
    expect(selectFromPool(decision, buildAutoPool(models, AA), coder, undefined, AA)?.selected.canonicalKey).toBe("gpt-5.6-sol");
    expect(selectFromPool(decision, buildAutoPool(models, COST_AA), coder, undefined, COST_AA)?.selected.canonicalKey).toBe("gemini-3.8-flash");
  });

  it("honors an exact mode pin before quality or cost policy", () => {
    const models = [model("gateway", "gemini-3.8-flash"), model("gateway", "glm-5.3"), model("gateway", "gpt-5.6-sol")];
    const cfg = { ...AA, modeModels: { high: "gateway/glm-5.3" } };
    const decision = { cls: "high" as const, score: 0.6, chosen: "", modeBucket: 2, requestedProfile: "coder" as const };
    expect(selectFromPool(decision, buildAutoPool(models, cfg), context("code"), undefined, cfg)?.selected.canonicalKey).toBe("glm-5.3");
    expect(resolveRouteModel({ models, hint: "high", cfg })?.key).toBe("gateway/glm-5.3");
  });

  it("includes an explicitly pinned private model without benchmark metadata", () => {
    const privateModel = model("private", "house-model");
    const cfg = { ...DEFAULT_CONFIG, modeModels: { ultra: "private/house-model" } };
    expect(resolveRouteModel({ models: [privateModel, model("gateway", "claude-opus-5")], hint: "ultra", cfg })?.key)
      .toBe("private/house-model");
  });

  it("treats a cross-mode pin as the requested mode without changing its intrinsic pool mode", () => {
    const models = [model("gateway", "gpt-5.6-luna"), model("gateway", "glm-5.3")];
    const cfg = { ...AA, modeModels: { ultra: "gateway/gpt-5.6-luna" } };
    const pool = buildAutoPool(models, cfg);
    expect(item(pool, "gpt-5.6-luna").capabilityMode).toBe("medium");
    expect(selectFromPool(ultraDecision(context("hard"), cfg), pool, context("hard"), undefined, cfg)?.selected)
      .toMatchObject({ canonicalKey: "gpt-5.6-luna", capabilityMode: "ultra" });
  });

  it("never admits the virtual router or a non-text endpoint through a mode pin", () => {
    const router = model("pi-router", "auto");
    const imageOnly = model("private", "image-only");
    imageOnly.input = ["image"];
    const cfg = { ...DEFAULT_CONFIG, modeModels: { low: "pi-router/auto", ultra: "private/image-only" } };
    const pool = buildAutoPool([router, imageOnly, model("gateway", "gpt-5.4-nano")], cfg);
    expect(pool.all.map((entry) => modelKey(entry.model))).not.toContain("pi-router/auto");
    expect(pool.all.map((entry) => modelKey(entry.model))).not.toContain("private/image-only");
  });

  it("keeps full Ramp benchmark coverage available to mode routing", () => {
    expect(resolveCanonicalModel("gateway/gpt-5.4", "ramp")).toMatchObject({
      supported: true,
      intelligence: 74.4,
      capabilityMode: "low",
    });
    expect(resolveCanonicalModel("gateway/gemini-3.1-pro", "ramp")).toMatchObject({
      supported: true,
      intelligence: 74.4,
      capabilityMode: "low",
    });
    expect(resolveCanonicalModel("gateway/kimi-k2.7-code", "ramp")).toMatchObject({
      supported: true,
      capabilityMode: "high",
    });
    expect(resolveCanonicalModel("gateway/gpt-5.6-sol", "ramp").supported).toBe(true);
  });

  it("represents benchmark results as model-effort routing variants", () => {
    const variants = resolveModelVariants(model("anthropic", "claude-fable-5"), DEFAULT_CONFIG);
    expect(variants.map(variantKey)).toEqual(["anthropic/claude-fable-5@xhigh"]);
    expect(variants[0].matchReason).toContain("claude-fable-5@xhigh");
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
      "gateway-codex/gpt-5.5",
      "gateway/deepseek-v4-flash",
    ]);
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
          capabilityMode: "low",
          profiles: ["fast", "coder"],
        },
      },
    });

    expect(pool.all[0].canonicalKey).toBe("qwen3.6-35b-a3b-ud-mlx-4bit");
    expect(pool.all[0].profiles).toEqual(["fast", "coder"]);
    expect(pool.all[0].matchReason).toBe("user override for unknown model");
  });

  it("ignores removed legacy-only override fields", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      modelOverrides: {
        "local/private-model": { costTier: "cheap", frontier: true },
      },
    } as unknown as RouterConfig;
    expect(buildAutoPool([model("local", "private-model")], cfg).all).toHaveLength(0);
  });

  it("builds manual effort variants from normalized model-id overrides", () => {
    const cfg: RouterConfig = {
      ...DEFAULT_CONFIG,
      modelOverrides: {
        "gpt-5.5-off": {
          capabilityMode: "low",
          intelligence: 40,
          priceBlended: 0.4,
          costTier: "standard",
          frontier: true,
          benchmarkEffort: "off",
          profiles: ["balanced", "coder", "deep"],
          scores: { coding: 40, agentic: 0.4 },
        },
        "gpt-5.5-low": {
          capabilityMode: "medium",
          intelligence: 70,
          priceBlended: 0.85,
          costTier: "standard",
          frontier: true,
          benchmarkEffort: "low",
          profiles: ["balanced", "coder", "deep"],
          scores: { coding: 70, agentic: 0.7 },
        },
        "gpt-5.5-high": {
          capabilityMode: "high",
          intelligence: 85,
          priceBlended: 1.5,
          costTier: "premium",
          frontier: true,
          benchmarkEffort: "high",
          profiles: ["balanced", "coder", "deep"],
          scores: { coding: 85, agentic: 0.85 },
        },
        "gpt-5.5-xhigh": {
          capabilityMode: "ultra",
          intelligence: 90,
          priceBlended: 2.5,
          costTier: "premium",
          frontier: true,
          benchmarkEffort: "xhigh",
          profiles: ["balanced", "coder", "deep"],
          scores: { coding: 90, agentic: 0.9 },
        },
      },
    };

    const variants = resolveModelVariants(model("gateway", "gpt-5.5"), cfg);

    expect(variants.map(variantKey)).toEqual([
      "gateway/gpt-5.5@off",
      "gateway/gpt-5.5@low",
      "gateway/gpt-5.5@high",
      "gateway/gpt-5.5@xhigh",
    ]);
    expect(variants.map((variant) => variant.capabilityMode)).toEqual(["low", "medium", "high", "ultra"]);
    expect(variants.map((variant) => variant.intelligence)).toEqual([40, 70, 85, 90]);
  });

  it("forced @ultra targets the Ultra capability mode (aa)", () => {
    const pool = buildAutoPool(
      [
        model("gateway-codex", "gpt-5.5"),
        model("gateway", "glm-5.2"),
        model("gateway", "kimi-k2.7-code-highspeed"),
      ],
      AA,
    );

    const request = context("general task");
    expect(selectFromPool(ultraDecision(request, AA), pool, request, undefined, AA)?.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("keeps deterministic fallback classification language-neutral", () => {
    const englishKeywords = "debug root cause architecture";
    const neutralSameLength = "plain neutral request".padEnd(englishKeywords.length, "x");

    expect(classify(context(englishKeywords), DEFAULT_CONFIG)).toBe(classify(context(neutralSameLength), DEFAULT_CONFIG));
    expect(inferRequestedProfile(context(englishKeywords))).toBe("balanced");
  });

  it("lets tests inject a classifier result for mode and profile", () => {
    const pool = buildAutoPool(
      [
        model("gateway-codex", "gpt-5.5"),
        model("gateway", "glm-5.2"),
        model("gateway", "kimi-k2.7-code-highspeed"),
      ],
      AA,
    );
    const fakeClassifier: TaskClassifier = {
      classify: () => ({ mode: "ultra", profile: "fast", reason: "fake classifier" }),
    };
    const request = context("同样的请求文本");
    const decision = decide(request, undefined, undefined, AA, fakeClassifier);

    expect(decision.modeBucket).toBe(3);
    expect(decision.score).toBe(0.86);
    expect(decision.requestedProfile).toBe("fast");
    expect(selectFromPool(decision, pool, request, undefined, AA)?.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("does not let stale classifier profiles affect forced modes", () => {
    const pool = buildAutoPool(
      [
        model("gateway-codex", "gpt-5.5"),
        model("gateway", "glm-5.2"),
        model("gateway", "kimi-k2.7-code-highspeed"),
      ],
      AA,
    );
    const staleClassifier: TaskClassifier = {
      classify: () => ({ mode: "ultra", profile: "fast", reason: "stale classifier" }),
    };
    const request = context("@ultra should ignore stale fast profile");
    const decision = decide(request, undefined, { mode: "ultra" }, AA, staleClassifier);

    expect(decision.requestedProfile).toBe("balanced");
    expect(selectFromPool(decision, pool, request, undefined, AA)?.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("parses noisy classifier output and falls back when mode is missing", () => {
    expect(parseClassificationOutput("Sure.\nprofile: coder\nmode = high\nscore: 0.72")).toMatchObject({
      mode: "high",
      profile: "coder",
      score: 0.72,
    });
    expect(parseClassificationOutput("profile: coder only")).toBeUndefined();
  });

  it("requires a pinned classifier model and honors cooldown", () => {
    const pool = buildAutoPool([
      model("gateway", "gpt-5.6-luna"),
      model("gateway", "gpt-5.6-sol"),
      model("gateway", "kimi-k3"),
    ], AA);
    const state = createClassifierState();

    expect(selectClassifierModel(pool, AA, state, 1)).toBeUndefined();

    const pinned: RouterConfig = { ...AA, classifier: { ...AA.classifier, enabled: true }, classifierModel: "gateway/kimi-k3" };
    expect(selectClassifierModel(pool, pinned, state, 1)?.canonicalKey).toBe("kimi-k3");

    recordClassifierFailure(state, "gateway/kimi-k3", 1, { ...pinned, classifier: { ...pinned.classifier, failureThreshold: 1 } });
    expect(isClassifierModelDisabled(state, "gateway/kimi-k3", 2)).toBe(true);
    expect(selectClassifierModel(pool, pinned, state, 2)).toBeUndefined();

    recordClassifierSuccess(state, "gateway/kimi-k3");
    expect(isClassifierModelDisabled(state, "gateway/kimi-k3", 3)).toBe(false);
  });

  // Mode drives the climb directly (content-derived in production); reasoning level never does.
  const pickAtBucket = (
    pool: ReturnType<typeof buildAutoPool>,
    ctx: Context,
    cfg: RouterConfig,
    bucket: number,
  ) =>
    selectFromPool(
      { cls: ["low", "medium", "high", "ultra"][bucket] as "low" | "medium" | "high" | "ultra", score: 0, chosen: "", modeBucket: bucket },
      pool,
      ctx,
      undefined,
      cfg,
    )?.selected.canonicalKey;

  it("routes across all language-neutral capability modes (aa)", () => {
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

    // Quality policy picks the strongest profile score in the requested mode.
    expect(pick(0)).toBe("kimi-k2.7-code");
    expect(pick(1)).toBe("gpt-5.5");
    expect(pick(2)).toBe("gpt-5.5");
    expect(pick(3)).toBe("gpt-5.5");
  });

  it("routes Ramp mode buckets through Low, Medium, High, and Ultra", () => {
    const pool = buildAutoPool([
      model("gateway", "gpt-5.4-nano"),
      model("gateway", "qwen3.7-plus"),
      model("gateway", "qwen3.6-plus"),
      model("gateway-codex", "gpt-5.4"),
      model("gateway", "deepseek-v4-flash"),
      model("gateway", "kimi-k2.7-code"),
      model("gateway-codex", "gpt-5.5"),
      model("anthropic", "claude-fable-5"),
    ]);
    const coder = context("implement a typescript helper");
    const pick = (bucket: number) => pickAtBucket(pool, coder, DEFAULT_CONFIG, bucket);

    expect(pick(0)).toBe("gpt-5.4");
    expect(pick(1)).toBe("deepseek-v4-flash");
    expect(pick(2)).toBe("gpt-5.5");
    expect(pick(3)).toBe("claude-fable-5");
  });

  it("defaults to the strongest model inside the requested mode", () => {
    const pool = buildAutoPool([
      model("gateway", "kimi-k2.7-code"),
      model("gateway", "glm-5.2"),
      model("gateway", "gpt-5.6-sol"),
    ]);
    const coder = context("implement a typescript helper");
    const selection = selectFromPool(
      { cls: "high", score: 0.6, chosen: "", modeBucket: 2, requestedProfile: "coder" },
      pool,
      coder,
      undefined,
      DEFAULT_CONFIG,
    );

    expect(DEFAULT_CONFIG.selectionPolicy).toBe("quality");
    expect(selection?.selected.canonicalKey).toBe("gpt-5.6-sol");
    expect(selection?.selected.capabilityMode).toBe("high");
  });

  it("lets cost-sensitive users choose the cheapest model inside the requested mode", () => {
    const pool = buildAutoPool([
      model("gateway", "kimi-k2.7-code"),
      model("gateway", "glm-5.2"),
      model("gateway", "gpt-5.6-sol"),
    ], COST_RAMP);
    const coder = context("implement a typescript helper");
    const selection = selectFromPool(
      { cls: "high", score: 0.6, chosen: "", modeBucket: 2, requestedProfile: "coder" },
      pool,
      coder,
      undefined,
      COST_RAMP,
    );

    expect(selection?.selected.canonicalKey).toBe("kimi-k2.7-code");
  });

  it("keeps selection inside the requested mode", () => {
    const pool = buildAutoPool([
      model("gateway", "glm-5.2"),
      model("anthropic", "claude-fable-5"),
    ]);
    const coder = context("implement a typescript helper");
    const selection = selectFromPool(
      { cls: "high", score: 0.73, chosen: "", modeBucket: 2, requestedProfile: "coder" },
      pool,
      coder,
      undefined,
      DEFAULT_CONFIG,
    );

    expect(selection?.selected.canonicalKey).toBe("glm-5.2");
  });

  it("borrows the nearest stronger mode, then the strongest lower mode", () => {
    const coder = context("implement a typescript helper");
    const stronger = buildAutoPool([model("gateway-codex", "gpt-5.4"), model("anthropic", "claude-fable-5")]);
    const high = selectFromPool(
      { cls: "high", score: 0.6, chosen: "", modeBucket: 2, requestedProfile: "coder" },
      stronger,
      coder,
      undefined,
      DEFAULT_CONFIG,
    );
    expect(high?.selected.canonicalKey).toBe("claude-fable-5");
    expect(high?.reason).toContain("high unavailable");

    const lower = buildAutoPool([model("gateway-codex", "gpt-5.4")]);
    const ultra = selectFromPool(
      { cls: "ultra", score: 0.86, chosen: "", modeBucket: 3, requestedProfile: "coder" },
      lower,
      coder,
      undefined,
      DEFAULT_CONFIG,
    );
    expect(ultra?.selected.canonicalKey).toBe("gpt-5.4");
    expect(ultra?.reason).toContain("ultra unavailable");
  });

  it("falls back to policy routing for manual overrides without a capability mode", () => {
    const cfg: RouterConfig = {
      ...DEFAULT_CONFIG,
      modelOverrides: {
        "local/private-coder": {
          intelligence: 70,
          priceBlended: 0.1,
          profiles: ["coder"],
        },
      },
    };
    const pool = buildAutoPool([model("local", "private-coder")], cfg);
    const coder = context("implement a typescript helper");
    expect(selectFromPool(lowDecision(coder, cfg), pool, coder, undefined, cfg)?.selected.canonicalKey).toBe("private-coder");
  });

  it("carries benchmark effort through the selected routing variant", () => {
    const pool = buildAutoPool([
      model("gateway", "qwen3.7-plus"),
      model("gateway-codex", "gpt-5.4"),
      model("gateway", "glm-5.2"),
      model("anthropic", "claude-fable-5"),
    ]);
    const coder = context("implement a typescript helper");
    const selection = selectFromPool(ultraDecision(coder), pool, coder, { reasoning: "high" }, DEFAULT_CONFIG);

    expect(selection?.selected.canonicalKey).toBe("claude-fable-5");
    expect(selection?.benchmarkEffort).toBe("xhigh");
  });

  it("scales the effective price by the user cost coefficient", () => {
    expect(item(buildAutoPool([model("gateway", "glm-5.2")]), "glm-5.2").priceBlended).toBe(1.84);
    const discounted = buildAutoPool([model("gateway", "glm-5.2")], {
      ...COST_RAMP,
      modelOverrides: { "gateway/glm-5.2": { costCoef: 0.25 } },
    });
    expect(item(discounted, "glm-5.2").priceBlended).toBeCloseTo(0.46);
  });

  it("keeps the build-time price time-neutral and re-applies windows per turn", () => {
    const cfg: RouterConfig = {
      ...DEFAULT_CONFIG,
      modelOverrides: { "gateway/glm-5.2": { costCoef: 0.2, costCoefHours: [{ hours: [14, 18], factor: 3 }] } },
    };
    // Build is time-neutral: base coef only, no clock baked in.
    const pool = buildAutoPool([model("gateway", "glm-5.2")], cfg);
    expect(item(pool, "glm-5.2").priceBlended).toBeCloseTo(1.84 * 0.2);

    // Per-turn reprice applies the window without rebuilding: 10:00 off-peak, 15:00 inside the 3× window.
    expect(item(repriceForTimeOfDay(pool, 10), "glm-5.2").priceBlended).toBeCloseTo(1.84 * 0.2);
    expect(item(repriceForTimeOfDay(pool, 15), "glm-5.2").priceBlended).toBeCloseTo(1.84 * 0.6);
  });

  it("uses time-of-day effective cost inside the selected Ramp mode", () => {
    const cfg: RouterConfig = {
      ...COST_RAMP,
      modelOverrides: {
        "gateway/glm-5.2": { costCoef: 0.35, costCoefHours: [{ hours: [14, 18], factor: 3 }] },
        "gateway-codex/gpt-5.5": { costCoef: 0.6 },
      },
    };
    const pool = buildAutoPool([
      model("gateway", "glm-5.2"),
      model("gateway", "gpt-5.6-sol"),
      model("gateway-codex", "gpt-5.5"),
    ], cfg);
    const coder = context("implement a typescript helper");
    const decision = { cls: "high" as const, score: 0.52, chosen: "", modeBucket: 2, requestedProfile: "coder" as const };
    const pick = (atHour: number) => selectFromPool(
      decision,
      repriceForTimeOfDay(pool, atHour),
      coder,
      undefined,
      cfg,
    )?.selected.canonicalKey;

    expect(pick(10)).toBe("glm-5.2");
    expect(pick(15)).toBe("gpt-5.6-sol");
  });

  it("applies time-of-day repricing inside a forced mode under the cost policy", () => {
    const cfg: RouterConfig = {
      ...COST_RAMP,
      modelOverrides: { "gateway/qwen3.7-plus": { costCoef: 0.2, costCoefHours: [{ hours: [14, 18], factor: 30 }] } },
    };
    const pool = buildAutoPool([model("gateway-codex", "gpt-5.4"), model("gateway", "qwen3.7-plus")], cfg);
    const coder = context("implement a typescript helper");

    expect(selectFromPool(lowDecision(coder, cfg), pool, coder, undefined, cfg)?.selected.canonicalKey).toBe("qwen3.7-plus");
    expect(selectFromPool(lowDecision(coder, cfg), repriceForTimeOfDay(pool, 15), coder, undefined, cfg)?.selected.canonicalKey).toBe("gpt-5.4");
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

  it("keeps the warm model instead of downgrading or switching sideways", () => {
    const pool = buildAutoPool([model("gateway", "gpt-5.5"), model("gateway", "qwen3.7-plus")]);
    const state = createRoutingState();
    state.lease = { modelKey: "gateway/gpt-5.5", provider: "gateway", cost: { input: 0, cacheRead: 0, cacheWrite: 0 }, warmTokens: 100_000, establishedAtTurn: 0, lastUsedTurn: 0 };

    const result = cacheAwareSelect(freshSelection(item(pool, "qwen3.7-plus")), state, pool, ctx, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("sticky-session");
    expect(result.selection.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("switches immediately when the required capability mode increases", () => {
    const pool = buildAutoPool([model("gateway", "qwen3.7-plus"), model("gateway", "gpt-5.5")]);
    const state = createRoutingState();
    state.lease = { modelKey: "gateway/qwen3.7-plus", provider: "gateway", cost: { input: 0, cacheRead: 0, cacheWrite: 0 }, warmTokens: 100_000, establishedAtTurn: 0, lastUsedTurn: 0 };

    const result = cacheAwareSelect(freshSelection(item(pool, "gpt-5.5")), state, pool, ctx, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("capability-upgrade");
    expect(result.selection.selected.canonicalKey).toBe("gpt-5.5");
  });

  it("does not sacrifice a warm cache for a stronger model in the same mode", () => {
    const pool = buildAutoPool([model("gateway", "glm-5.2"), model("gateway", "gpt-5.6-sol")]);
    const state = createRoutingState();
    state.lease = { modelKey: "gateway/glm-5.2", provider: "gateway", cost: { input: 0, cacheRead: 0, cacheWrite: 0 }, warmTokens: 100_000, establishedAtTurn: 0, lastUsedTurn: 0 };

    const result = cacheAwareSelect(freshSelection(item(pool, "gpt-5.6-sol")), state, pool, ctx, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("sticky-session");
    expect(result.selection.selected.canonicalKey).toBe("glm-5.2");
  });

  it("does not retain a warm text-only model for an image request", () => {
    const textOnly = model("gateway", "glm-5.2");
    const vision = model("gateway", "gpt-5.6-sol");
    vision.input = ["text", "image"];
    const pool = buildAutoPool([textOnly, vision]);
    const state = createRoutingState();
    state.lease = { modelKey: "gateway/glm-5.2", provider: "gateway", cost: { input: 0, cacheRead: 0, cacheWrite: 0 }, warmTokens: 10_000, establishedAtTurn: 0, lastUsedTurn: 0 };
    const imageContext: Context = { messages: [{ role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 1 }] };

    const result = cacheAwareSelect(freshSelection(item(pool, "gpt-5.6-sol")), state, pool, imageContext, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("lease-ineligible");
    expect(result.selection.selected.canonicalKey).toBe("gpt-5.6-sol");
  });

  it("does not retain a warm model after its context window is exceeded", () => {
    const small = model("gateway", "glm-5.2");
    small.contextWindow = 8;
    const large = model("gateway", "gpt-5.6-sol");
    const pool = buildAutoPool([small, large]);
    const state = createRoutingState();
    state.lease = { modelKey: "gateway/glm-5.2", provider: "gateway", cost: { input: 0, cacheRead: 0, cacheWrite: 0 }, warmTokens: 10_000, establishedAtTurn: 0, lastUsedTurn: 0 };
    const longContext = context("x".repeat(200));

    const result = cacheAwareSelect(freshSelection(item(pool, "gpt-5.6-sol")), state, pool, longContext, DEFAULT_CONFIG);
    expect(result.cacheReason).toBe("lease-ineligible");
    expect(result.selection.selected.canonicalKey).toBe("gpt-5.6-sol");
  });

  it("counts user turns for the switch cooldown", () => {
    expect(userTurnIndex(context("one"))).toBe(1);
  });
});
