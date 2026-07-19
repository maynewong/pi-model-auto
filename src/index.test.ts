/**
 * Exercise the extension boundary where the router's virtual model mirrors the concrete model that
 * will serve the turn. This catches regressions that pure routing tests cannot observe in Pi's UI.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import modelRouter from "./index.ts";

type Handler = (...args: any[]) => unknown;

const temporaryDirs: string[] = [];

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function model(provider: string, id: string, contextWindow: number): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 16_384,
  };
}

function createHarness(target: Model<Api>, branch: unknown[] = []) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-model-auto-agent-"));
  temporaryDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const providers: ProviderConfig[] = [];
  const handlers = new Map<string, Handler>();
  const pi = {
    registerProvider: (_name: string, config: ProviderConfig) => providers.push(config),
    registerCommand: vi.fn(),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;

  modelRouter(pi);
  const initialProvider = providers[0];
  const routerDefinition = initialProvider.models![0];
  const routerModel: Model<Api> = {
    ...routerDefinition,
    provider: "pi-router",
    api: initialProvider.api as Api,
    baseUrl: initialProvider.baseUrl!,
  };
  const registry = {
    getAvailable: () => [target],
    find: (provider: string, id: string) => provider === target.provider && id === target.id ? target : undefined,
    hasConfiguredAuth: () => true,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
  };
  const ctx = {
    cwd: agentDir,
    model: routerModel,
    modelRegistry: registry,
    sessionManager: { getBranch: () => branch },
    getSystemPrompt: () => "",
    isProjectTrusted: () => false,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionContext;

  return { providers, handlers, initialProvider, routerModel, ctx };
}

describe("router context window", () => {
  it("restores the window of the most recent concrete model when a session starts", async () => {
    const target = model("magi-codex", "gpt-5.6-sol", 272_000);
    const branch = [{
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        api: target.api,
        provider: target.provider,
        model: target.id,
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    }];
    const { providers, handlers, ctx } = createHarness(target, branch);

    await handlers.get("session_start")!({}, ctx);

    expect(providers.at(-1)?.models?.[0].contextWindow).toBe(272_000);
  });

  it("selects the automatic route window before Pi performs its preflight compaction check", async () => {
    const target = model("magi-codex", "gpt-5.6-sol", 272_000);
    const { providers, handlers, ctx } = createHarness(target);

    await handlers.get("session_start")!({}, ctx);
    const inputResult = await handlers.get("input")!({ source: "interactive", text: "test" }, ctx);

    expect(inputResult).toEqual({ action: "continue" });
    expect(providers.at(-1)?.models?.[0].contextWindow).toBe(272_000);
  });

  it("updates the auto model to the concrete model window selected for the turn", async () => {
    const target = model("magi-codex", "gpt-5.6-sol", 272_000);
    const { providers, handlers, initialProvider, routerModel, ctx } = createHarness(target);

    await handlers.get("session_start")!({}, ctx);
    const inputResult = await handlers.get("input")!(
      { source: "interactive", text: "@model:magi-codex/gpt-5.6-sol test" },
      ctx,
    );
    expect(inputResult).toEqual({ action: "transform", text: "test", images: undefined });
    expect(providers.at(-1)?.models?.[0].contextWindow).toBe(272_000);

    const context: Context = {
      messages: [{ role: "user", content: "test", timestamp: Date.now() }],
    };
    for await (const _event of initialProvider.streamSimple!(routerModel, context)) {
      // Consume the stream so the router's asynchronous selection finishes.
    }

    expect(providers.at(-1)?.models?.[0].contextWindow).toBe(272_000);
  });
});
