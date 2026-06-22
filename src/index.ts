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
  buildAutoPool,
  decide,
  matchesModelFilter,
  modelKey,
  resolveModel,
  selectFromPool,
  type Decision,
  type Pool,
  type ResolvedModel,
  type RouterConfig,
  type Tier,
} from "./router-core.ts";

type ForcedRoute = { tier: Tier } | { model: string };

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
  canonical: string | null;
  costTier: string;
  profile?: string;
  confidence: string;
  alternatives: string[];
}

export default function modelRouter(pi: ExtensionAPI) {
  let extCtx: ExtensionContext | undefined;
  let cfg: RouterConfig = DEFAULT_CONFIG;
  let pool: Pool = { cheapPool: [], strongPool: [], standardPool: [], unknownPool: [], all: [] };
  let forcedRoute: ForcedRoute | undefined;
  let lastDecision: LastDecision | undefined;
  let providerRegistered = false;

  pi.registerCommand("router", {
    description: "Show Pi Model Router pool and last decision",
    handler: async (_args, ctx) => {
      ctx.ui.notify(describeRouter(pool, cfg, lastDecision), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    extCtx = ctx;
    cfg = loadConfig(ctx);
    pool = applyConfiguredTiers(buildAutoPool(ctx.modelRegistry.getAvailable(), cfg), cfg, ctx);

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
      updateRouterStatus(ctx, lastDecision ? shortStatus(lastDecision) : "🧭 ready");
    } else {
      ctx.ui.setStatus("router", undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    forcedRoute = undefined;
    lastDecision = undefined;
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
        const selection = selectModel(decision, pool, context, options, ctx, cfg);
        const target = selection.selected.model;

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(target);
        if (!auth.ok) throw new Error(auth.error);

        const requestedReasoning = options?.reasoning ?? "off";
        const clampedReasoning = target.reasoning ? clampThinkingLevel(target, requestedReasoning) : "off";
        const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
        const maxTokens = Math.min(options?.maxTokens ?? target.maxTokens, target.maxTokens);

        lastDecision = {
          ...decision,
          chosen: modelKey(target),
          canonical: selection.selected.canonicalKey,
          costTier: selection.selected.costTier,
          profile: selection.profile,
          confidence: selection.selected.confidence,
          reason: selection.reason,
          alternatives: selection.alternatives,
        };

        updateRouterStatus(ctx, shortStatus(lastDecision));
        logDecision(ctx, cfg, lastDecision);

        const inner = aiStreamSimple(target, context, {
          ...options,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          reasoning,
          maxTokens,
        });

        for await (const event of inner) {
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

  const selection = selectFromPool(decision.cls, pool, context, options, cfg);
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

function shortStatus(decision: LastDecision): string {
  return `🧭 ${decision.chosen.split("/").at(-1) ?? decision.chosen} · ${decision.costTier}`;
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

function describeRouter(pool: Pool, cfg: RouterConfig, lastDecision: LastDecision | undefined): string {
  const lines = [
    "Pi Router",
    `forceStrongOnHighReasoning: ${cfg.forceStrongOnHighReasoning}`,
    `modelFilter: include=[${cfg.modelFilter.include.join(", ") || "*"}] exclude=[${cfg.modelFilter.exclude.join(", ") || "none"}]`,
    `cheapPool: ${pool.cheapPool.map((item) => modelKey(item.model)).join(", ") || "none"}`,
    `strongPool: ${pool.strongPool.map((item) => `${modelKey(item.model)}(${item.canonicalKey ?? "unknown"}/${item.costTier}/${item.profiles.join("+")})`).join(", ") || "none"}`,
    `standardPool: ${pool.standardPool.map((item) => modelKey(item.model)).join(", ") || "none"}`,
    `unknownPool: ${pool.unknownPool.map((item) => modelKey(item.model)).join(", ") || "none"}`,
  ];

  if (lastDecision) {
    lines.push(
      "last:",
      `  chosen: ${lastDecision.chosen}`,
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
