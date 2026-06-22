import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Pool, ResolvedModel } from "./router-core.ts";
import {
  DEFAULT_QUOTA_CONFIG,
  QuotaState,
  buildPlanKey,
  filterPoolByQuota,
  parseDuration,
  parseRateLimitHeaders,
  parseRetryAfter,
} from "./quota.ts";

const NOW = Date.parse("2026-06-22T10:00:00.000Z");

function model(provider: string, id: string, baseUrl = "https://example.invalid"): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function resolved(provider: string, id: string, baseUrl?: string): ResolvedModel {
  return {
    model: model(provider, id, baseUrl),
    acceptsImage: false,
    canonicalKey: id,
    costTier: "cheap",
    profiles: ["balanced"],
    frontier: false,
    confidence: "high",
    matchReason: "test",
  };
}

function pool(items: ResolvedModel[]): Pool {
  return {
    cheapPool: items.slice(0, 1),
    standardPool: items.slice(1, 2),
    strongPool: items.slice(2, 3),
    unknownPool: items.slice(3),
    all: items,
  };
}

describe("rate-limit header parsing", () => {
  it("normalizes Anthropic token quota headers", () => {
    const snapshot = parseRateLimitHeaders(
      "anthropic",
      {
        "anthropic-ratelimit-tokens-remaining": "12",
        "anthropic-ratelimit-tokens-limit": "100",
        "anthropic-ratelimit-tokens-reset": "2026-06-22T10:05:00Z",
      },
      NOW,
    );

    expect(snapshot).toEqual({ remaining: 12, limit: 100, resetAt: NOW + 300_000 });
  });

  it("normalizes OpenAI-style duration reset headers", () => {
    const snapshot = parseRateLimitHeaders(
      "openai",
      {
        "x-ratelimit-remaining-tokens": "5",
        "x-ratelimit-limit-tokens": "200",
        "x-ratelimit-reset-tokens": "6m0s",
      },
      NOW,
    );

    expect(snapshot).toEqual({ remaining: 5, limit: 200, resetAt: NOW + 360_000 });
  });

  it("uses retry-after as a generic reset fallback", () => {
    expect(parseRateLimitHeaders("zhipu", { "retry-after": "12" }, NOW)).toEqual({ resetAt: NOW + 12_000 });
    expect(parseRateLimitHeaders("zhipu", { "retry-after": "Mon, 22 Jun 2026 10:01:00 GMT" }, NOW)).toEqual({
      resetAt: NOW + 60_000,
    });
  });

  it("treats bad parser inputs as absent signals", () => {
    expect(parseDuration("tomorrow")).toBeUndefined();
    expect(parseRetryAfter("not a date", NOW)).toBeUndefined();
    expect(parseRateLimitHeaders("openai", { "x-ratelimit-remaining-tokens": "NaN" }, NOW)).toEqual({});
  });
});

describe("plan identity", () => {
  it("keys quota by provider, baseUrl, and hashed auth identity without including the model id", () => {
    const firstAccount = buildPlanKey({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "sk-first",
      headers: { Authorization: "Bearer token-first" },
    });
    const sameAccountDifferentModel = buildPlanKey({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-first",
      headers: { authorization: "Bearer token-first" },
    });
    const secondAccount = buildPlanKey({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-second",
      headers: { Authorization: "Bearer token-second" },
    });
    const compatibleProxy = buildPlanKey({
      provider: "openai",
      baseUrl: "https://proxy.example/v1",
      apiKey: "sk-first",
      headers: { Authorization: "Bearer token-first" },
    });

    expect(firstAccount).toBe(sameAccountDifferentModel);
    expect(firstAccount).not.toBe(secondAccount);
    expect(firstAccount).not.toBe(compatibleProxy);
    expect(firstAccount).not.toContain("sk-first");
    expect(firstAccount).not.toContain("token-first");
  });
});

describe("QuotaState", () => {
  it("cooldowns on 429 and automatically restores availability after the window", () => {
    const quota = new QuotaState(DEFAULT_QUOTA_CONFIG);

    quota.recordRateLimited("anthropic", 30_000, undefined, NOW);

    expect(quota.isAvailable("anthropic", NOW + 29_999)).toBe(false);
    expect(quota.snapshot("anthropic")).toMatchObject({ status: "cooldown", reason: "429" });
    expect(quota.isAvailable("anthropic", NOW + 30_000)).toBe(true);
    expect(quota.snapshot("anthropic")).toMatchObject({ status: "ok", reason: undefined });
  });

  it("soft-cooldowns low remaining quota until the provider reset time", () => {
    const quota = new QuotaState({ ...DEFAULT_QUOTA_CONFIG, reserveRatio: 0.1 });

    quota.recordResponse(
      "openai",
      200,
      {
        "x-ratelimit-remaining-tokens": "9",
        "x-ratelimit-limit-tokens": "100",
        "x-ratelimit-reset-tokens": "1m",
      },
      "openai",
      NOW,
    );

    expect(quota.snapshot("openai")).toMatchObject({
      status: "cooldown",
      reason: "low-remaining",
      cooldownUntil: NOW + 60_000,
    });
  });

  it("loads and persists cooldown state without throwing on corrupt files", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-state-"));
    const file = join(dir, "quota.json");

    try {
      const quota = new QuotaState(DEFAULT_QUOTA_CONFIG);
      quota.recordRateLimited("anthropic", undefined, NOW + 120_000, NOW);
      quota.persist(file);

      const restored = new QuotaState(DEFAULT_QUOTA_CONFIG);
      restored.load(file);

      expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(2);
      expect(restored.isAvailable("anthropic", NOW + 119_999)).toBe(false);

      const tolerant = new QuotaState(DEFAULT_QUOTA_CONFIG);
      tolerant.load(join(dir, "missing.json"));
      expect(tolerant.snapshot("anthropic")).toBeUndefined();

      const oldVersion = join(dir, "v1.json");
      writeFileSync(
        oldVersion,
        JSON.stringify({ version: 1, plans: [{ planKey: "anthropic", status: "cooldown", updatedAt: NOW }] }),
        "utf8",
      );
      tolerant.load(oldVersion);
      expect(tolerant.snapshot("anthropic")).toBeUndefined();

      const corrupt = join(dir, "corrupt.json");
      writeFileSync(corrupt, "{", "utf8");
      tolerant.load(corrupt);
      expect(tolerant.snapshot("anthropic")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("filterPoolByQuota", () => {
  it("removes cooling plan identities and falls back to the original pool when every plan is unavailable", () => {
    const models = [
      resolved("openai", "api-paid", "https://api.openai.com/v1"),
      resolved("openai", "subscription", "https://chatgpt.example/v1"),
      resolved("zhipu", "glm"),
    ];
    const original = pool(models);
    const quota = new QuotaState(DEFAULT_QUOTA_CONFIG);
    const paidPlan = buildPlanKey({ provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-paid" });
    const subscriptionPlan = buildPlanKey({
      provider: "openai",
      baseUrl: "https://chatgpt.example/v1",
      headers: { Authorization: "Bearer oauth" },
    });
    const zhipuPlan = buildPlanKey({ provider: "zhipu", baseUrl: "https://example.invalid", apiKey: "zhipu-key" });
    quota.recordRateLimited(paidPlan, 60_000, undefined, NOW);

    const filtered = filterPoolByQuota(original, quota, NOW, new Set([zhipuPlan]), (item) =>
      item.model.id === "api-paid" ? paidPlan : item.model.id === "subscription" ? subscriptionPlan : zhipuPlan,
    );

    expect(filtered.all.map((item) => item.model.id)).toEqual(["subscription"]);

    quota.recordRateLimited(subscriptionPlan, 60_000, undefined, NOW);
    expect(
      filterPoolByQuota(original, quota, NOW, new Set([zhipuPlan]), (item) =>
        item.model.id === "api-paid" ? paidPlan : item.model.id === "subscription" ? subscriptionPlan : zhipuPlan,
      ),
    ).toBe(original);
  });
});
