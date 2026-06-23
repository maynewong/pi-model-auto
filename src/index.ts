import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  streamSimple as aiStreamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_CONFIG,
  axisValue,
  buildAutoPool,
  decide,
  frontierChain,
  matchesModelFilter,
  modelKey,
  resolveModel,
  routingTurnKey,
  selectFromPool,
  shouldReuseTurnSelection,
  type Decision,
  type Pool,
  type ResolvedModel,
  type RouterConfig,
  type Selection,
  type Tier,
} from "./router-core.ts";
import { QuotaState, buildPlanKey, filterPoolByQuota, type PlanState } from "./quota.ts";

type ForcedRoute = { tier: Tier } | { model: string };
type ResolvedAuth = { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
type QuotaPlanLookup = Map<string, { planKey: string; auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>> }>;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface LastDecision extends Decision {
  chosen: string;
  planKey: string;
  canonical: string | null;
  costTier: string;
  profile?: string;
  confidence: string;
  alternatives: string[];
}

export default function modelRouter(pi: ExtensionAPI) {
  let extCtx: ExtensionContext | undefined;
  let cfg: RouterConfig = DEFAULT_CONFIG;
  let quota: QuotaState = new QuotaState(DEFAULT_CONFIG.quota);
  let pool: Pool = { cheapPool: [], strongPool: [], standardPool: [], unknownPool: [], all: [] };
  let forcedRoute: ForcedRoute | undefined;
  let lastDecision: LastDecision | undefined;
  let turnSelection: { key: string; selection: Selection } | undefined;
  let providerRegistered = false;

  pi.registerCommand("router", {
    description: "Show Pi Model Router pool and last decision",
    handler: async (_args, ctx) => {
      ctx.ui.notify(describeRouter(pool, cfg, lastDecision, quota), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    extCtx = ctx;
    cfg = loadConfig(ctx);
    quota = new QuotaState(cfg.quota);
    quota.load(quotaStateFile());
    pool = applyConfiguredTiers(buildAutoPool(ctx.modelRegistry.getAvailable(), cfg), cfg, ctx);
    turnSelection = undefined;

    const api = `pi-router-api:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (providerRegistered) pi.unregisterProvider("pi-router");
    providerRegistered = true;

    pi.registerProvider("pi-router", {
      name: "Pi Router",
      api,
      baseUrl: "https://router.local",
      apiKey: "pi-router-dummy-key",
      models: [
        {
          id: "auto",
          name: "Pi Router (Auto)",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 64_000,
        },
      ],
      streamSimple,
    });

    updateRouterStatus(ctx, pool.all.length === 0 ? "🧭 no models" : "🧭 ready");
  });

  pi.on("model_select", async (event, ctx) => {
    if (isRouterModel(event.model)) {
      updateRouterStatus(ctx, lastDecision ? shortStatus(lastDecision, quota) : "🧭 ready");
    } else {
      ctx.ui.setStatus("router", undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    forcedRoute = undefined;
    lastDecision = undefined;
    turnSelection = undefined;
    extCtx = undefined;
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };

    const parsed = parseForcedRoute(event.text);
    forcedRoute = parsed?.route;
    if (!parsed) return { action: "continue" };

    return { action: "transform", text: parsed.text, images: event.images };
  });

  function streamSimple(routerModel: Model<Api>, context: Context, options?: SimpleStreamOptions) {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      try {
        const ctx = extCtx;
        if (!ctx) throw new Error("Pi Router: extension context not initialized");
        if (pool.all.length === 0) {
          throw new Error("Pi Router: no authenticated models. Run /login or configure an API key, then /reload.");
        }

        const decision = decide(context, options, forcedRoute, cfg);
        const quotaPlans = cfg.quota.enabled && !forcedRoute ? await resolveQuotaPlans(ctx, pool) : new Map();
        const turnKey = routingTurnKey(context);
        const cachedSelection = turnSelection;
        const reuseTurnSelection =
          decision.cls !== "model" && shouldReuseTurnSelection(context) && cachedSelection?.key === turnKey;
        const selectionPool = forcedRoute || reuseTurnSelection
          ? pool
          : usablePoolForQuota(ctx, cfg, pool, quota, Date.now(), quotaPlans);
        const selection = reuseTurnSelection
          ? { ...cachedSelection.selection, reason: `${cachedSelection.selection.reason}; reused within user turn` }
          : selectModel(decision, selectionPool, context, options, ctx, cfg);
        const target = selection.selected.model;

        if (decision.cls !== "model") turnSelection = { key: turnKey, selection };

        const selectedAuth = quotaPlans.get(modelKey(target))?.auth;
        const auth = selectedAuth ?? await ctx.modelRegistry.getApiKeyAndHeaders(target);
        if (!auth.ok) throw new Error(auth.error);
        const planKey = quotaPlans.get(modelKey(target))?.planKey ?? modelPlanKey(target, auth);

        const requestedReasoning = options?.reasoning ?? "off";
        const clampedReasoning = target.reasoning ? clampThinkingLevel(target, requestedReasoning) : "off";
        const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
        const maxTokens = Math.min(options?.maxTokens ?? target.maxTokens, target.maxTokens);

        lastDecision = {
          ...decision,
          chosen: modelKey(target),
          planKey,
          canonical: selection.selected.canonicalKey,
          costTier: selection.selected.costTier,
          profile: selection.profile,
          confidence: selection.selected.confidence,
          reason: selection.reason,
          alternatives: selection.alternatives,
        };

        updateRouterStatus(ctx, shortStatus(lastDecision, quota));
        logDecision(ctx, cfg, lastDecision);

        const inner = aiStreamSimple(target, context, {
          ...options,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          reasoning,
          maxTokens,
          onResponse: async (response, model) => {
            await options?.onResponse?.(response, model);
            if (!cfg.quota.enabled) return;

            recordQuotaChange(ctx, cfg, quota, planKey, () =>
              quota.recordResponse(planKey, response.status, response.headers, target.provider, Date.now()),
            );
            if (lastDecision) updateRouterStatus(ctx, shortStatus(lastDecision, quota));
          },
        });

        for await (const event of inner) {
          if (event.type === "error" && looksRateLimited(event.error) && cfg.quota.enabled) {
            recordQuotaChange(ctx, cfg, quota, planKey, () =>
              quota.recordRateLimited(planKey, undefined, undefined, Date.now()),
            );
            if (lastDecision) updateRouterStatus(ctx, shortStatus(lastDecision, quota));
          }

          stream.push(event);
          if (event.type === "done" || event.type === "error") {
            logTerminalEvent(ctx, cfg, lastDecision, event);
          }
        }
        stream.end();
      } catch (error) {
        stream.push(makeRouterError(routerModel, error));
        stream.end();
      }
    })();

    return stream;
  }
}

function selectModel(
  decision: Decision,
  pool: Pool,
  context: Context,
  options: SimpleStreamOptions | undefined,
  ctx: ExtensionContext,
  cfg: RouterConfig,
) {
  if (decision.cls === "model") {
    const model = findModelByRef(ctx, decision.chosen);
    if (!model) throw new Error(`Pi Router: forced model not available or not authenticated: ${decision.chosen}`);
    const selected = resolveModel(model, cfg);
    return { selected, profile: selected.profiles[0] ?? "balanced", reason: "forced model", alternatives: [] };
  }

  const selection = selectFromPool(decision, pool, context, options, cfg);
  if (!selection) throw new Error("Pi Router: model pool is empty");
  return selection;
}

function applyConfiguredTiers(pool: Pool, cfg: RouterConfig, ctx: ExtensionContext): Pool {
  const next: Pool = {
    cheapPool: [...pool.cheapPool],
    strongPool: [...pool.strongPool],
    standardPool: [...pool.standardPool],
    unknownPool: [...pool.unknownPool],
    all: [...pool.all],
  };

  for (const tier of ["cheap", "strong"] as const) {
    const ref = cfg.tierModels[tier];
    if (!ref) continue;

    const model = findModelByRef(ctx, ref);
    if (!model) {
      ctx.ui.notify(`Pi Router: configured ${tier} model not found or unauthenticated: ${ref}`, "warning");
      continue;
    }

    const resolved = resolveModel(model, cfg);
    if (!matchesModelFilter(resolved, cfg.modelFilter)) {
      ctx.ui.notify(`Pi Router: configured ${tier} model rejected by modelFilter: ${ref}`, "warning");
      continue;
    }

    prependUnique(tier === "cheap" ? next.cheapPool : next.strongPool, resolved);
    prependUnique(next.all, resolved);
  }

  return next;
}

function prependUnique(items: ResolvedModel[], item: ResolvedModel) {
  const key = modelKey(item.model);
  const existing = items.findIndex((candidate) => modelKey(candidate.model) === key);
  if (existing >= 0) items.splice(existing, 1);
  items.unshift(item);
}

function findModelByRef(ctx: ExtensionContext, ref: string): Model<Api> | undefined {
  const [provider, ...idParts] = ref.split("/");
  const id = idParts.join("/");
  if (!provider || !id) return undefined;

  const model = ctx.modelRegistry.find(provider, id);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
  return model;
}

function updateRouterStatus(ctx: ExtensionContext, text: string) {
  if (ctx.model && !isRouterModel(ctx.model)) {
    ctx.ui.setStatus("router", undefined);
    return;
  }
  ctx.ui.setStatus("router", text);
}

function isRouterModel(model: Model<Api> | undefined): boolean {
  return model?.provider === "pi-router" && model.id === "auto";
}

function parseForcedRoute(text: string): { route: ForcedRoute; text: string } | undefined {
  const match = text.match(/^@(cheap|strong|model:([^\s]+))\s+([\s\S]*)$/);
  if (!match) return undefined;
  if (match[1] === "cheap" || match[1] === "strong") return { route: { tier: match[1] }, text: match[3] };
  return { route: { model: match[2] }, text: match[3] };
}

function loadConfig(ctx: ExtensionContext): RouterConfig {
  let cfg = DEFAULT_CONFIG;
  for (const file of configPaths(ctx)) {
    if (!existsSync(file)) continue;

    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const router = parsed.router ?? parsed;
      cfg = {
        ...cfg,
        ...router,
        weights: { ...cfg.weights, ...(router.weights ?? {}) },
        tierModels: { ...cfg.tierModels, ...(router.tierModels ?? router.models ?? {}) },
        modelFilter: { ...cfg.modelFilter, ...(router.modelFilter ?? {}) },
        modelOverrides: { ...cfg.modelOverrides, ...(router.modelOverrides ?? router.overrides ?? {}) },
        willingness: { ...cfg.willingness, ...(router.willingness ?? {}) },
        quota: { ...cfg.quota, ...(router.quota ?? {}) },
      };
    } catch (error) {
      ctx.ui.notify(`Pi Router: failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }
  return cfg;
}

function configPaths(ctx: ExtensionContext): string[] {
  const paths = [join(getAgentDir(), "model-router.json")];
  if (ctx.isProjectTrusted()) paths.push(join(ctx.cwd, CONFIG_DIR_NAME, "model-router.json"));
  return paths;
}

function quotaStateFile(): string {
  return join(getAgentDir(), "quota-state.json");
}

function describeRouter(
  pool: Pool,
  cfg: RouterConfig,
  lastDecision: LastDecision | undefined,
  quota: QuotaState,
): string {
  const lines = [
    "Pi Router",
    `forceStrongOnHighReasoning: ${cfg.forceStrongOnHighReasoning}`,
    `modelFilter: include=[${cfg.modelFilter.include.join(", ") || "*"}] exclude=[${cfg.modelFilter.exclude.join(", ") || "none"}]`,
    `quota: ${cfg.quota.enabled ? "enabled" : "disabled"}`,
    `cheapPool: ${pool.cheapPool.map((item) => modelKey(item.model)).join(", ") || "none"}`,
    `strongPool: ${pool.strongPool.map((item) => `${modelKey(item.model)}(${item.canonicalKey ?? "unknown"}/${item.costTier}/${item.profiles.join("+")})`).join(", ") || "none"}`,
    `standardPool: ${pool.standardPool.map((item) => modelKey(item.model)).join(", ") || "none"}`,
    `unknownPool: ${pool.unknownPool.map((item) => modelKey(item.model)).join(", ") || "none"}`,
    "frontier (auto climbs these cheap→strong by hardness):",
    ...(["coder", "deep", "balanced"] as const).map((profile) => {
      const chain = frontierChain(pool.all, profile);
      const points = chain
        .map((item) => `${item.canonicalKey ?? modelKey(item.model)}(${axisValue(item, profile).toFixed(0)}@$${item.priceBlended})`)
        .join(" → ");
      return `  ${profile}: ${points || "none"}`;
    }),
  ];

  if (lastDecision) {
    lines.push(
      "last:",
      `  chosen: ${lastDecision.chosen}`,
      `  planKey: ${lastDecision.planKey}`,
      `  canonical: ${lastDecision.canonical ?? "unknown"}`,
      `  costTier: ${lastDecision.costTier}`,
      `  profile: ${lastDecision.profile ?? "unknown"}`,
      `  confidence: ${lastDecision.confidence}`,
      `  reason: ${lastDecision.reason ?? "none"}`,
      `  alternatives: ${lastDecision.alternatives.join(", ") || "none"}`,
    );
  } else {
    lines.push("last: none");
  }

  const plans = quota.snapshots();
  if (plans.length > 0) {
    lines.push("plans:");
    for (const plan of plans) {
      lines.push(`  ${formatPlanState(plan)}`);
    }
  } else {
    lines.push("plans: none");
  }

  return lines.join("\n");
}

function logDecision(ctx: ExtensionContext, cfg: RouterConfig, decision: LastDecision | undefined) {
  if (!cfg.log || !decision) return;
  appendJsonLine(ctx, { ts: new Date().toISOString(), ...decision });
}

function logTerminalEvent(
  ctx: ExtensionContext,
  cfg: RouterConfig,
  decision: LastDecision | undefined,
  event: AssistantMessageEvent,
) {
  if (!cfg.log || !decision) return;
  if (event.type !== "done" && event.type !== "error") return;

  const message = event.type === "done" ? event.message : event.error;
  appendJsonLine(ctx, {
    ts: new Date().toISOString(),
    chosen: decision.chosen,
    stopReason: message.stopReason,
    usage: message.usage,
  });
}

function appendJsonLine(ctx: ExtensionContext, value: unknown) {
  const file = join(ctx.cwd, CONFIG_DIR_NAME, "router.log");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function usablePoolForQuota(
  ctx: ExtensionContext,
  cfg: RouterConfig,
  pool: Pool,
  quota: QuotaState,
  now: number,
  quotaPlans: QuotaPlanLookup,
): Pool {
  if (!cfg.quota.enabled) return pool;

  let changed = false;
  for (const planKey of new Set(pool.all.map((item) => quotaPlanKeyFor(item, quotaPlans)))) {
    const before = quota.snapshot(planKey);
    quota.isAvailable(planKey, now);
    const after = quota.snapshot(planKey);
    if (quotaStateChanged(before, after)) {
      changed = true;
      logQuotaChange(ctx, cfg, after);
    }
  }
  if (changed) quota.persist(quotaStateFile());

  return filterPoolByQuota(pool, quota, now, new Set(), (item) => quotaPlanKeyFor(item, quotaPlans));
}

function recordQuotaChange(
  ctx: ExtensionContext,
  cfg: RouterConfig,
  quota: QuotaState,
  planKey: string,
  update: () => PlanState,
): PlanState {
  const before = quota.snapshot(planKey);
  const after = update();
  quota.persist(quotaStateFile());
  if (quotaStateChanged(before, after)) logQuotaChange(ctx, cfg, after);
  return after;
}

function quotaStateChanged(before: PlanState | undefined, after: PlanState | undefined): boolean {
  return (
    before?.status !== after?.status ||
    before?.reason !== after?.reason ||
    before?.cooldownUntil !== after?.cooldownUntil
  );
}

function logQuotaChange(ctx: ExtensionContext, cfg: RouterConfig, state: PlanState | undefined) {
  if (!cfg.log || !state) return;
  appendJsonLine(ctx, {
    ts: new Date().toISOString(),
    planKey: state.planKey,
    status: state.status,
    reason: state.reason,
    cooldownUntil: state.cooldownUntil,
  });
}

function looksRateLimited(message: AssistantMessage): boolean {
  const text = `${message.stopReason ?? ""} ${message.errorMessage ?? ""}`.toLowerCase();
  return text.includes("429") || text.includes("rate limit") || text.includes("too many requests") || text.includes("quota");
}

function shortStatus(decision: LastDecision, quota: QuotaState): string {
  const model = decision.chosen.split("/").at(-1) ?? decision.chosen;
  return `🧭 ${model} · ${decision.costTier}${quotaStatusTag(quota.snapshot(decision.planKey), Date.now())}`;
}

function quotaStatusTag(state: PlanState | undefined, now: number): string {
  if (state?.status === "cooldown" && state.cooldownUntil != null) {
    return ` ⏳${Math.max(0, Math.ceil((state.cooldownUntil - now) / 60_000))}m`;
  }

  const snapshot = state?.lastSnapshot;
  if (snapshot?.remaining != null && snapshot.limit != null && snapshot.limit > 0) {
    return ` ${Math.round((100 * snapshot.remaining) / snapshot.limit)}%`;
  }

  return "";
}

function formatPlanState(state: PlanState): string {
  const remaining = quotaStatusTag(state, Date.now()).trim();
  const cooldownUntil = state.cooldownUntil ? ` cooldownUntil=${new Date(state.cooldownUntil).toISOString()}` : "";
  return `${state.planKey}: ${state.status}${state.reason ? ` reason=${state.reason}` : ""}${cooldownUntil}${remaining ? ` ${remaining}` : ""}`;
}

async function resolveQuotaPlans(ctx: ExtensionContext, pool: Pool): Promise<QuotaPlanLookup> {
  const entries = await Promise.all(
    pool.all.map(async (item) => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(item.model);
      const planKey = auth.ok ? modelPlanKey(item.model, auth) : modelPlanKey(item.model);
      return [modelKey(item.model), { planKey, auth }] as const;
    }),
  );
  return new Map(entries);
}

function quotaPlanKeyFor(item: ResolvedModel, quotaPlans: QuotaPlanLookup): string {
  return quotaPlans.get(modelKey(item.model))?.planKey ?? modelPlanKey(item.model);
}

function modelPlanKey(model: Model<Api>, auth?: ResolvedAuth): string {
  return buildPlanKey({
    provider: model.provider,
    baseUrl: model.baseUrl,
    apiKey: auth?.apiKey,
    headers: auth?.headers,
    env: auth?.env,
  });
}

function makeRouterError(model: Model<Api>, error: unknown): AssistantMessageEvent {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: `Pi Router error: ${errorMessage}` }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: structuredClone(ZERO_USAGE),
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };

  return { type: "error", reason: "error", error: message };
}
