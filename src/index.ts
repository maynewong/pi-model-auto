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

type Tier = "cheap" | "strong";
type RouteClass = Tier | "model";
type ForcedRoute = { tier: Tier } | { model: string };

interface RouterConfig {
  threshold: number;
  weights: {
    contextTokens: number;
    lastUserLen: number;
    keyword: number;
    reasoning: number;
    toolDensity: number;
  };
  log: boolean;
}

interface ResolvedModel {
  tier: Tier;
  model: Model<Api>;
  acceptsImage: boolean;
  price: number;
}

interface Pool {
  byTier: Record<Tier, ResolvedModel | undefined>;
  all: ResolvedModel[];
}

interface Decision {
  cls: RouteClass;
  score: number;
  chosen: string;
  reason?: string;
}

const DEFAULT_CONFIG: RouterConfig = {
  threshold: 0.45,
  weights: {
    contextTokens: 0.25,
    lastUserLen: 0.15,
    keyword: 0.35,
    reasoning: 0.15,
    toolDensity: 0.1,
  },
  log: false,
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export default function modelRouter(pi: ExtensionAPI) {
  let extCtx: ExtensionContext | undefined;
  let cfg: RouterConfig = DEFAULT_CONFIG;
  let pool: Pool = { byTier: { cheap: undefined, strong: undefined }, all: [] };
  let forcedRoute: ForcedRoute | undefined;
  let lastDecision: Decision | undefined;
  let providerRegistered = false;

  pi.on("session_start", async (_event, ctx) => {
    extCtx = ctx;
    cfg = loadConfig(ctx);
    pool = buildAutoPool(ctx.modelRegistry.getAvailable());

    // Keep the API name unique so multiple Pi sessions cannot overwrite each
    // other's streamSimple closure in the process-global api-registry.
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

    ctx.ui.setStatus(
      "router",
      pool.all.length === 0
        ? "🧭 router: no authenticated models"
        : `🧭 router ready (${pool.all.length} model${pool.all.length === 1 ? "" : "s"})`,
    );
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
        const selected = selectModel(decision, pool, context, options, ctx);
        const target = selected.model;

        // Resolve target auth. Do not forward router's dummy key to the target.
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(target);
        if (!auth.ok) throw new Error(auth.error);

        const requestedReasoning = options?.reasoning ?? "off";
        const clampedReasoning = target.reasoning ? clampThinkingLevel(target, requestedReasoning) : "off";
        const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
        const maxTokens = Math.min(options?.maxTokens ?? target.maxTokens, target.maxTokens);

        lastDecision = {
          ...decision,
          chosen: `${target.provider}/${target.id}`,
          reason: selected.reason ?? decision.reason,
        };

        const suffix = lastDecision.reason ? `; ${lastDecision.reason}` : "";
        ctx.ui.setStatus("router", `🧭 router → ${target.id} (${selected.tier}${suffix})`);
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

function buildAutoPool(models: Model<Api>[]): Pool {
  const candidates = models
    .filter((model) => model.provider !== "pi-router")
    .filter((model) => model.input?.includes("text"))
    .map((model) => ({
      model,
      acceptsImage: model.input?.includes("image") ?? false,
      price: effectivePrice(model),
    }))
    .sort((a, b) => a.price - b.price || modelKey(a.model).localeCompare(modelKey(b.model)));

  if (candidates.length === 0) return { byTier: { cheap: undefined, strong: undefined }, all: [] };

  const cheapBase = candidates[0];
  const strongBase = candidates[candidates.length - 1];
  const all = candidates.map((candidate) => ({
    ...candidate,
    tier: candidate === strongBase ? ("strong" as const) : ("cheap" as const),
  }));

  return {
    byTier: {
      cheap: { ...cheapBase, tier: "cheap" },
      strong: { ...strongBase, tier: "strong" },
    },
    all,
  };
}

function effectivePrice(model: Model<Api>): number {
  const input = model.cost?.input ?? 0;
  const output = model.cost?.output ?? 0;
  const price = input + output * 3;
  return price > 0 ? price : Number.MAX_SAFE_INTEGER / 2;
}

function decide(
  context: Context,
  options: SimpleStreamOptions | undefined,
  forced: ForcedRoute | undefined,
  cfg: RouterConfig,
): Decision {
  if (forced && "model" in forced) return { cls: "model", score: 1, chosen: forced.model, reason: "forced model" };
  if (forced && "tier" in forced) {
    return { cls: forced.tier, score: forced.tier === "strong" ? 1 : 0, chosen: "", reason: "forced" };
  }

  const score = classify(context, options, cfg);
  return { cls: score >= cfg.threshold ? "strong" : "cheap", score, chosen: "" };
}

function classify(context: Context, options: SimpleStreamOptions | undefined, cfg: RouterConfig): number {
  const text = lastUserText(context).toLowerCase();
  const contextTokens = estimateContextTokens(context);
  const reasoning = options?.reasoning && ["medium", "high", "xhigh"].includes(options.reasoning) ? 1 : 0;
  const toolDensity = Math.min(1, countRecentToolResults(context) / 8);

  const raw =
    normalize(contextTokens, 8_000, 120_000) * cfg.weights.contextTokens +
    normalize(text.length, 120, 1_200) * cfg.weights.lastUserLen +
    keywordScore(text) * cfg.weights.keyword +
    reasoning * cfg.weights.reasoning +
    toolDensity * cfg.weights.toolDensity;

  return Math.max(0, Math.min(1, raw));
}

function selectModel(
  decision: Decision,
  pool: Pool,
  context: Context,
  options: SimpleStreamOptions | undefined,
  ctx: ExtensionContext,
): ResolvedModel & { reason?: string } {
  if (decision.cls === "model") {
    const [provider, ...idParts] = decision.chosen.split("/");
    const id = idParts.join("/");
    const model = provider && id ? ctx.modelRegistry.find(provider, id) : undefined;

    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`Pi Router: forced model not available or not authenticated: ${decision.chosen}`);
    }

    return enforceConstraints(
      { tier: "strong", model, acceptsImage: model.input.includes("image"), price: effectivePrice(model) },
      pool,
      context,
      options,
    );
  }

  const target = pool.byTier[decision.cls] ?? pool.byTier[decision.cls === "cheap" ? "strong" : "cheap"];
  if (!target) throw new Error("Pi Router: model pool is empty");

  return enforceConstraints(target, pool, context, options);
}

function enforceConstraints(
  target: ResolvedModel,
  pool: Pool,
  context: Context,
  options: SimpleStreamOptions | undefined,
): ResolvedModel & { reason?: string } {
  let reason: string | undefined;
  let selected = target;
  const needsImage = contextHasImage(context);
  const contextTokens = estimateContextTokens(context);
  const needsReasoning = options?.reasoning === "high" || options?.reasoning === "xhigh";

  if (needsReasoning && selected.tier !== "strong" && pool.byTier.strong) {
    selected = pool.byTier.strong;
    reason = "reasoning→strong";
  }

  if (needsImage && !selected.acceptsImage) {
    const imageModel = preferStrongEnough(pool.all.filter((item) => item.acceptsImage), selected);
    if (!imageModel) throw new Error("Pi Router: no authenticated image-capable model is available");
    selected = imageModel;
    reason = "image input";
  }

  if (selected.model.contextWindow && contextTokens > selected.model.contextWindow * 0.8) {
    const larger = preferStrongEnough(pool.all.filter((item) => contextTokens <= item.model.contextWindow * 0.8), selected);
    if (!larger) throw new Error("Pi Router: no authenticated model has enough context window for this request");
    selected = larger;
    reason = "context window";
  }

  return { ...selected, reason };
}

function preferStrongEnough(candidates: ResolvedModel[], current: ResolvedModel): ResolvedModel | undefined {
  return candidates.sort(
    (a, b) => tierRank(b.tier) - tierRank(a.tier) || Math.abs(a.price - current.price) - Math.abs(b.price - current.price),
  )[0];
}

function tierRank(tier: Tier): number {
  return tier === "strong" ? 1 : 0;
}

function parseForcedRoute(text: string): { route: ForcedRoute; text: string } | undefined {
  const match = text.match(/^@(cheap|strong|model:([^\s]+))\s+([\s\S]*)$/);
  if (!match) return undefined;
  if (match[1] === "cheap" || match[1] === "strong") return { route: { tier: match[1] }, text: match[3] };
  return { route: { model: match[2] }, text: match[3] };
}

function contextHasImage(context: Context): boolean {
  return context.messages.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
  );
}

function lastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function estimateContextTokens(context: Context): number {
  const system = context.systemPrompt?.length ?? 0;
  const chars = context.messages.reduce((sum, message) => {
    if (typeof message.content === "string") return sum + message.content.length;

    return sum + message.content.reduce((inner, part) => {
      if (part.type === "text") return inner + part.text.length;
      if (part.type === "thinking") return inner + part.thinking.length;
      if (part.type === "toolCall") return inner + JSON.stringify(part.arguments).length + part.name.length;
      return inner + 1024;
    }, 0);
  }, system);

  return Math.ceil(chars / 4);
}

function countRecentToolResults(context: Context): number {
  return context.messages.slice(-12).filter((message) => message.role === "toolResult").length;
}

function keywordScore(text: string): number {
  const cheap = /\b(format|lint|typo|rename|docs?|readme|translate|summari[sz]e|grep|search)\b|格式化|排版|错别字|文档|翻译|总结|搜索|查找|简单/.test(text);
  const strong = /\b(architecture|design|debug|root cause|race condition|refactor|multi-file|security|performance|concurrency|plan)\b|架构|设计|根因|并发|性能|安全|重构|复杂|方案|计划/.test(text);
  if (strong) return 1;
  if (cheap) return 0;
  return 0.45;
}

function normalize(value: number, low: number, high: number): number {
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
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

function logDecision(ctx: ExtensionContext, cfg: RouterConfig, decision: Decision | undefined) {
  if (!cfg.log || !decision) return;
  appendJsonLine(ctx, { ts: new Date().toISOString(), ...decision });
}

function logTerminalEvent(
  ctx: ExtensionContext,
  cfg: RouterConfig,
  decision: Decision | undefined,
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

function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}
