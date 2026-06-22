import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Pool, ResolvedModel } from "./router-core.ts";

export interface RateLimitSnapshot {
  remaining?: number;
  limit?: number;
  resetAt?: number;
}

export type PlanStatus = "ok" | "cooldown";

export interface PlanState {
  planKey: string;
  status: PlanStatus;
  cooldownUntil?: number;
  reason?: string;
  lastSnapshot?: RateLimitSnapshot;
  updatedAt: number;
}

export interface QuotaConfig {
  enabled: boolean;
  reserveRatio: number;
  inTurnRetry: boolean;
  maxRetries: number;
  defaultCooldownMs: number;
}

export interface PlanIdentity {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export const DEFAULT_QUOTA_CONFIG: QuotaConfig = {
  enabled: true,
  reserveRatio: 0.05,
  inTurnRetry: false,
  maxRetries: 2,
  defaultCooldownMs: 300_000,
};

const QUOTA_STATE_VERSION = 2;

interface PersistedQuotaState {
  version: typeof QUOTA_STATE_VERSION;
  plans: PlanState[];
}

export class QuotaState {
  readonly config: QuotaConfig;
  private readonly plans = new Map<string, PlanState>();

  constructor(config: QuotaConfig | Partial<QuotaConfig> = DEFAULT_QUOTA_CONFIG) {
    this.config = { ...DEFAULT_QUOTA_CONFIG, ...config };
  }

  isAvailable(planKey: string, now: number): boolean {
    const state = this.plans.get(planKey);
    if (!state || state.status === "ok") return true;

    if (state.cooldownUntil != null && now >= state.cooldownUntil) {
      state.status = "ok";
      state.cooldownUntil = undefined;
      state.reason = undefined;
      state.updatedAt = now;
      return true;
    }

    return false;
  }

  recordResponse(
    planKey: string,
    status: number,
    headers: Record<string, string>,
    provider: string,
    now: number,
  ): PlanState {
    const snapshot = parseRateLimitHeaders(provider, headers, now);
    const state = this.get(planKey, now);
    state.lastSnapshot = isEmptySnapshot(snapshot) ? undefined : snapshot;
    state.updatedAt = now;

    if (status === 429) {
      return this.recordRateLimited(planKey, parseRetryAfter(headers["retry-after"], now), snapshot.resetAt, now);
    }

    if (snapshot.remaining != null && snapshot.limit != null && snapshot.limit > 0) {
      if (snapshot.remaining / snapshot.limit <= this.config.reserveRatio) {
        state.status = "cooldown";
        state.cooldownUntil = snapshot.resetAt ?? now + this.config.defaultCooldownMs;
        state.reason = "low-remaining";
        return state;
      }
    }

    state.status = "ok";
    state.cooldownUntil = undefined;
    state.reason = undefined;
    return state;
  }

  recordRateLimited(planKey: string, retryAfterMs: number | undefined, resetAt: number | undefined, now: number): PlanState {
    const state = this.get(planKey, now);
    state.status = "cooldown";
    state.cooldownUntil = resetAt ?? (retryAfterMs != null ? now + retryAfterMs : now + this.config.defaultCooldownMs);
    state.reason = "429";
    state.updatedAt = now;
    return state;
  }

  snapshot(planKey: string): PlanState | undefined {
    const state = this.plans.get(planKey);
    return state ? { ...state, lastSnapshot: state.lastSnapshot ? { ...state.lastSnapshot } : undefined } : undefined;
  }

  snapshots(): PlanState[] {
    return [...this.plans.values()].map((state) => ({
      ...state,
      lastSnapshot: state.lastSnapshot ? { ...state.lastSnapshot } : undefined,
    }));
  }

  load(file: string): void {
    if (!existsSync(file)) return;

    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedQuotaState>;
      if (parsed.version !== QUOTA_STATE_VERSION || !Array.isArray(parsed.plans)) return;

      this.plans.clear();
      for (const plan of parsed.plans) {
        if (!isValidPlanState(plan)) continue;
        this.plans.set(plan.planKey, { ...plan, lastSnapshot: plan.lastSnapshot ? { ...plan.lastSnapshot } : undefined });
      }
    } catch {
      return;
    }
  }

  persist(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const data: PersistedQuotaState = { version: QUOTA_STATE_VERSION, plans: this.snapshots() };
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  private get(planKey: string, now: number): PlanState {
    const existing = this.plans.get(planKey);
    if (existing) return existing;

    const state: PlanState = { planKey, status: "ok", updatedAt: now };
    this.plans.set(planKey, state);
    return state;
  }
}

export function buildPlanKey(identity: PlanIdentity): string {
  const provider = identity.provider.trim().toLowerCase();
  const baseUrl = normalizeBaseUrl(identity.baseUrl);
  const authHash = hashStable({
    apiKey: identity.apiKey ?? null,
    headers: normalizeRecord(identity.headers),
    env: normalizeRecord(identity.env),
  });
  return `${provider}|${baseUrl}|auth:${authHash}`;
}

export function filterPoolByQuota(
  pool: Pool,
  quota: QuotaState | undefined,
  now: number,
  excluded = new Set<string>(),
  planKeyFor: (item: ResolvedModel) => string = (item) =>
    buildPlanKey({ provider: item.model.provider, baseUrl: item.model.baseUrl }),
): Pool {
  if (!quota?.config.enabled) return pool;

  const keep = (item: ResolvedModel) => {
    const planKey = planKeyFor(item);
    return !excluded.has(planKey) && quota.isAvailable(planKey, now);
  };
  const filter = (items: ResolvedModel[]) => items.filter(keep);
  const next: Pool = {
    cheapPool: filter(pool.cheapPool),
    standardPool: filter(pool.standardPool),
    strongPool: filter(pool.strongPool),
    unknownPool: filter(pool.unknownPool),
    all: filter(pool.all),
  };

  return next.all.length === 0 ? pool : next;
}

export function parseRateLimitHeaders(
  _provider: string,
  headers: Record<string, string>,
  now: number,
): RateLimitSnapshot {
  const h = normalizeHeaders(headers);
  const snapshot: RateLimitSnapshot = {};

  if (h["anthropic-ratelimit-tokens-remaining"] != null) {
    snapshot.remaining = num(h["anthropic-ratelimit-tokens-remaining"]);
    snapshot.limit = num(h["anthropic-ratelimit-tokens-limit"]);
    snapshot.resetAt = parseRfc3339(h["anthropic-ratelimit-tokens-reset"]);
  } else if (h["x-ratelimit-remaining-tokens"] != null) {
    snapshot.remaining = num(h["x-ratelimit-remaining-tokens"]);
    snapshot.limit = num(h["x-ratelimit-limit-tokens"]);
    const duration = parseDuration(h["x-ratelimit-reset-tokens"]);
    if (duration != null) snapshot.resetAt = now + duration;
  }

  const retryAfter = parseRetryAfter(h["retry-after"], now);
  if (retryAfter != null && snapshot.resetAt == null) snapshot.resetAt = now + retryAfter;

  return pruneSnapshot(snapshot);
}

export function parseRfc3339(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseDuration(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1_000;

  let total = 0;
  let matched = false;
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  for (const match of trimmed.matchAll(pattern)) {
    matched = true;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return undefined;
    if (match[2] === "ms") total += value;
    if (match[2] === "s") total += value * 1_000;
    if (match[2] === "m") total += value * 60_000;
    if (match[2] === "h") total += value * 3_600_000;
  }

  return matched ? total : undefined;
}

export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1_000;

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, parsed - now);
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function normalizeRecord(record: Record<string, string> | undefined): Record<string, string> | null {
  if (!record || Object.keys(record).length === 0) return null;
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function num(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pruneSnapshot(snapshot: RateLimitSnapshot): RateLimitSnapshot {
  return Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value != null)) as RateLimitSnapshot;
}

function isEmptySnapshot(snapshot: RateLimitSnapshot): boolean {
  return snapshot.remaining == null && snapshot.limit == null && snapshot.resetAt == null;
}

function isValidPlanState(value: unknown): value is PlanState {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<PlanState>;
  return (
    typeof plan.planKey === "string" &&
    (plan.status === "ok" || plan.status === "cooldown") &&
    typeof plan.updatedAt === "number"
  );
}
