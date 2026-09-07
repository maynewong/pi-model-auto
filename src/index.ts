/**
 * Pi manages context against the selected `pi-router/auto` model, while this provider chooses a
 * concrete model per turn. The virtual model is therefore refreshed after routing so Pi's footer
 * and compaction threshold follow the model that actually serves the request.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildSessionContext,
  CONFIG_DIR_NAME,
  convertToLlm,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  completeSimple,
  createAssistantMessageEventStream,
  streamSimple as aiStreamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_CONFIG,
  buildAutoPool,
  cacheAwareSelect,
  createClassifierState,
  createRoutingState,
  decide,
  enableClassifierForPinnedModel,
  estimateContextTokens,
  lastUserText,
  matchesModelFilter,
  mergeClassifierConfig,
  modelKey,
  parseCapabilityMode,
  parseClassificationOutput,
  recordClassifierFailure,
  recordClassifierSuccess,
  recordRoutingUsage,
  repriceForTimeOfDay,
  resolveModel,
  routingReasoning,
  routingTurnKey,
  selectFromPool,
  selectClassifierModel,
  shouldReuseTurnSelection,
  userTurnIndex,
  variantKey,
  type CacheReason,
  type ClassificationResult,
  type ClassifierState,
  type Decision,
  type Pool,
  type ResolvedModel,
  type RouterConfig,
  type RoutingState,
  type Selection,
  type TaskClassifier,
  type CapabilityMode,
} from "./router-core.ts";
import { QuotaState, buildPlanKey, filterPoolByQuota, type PlanState } from "./quota.ts";

type ForcedRoute = { mode: CapabilityMode } | { model: string };
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
  capabilityMode?: string;
  profile?: string;
  benchmarkEffort?: string;
  reasoning?: string;
  confidence: string;
  alternatives: string[];
  cacheReason?: CacheReason;
}

export default function modelRouter(pi: ExtensionAPI) {
  let extCtx: ExtensionContext | undefined;
  let cfg: RouterConfig = DEFAULT_CONFIG;
  let quota: QuotaState = new QuotaState(DEFAULT_CONFIG.quota);
  let pool: Pool = { all: [] };
  let forcedRoute: ForcedRoute | undefined;
  let lastDecision: LastDecision | undefined;
  let turnSelection: { key: string; decision: Decision; selection: Selection; cacheReason?: CacheReason; pending?: boolean } | undefined;
  let routingState: RoutingState = createRoutingState();
  let classifierState: ClassifierState = createClassifierState();
  let routerContextWindow: number | undefined;

  syncRouterContextWindow(1_000_000);

  pi.registerCommand("auto", {
    description: "Show Pi Model Router pool and last decision",
    handler: async (_args, ctx) => {
      ctx.ui.notify(describeRouter(repriceForTimeOfDay(pool, new Date().getHours()), cfg, lastDecision, quota), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    extCtx = ctx;
    cfg = loadConfig(ctx);
    quota = new QuotaState(cfg.quota);
    quota.load(quotaStateFile());
    pool = buildAutoPool(ctx.modelRegistry.getAvailable(), cfg);
    turnSelection = undefined;
    routingState = createRoutingState();
    classifierState = createClassifierState();

    const recentModel = mostRecentConcreteModel(ctx);
    if (recentModel) syncRouterContextWindow(recentModel.contextWindow);

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

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const parsed = parseForcedRoute(event.text);
    const parsedForThisTurn = parsed && isInitialUserTurn(ctx) ? parsed : undefined;
    if (parsed && !parsedForThisTurn) {
      ctx.ui.notify("Pi Router: @low/@medium/@high/@ultra/@model hints only apply at the start of a conversation. Start a new session to pin a mode without carrying existing history.", "warning");
    }
    forcedRoute = parsedForThisTurn?.route;
    // Pi checks preflight compaction after input hooks but before `streamSimple`, so the target
    // window must be installed here or a large→small model switch can miss its compact threshold.
    if (isRouterModel(ctx.model) && !event.streamingBehavior) {
      try {
        await preselectTurn(ctx, inputRoutingContext(ctx, parsedForThisTurn?.text ?? event.text, event.images));
      } catch {
        turnSelection = undefined;
      }
    }

    return parsedForThisTurn
      ? { action: "transform", text: parsedForThisTurn.text, images: event.images }
      : { action: "continue" };
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

        const quotaPlans = cfg.quota.enabled && !forcedRoute ? await resolveQuotaPlans(ctx, pool) : new Map();
        const turnKey = routingTurnKey(context);
        const cachedSelection = turnSelection;
        const preselectedTurn = cachedSelection?.pending === true && cachedSelection.key === turnKey;
        const reuseTurnSelection =
          preselectedTurn ||
          (shouldReuseTurnSelection(context) && cachedSelection?.key === turnKey && cachedSelection.decision.cls !== "model");
        const currentClassifier = !reuseTurnSelection && !shouldReuseTurnSelection(context)
          ? await classifyCurrentTurnWhenEnabled(ctx, context)
          : undefined;
        const decision = reuseTurnSelection
          ? cachedSelection!.decision
          : decide(context, options, forcedRoute, cfg, currentClassifier ? { classify: () => currentClassifier } : undefined);
        // Re-evaluate time-of-day shadow-price windows once per turn (clock read here, pick reused
        // within the turn), so a window boundary like GLM 14:00–18:00 takes effect without a /reload.
        const selectionPool = decision.cls === "model" || reuseTurnSelection
          ? pool
          : repriceForTimeOfDay(
            forcedRoute ? pool : usablePoolForQuota(ctx, cfg, pool, quota, Date.now(), quotaPlans),
            new Date().getHours(),
          );

        let selection: Selection;
        let cacheReason: CacheReason | undefined = preselectedTurn ? cachedSelection?.cacheReason : undefined;
        if (reuseTurnSelection) {
          const reuseReason = preselectedTurn ? "preselected before compaction" : "reused within user turn";
          selection = { ...cachedSelection!.selection, reason: `${cachedSelection!.selection.reason}; ${reuseReason}` };
        } else {
          const fresh = selectModel(decision, selectionPool, context, options, ctx, cfg);
          // Cache-aware stickiness only applies to auto routing (forced routes are the user's explicit choice).
          if (!forcedRoute && decision.cls !== "model") {
            const result = cacheAwareSelect(fresh, routingState, selectionPool, context, cfg);
            selection = result.selection;
            cacheReason = result.cacheReason;
          } else {
            selection = fresh;
          }
        }
        const target = selection.selected.model;

        turnSelection = { key: turnKey, decision, selection, cacheReason };

        const selectedAuth = quotaPlans.get(modelKey(target))?.auth;
        const auth = selectedAuth ?? await ctx.modelRegistry.getApiKeyAndHeaders(target);
        if (!auth.ok) throw new Error(auth.error);
        const planKey = quotaPlans.get(modelKey(target))?.planKey ?? modelPlanKey(target, auth);

        syncRouterContextWindow(target.contextWindow);

        const requestedReasoning = routingReasoning(
          selection.benchmarkEffort,
          options?.reasoning,
          decision.cls === "model",
        );
        const clampedReasoning = target.reasoning ? clampThinkingLevel(target, requestedReasoning) : "off";
        const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
        const maxTokens = Math.min(options?.maxTokens ?? target.maxTokens, target.maxTokens);

        lastDecision = {
          ...decision,
          chosen: modelKey(target),
          planKey,
          canonical: selection.selected.canonicalKey,
          capabilityMode: selection.selected.capabilityMode,
          profile: selection.profile,
          benchmarkEffort: selection.benchmarkEffort,
          reasoning: clampedReasoning,
          confidence: selection.selected.confidence,
          reason: selection.reason,
          alternatives: selection.alternatives,
          cacheReason,
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
          if (event.type === "done" && cfg.cacheAware.enabled) {
            // Re-establish the warm lease from realized usage so the next turn can weigh staying vs switching.
            recordRoutingUsage(routingState, selection.selected, event.message.usage, context);
          }
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

  async function preselectTurn(ctx: ExtensionContext, context: Context): Promise<void> {
    if (pool.all.length === 0) return;

    const quotaPlans = cfg.quota.enabled && !forcedRoute ? await resolveQuotaPlans(ctx, pool) : new Map();
    const currentClassifier = await classifyCurrentTurnWhenEnabled(ctx, context);
    const decision = decide(context, undefined, forcedRoute, cfg, currentClassifier ? { classify: () => currentClassifier } : undefined);
    const selectionPool = decision.cls === "model"
      ? pool
      : repriceForTimeOfDay(
        forcedRoute ? pool : usablePoolForQuota(ctx, cfg, pool, quota, Date.now(), quotaPlans),
        new Date().getHours(),
      );
    const fresh = selectModel(decision, selectionPool, context, undefined, ctx, cfg);
    let selection = fresh;
    let cacheReason: CacheReason | undefined;
    if (!forcedRoute && decision.cls !== "model") {
      const result = cacheAwareSelect(fresh, routingState, selectionPool, context, cfg);
      selection = result.selection;
      cacheReason = result.cacheReason;
    }

    turnSelection = { key: routingTurnKey(context), decision, selection, cacheReason, pending: true };
    syncRouterContextWindow(selection.selected.model.contextWindow);
  }

  function inputRoutingContext(
    ctx: ExtensionContext,
    text: string,
    images: ImageContent[] | undefined,
  ): Context {
    const session = buildSessionContext(ctx.sessionManager.getBranch());
    return {
      systemPrompt: ctx.getSystemPrompt(),
      messages: [
        ...convertToLlm(session.messages),
        {
          role: "user",
          content: [{ type: "text", text }, ...(images ?? [])],
          timestamp: Date.now(),
        },
      ],
    };
  }

  function mostRecentConcreteModel(ctx: ExtensionContext): Model<Api> | undefined {
    const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== "assistant" || message.provider === "pi-router") continue;
      const model = ctx.modelRegistry.find(message.provider, message.model);
      if (model) return model;
    }
    return undefined;
  }

  function syncRouterContextWindow(contextWindow: number): void {
    if (routerContextWindow === contextWindow) return;
    routerContextWindow = contextWindow;
    pi.registerProvider("pi-router", {
      name: "Pi Router",
      api: "pi-router-api",
      baseUrl: "https://router.local",
      apiKey: "pi-router-dummy-key",
      models: [
        {
          id: "auto",
          name: "Pi Router (Auto)",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens: 64_000,
        },
      ],
      streamSimple,
    });
  }

  async function classifyCurrentTurnWhenEnabled(
    ctx: ExtensionContext,
    context: Context,
  ): Promise<ClassificationResult | undefined> {
    if (forcedRoute || !cfg.classifier.enabled) return undefined;
    return classifyCurrentTurn(ctx, context);
  }

  async function classifyCurrentTurn(ctx: ExtensionContext, context: Context): Promise<ClassificationResult | undefined> {
    const turn = userTurnIndex(context);
    const candidate = selectClassifierModel(repriceForTimeOfDay(pool, new Date().getHours()), cfg, classifierState, turn);
    if (!candidate) return undefined;

    const key = modelKey(candidate.model);
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate.model);
      if (!auth.ok) {
        recordClassifierFailure(classifierState, key, turn, cfg);
        return undefined;
      }

      const message = await completeSimple(candidate.model, classifierContext(context), {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        reasoning: candidate.model.reasoning ? "minimal" : undefined,
        maxTokens: 80,
        temperature: 0,
        timeoutMs: cfg.classifier.timeoutMs,
        maxRetries: 0,
      });
      const parsed = parseClassificationOutput(assistantText(message));
      if (!parsed) {
        recordClassifierFailure(classifierState, key, turn, cfg);
        return undefined;
      }

      recordClassifierSuccess(classifierState, key);
      return parsed;
    } catch {
      recordClassifierFailure(classifierState, key, turn, cfg);
      return undefined;
    }
  }
}

function classifierContext(context: Context): Context {
  return {
    systemPrompt: [
      "You are Pi Router's classifier. Classify the current user turn for model routing.",
      "Return exactly one line and no prose: mode=<low|medium|high|ultra> profile=<balanced|coder|deep|fast|vision>.",
      "Mode is required capability, not cost. Cost is handled later by the router.",
      "Mode rubric:",
      "- low: trivial, explain, summarize, docs/copy edits, tiny localized change, low ambiguity.",
      "- medium: routine coding/debugging/refactor, small scoped implementation, ordinary tests, a few files.",
      "- high: multi-file work, failing tests, unknown root cause, API/design decisions, non-trivial tool use, sizeable context.",
      "- ultra: architecture/security/migrations, production-risk changes, large refactor, long-horizon investigation, high ambiguity or high cost of failure.",
      "Profile rubric:",
      "- vision if hasImage=true.",
      "- fast only when the user explicitly prioritizes speed/latency or the task is a simple transform.",
      "- coder for implementation, debugging, refactoring, tests, or code review.",
      "- deep for architecture, root-cause analysis, security, planning, or long-horizon reasoning.",
      "- balanced otherwise.",
      "If uncertain between adjacent modes, choose the lower mode unless the task is risky, irreversible, security-sensitive, or explicitly asks for deep investigation.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: [
        `estimatedContextTokens=${estimateContextTokens(context)}`,
        `hasImage=${contextHasImageForClassifier(context)}`,
        "lastUserMessage:",
        lastUserText(context),
      ].join("\n"),
      timestamp: Date.now(),
    }],
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function contextHasImageForClassifier(context: Context): boolean {
  return context.messages.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
  );
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
    return { selected, profile: selected.profiles[0] ?? "balanced", benchmarkEffort: selected.benchmarkEffort, reason: "forced model", alternatives: [] };
  }

  const selection = selectFromPool(decision, pool, context, options, cfg);
  if (!selection) throw new Error("Pi Router: model pool is empty");
  return selection;
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
  const match = text.match(/^@(low|medium|high|ultra|model:([^\s]+))\s+([\s\S]*)$/i);
  if (!match) return undefined;
  const mode = parseCapabilityMode(match[1]);
  if (mode) return { route: { mode }, text: match[3] };
  return { route: { model: match[2] }, text: match[3] };
}

function isInitialUserTurn(ctx: ExtensionContext): boolean {
  return buildSessionContext(ctx.sessionManager.getBranch()).messages.every((message) => message.role !== "user");
}

function loadConfig(ctx: ExtensionContext): RouterConfig {
  let cfg = DEFAULT_CONFIG;
  let classifierExplicitlyDisabled = false;
  for (const file of configPaths(ctx)) {
    if (!existsSync(file)) continue;

    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const router = parsed.router ?? parsed;
      const rawClassifier = router.classifier;
      if (rawClassifier === "off" || rawClassifier === false ||
          (rawClassifier && typeof rawClassifier === "object" && rawClassifier.enabled === false)) {
        classifierExplicitlyDisabled = true;
      } else if (rawClassifier && typeof rawClassifier === "object" && rawClassifier.enabled === true) {
        classifierExplicitlyDisabled = false;
      }
      const classifierModel = typeof router.classifierModel === "string" ? router.classifierModel : cfg.classifierModel;
      const mergedClassifier = mergeClassifierConfig(rawClassifier, cfg.classifier);
      cfg = {
        ...cfg,
        ...router,
        weights: { ...cfg.weights, ...(router.weights ?? {}) },
        modeModels: { ...cfg.modeModels, ...(router.modeModels ?? router.models ?? {}) },
        modelFilter: { ...cfg.modelFilter, ...(router.modelFilter ?? {}) },
        modelOverrides: { ...cfg.modelOverrides, ...(router.modelOverrides ?? router.overrides ?? {}) },
        selectionPolicy: router.selectionPolicy === "cost" || router.selectionPolicy === "quality"
          ? router.selectionPolicy
          : cfg.selectionPolicy,
        cacheAware: { ...cfg.cacheAware, ...(router.cacheAware ?? {}) },
        quota: { ...cfg.quota, ...(router.quota ?? {}) },
        classifierModel,
        classifier: classifierExplicitlyDisabled
          ? { ...mergedClassifier, enabled: false }
          : enableClassifierForPinnedModel(mergedClassifier, classifierModel, rawClassifier),
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
    `capabilitySource: ${cfg.capabilitySource}`,
    `selectionPolicy: ${cfg.selectionPolicy}`,
    `sessionPolicy: ${cfg.cacheAware.enabled ? "sticky" : "adaptive"}`,
    `modelFilter: include=[${cfg.modelFilter.include.join(", ") || "*"}] exclude=[${cfg.modelFilter.exclude.join(", ") || "none"}]`,
    `quota: ${cfg.quota.enabled ? "enabled" : "disabled"}`,
    "models by capability mode:",
    ...(["low", "medium", "high", "ultra"] as const).map((mode) => {
      const models = pool.all
        .filter((item) => item.capabilityMode === mode)
        .map((item) => `${displayVariantName(item)}(${item.intelligence.toFixed(1)}@$${item.priceBlended})`)
        .join(", ");
      return `  ${mode}: ${models || "none"}`;
    }),
  ];

  if (lastDecision) {
    lines.push(
      "last:",
      `  chosen: ${lastDecision.chosen}`,
      `  planKey: ${lastDecision.planKey}`,
      `  canonical: ${lastDecision.canonical ?? "unknown"}`,
      `  capabilityMode: ${lastDecision.capabilityMode ?? "unknown"}`,
      `  profile: ${lastDecision.profile ?? "unknown"}`,
      `  benchmarkEffort: ${lastDecision.benchmarkEffort ?? "unknown"}`,
      `  reasoning: ${lastDecision.reasoning ?? "off"}`,
      `  confidence: ${lastDecision.confidence}`,
      `  cacheReason: ${lastDecision.cacheReason ?? "n/a"}`,
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

function displayVariantName(item: ResolvedModel): string {
  if (!item.canonicalKey) return variantKey(item);
  return item.benchmarkEffort ? `${item.canonicalKey}@${item.benchmarkEffort}` : item.canonicalKey;
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
  const effort = decision.reasoning && decision.reasoning !== "off" ? `@${decision.reasoning}` : "";
  const mode = decision.capabilityMode
    ? decision.capabilityMode[0].toUpperCase() + decision.capabilityMode.slice(1)
    : "Unknown";
  return `🧭 ${model}${effort} · ${mode}${quotaStatusTag(quota.snapshot(decision.planKey), Date.now())}`;
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
