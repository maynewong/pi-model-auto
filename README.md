# pi-model-router

Pi package that registers a virtual provider, `pi-router/auto`, and routes each turn to the best-value authenticated model.

This is intentionally an **independent Pi package**, not part of the Pi core repo.

## Install / try

From this checkout:

```bash
pi install /Volumes/macbook-1m2-2t/code-side/pi-model-router
# or try once:
pi -e /Volumes/macbook-1m2-2t/code-side/pi-model-router
```

Then select **Pi Router (Auto)** with `/model`.

## What it does

- Builds a zero-config model pool from `ctx.modelRegistry.getAvailable()`.
- Normalizes provider SKUs to canonical model names such as `gpt-5.5`, `glm-5.2`, and `deepseek-v4-flash`.
- Uses canonical metadata, not alphabetical order or missing provider prices, to build cheap / standard / strong / unknown pools.
- Selects within the strong pool by request profile: `deep`, `fast`, `coder`, `balanced`, `vision`, or `frontier`.
- Lets you pin `cheap` / `strong` explicitly for dogfooding custom model pools.
- Falls back to transparent single-model routing if only one model is authenticated.
- Applies hard constraints for:
  - image input,
  - context window,
  - optionally high/xhigh reasoning,
  - target model `maxTokens`.
- Shows the selected target model persistently in the Pi status bar.
- Delegates to `@earendil-works/pi-ai` so usage and cost are reported by the real target provider.

## Escape hatches

Prefix a prompt with:

```text
@cheap update the README
@strong debug this race condition
@model:anthropic/claude-sonnet-4-5 do this with Sonnet
```

The control prefix is stripped before the target model sees the message.

## Config

Optional config files:

- `~/.pi/agent/model-router.json`
- `.pi/model-router.json` in trusted projects

No config is required for covered canonical models.

```jsonc
{
  "router": {
    "threshold": 0.45,
    "weights": {
      "contextTokens": 0.25,
      "lastUserLen": 0.15,
      "keyword": 0.35,
      "reasoning": 0.15,
      "toolDensity": 0.10
    },
    "modelFilter": {
      "include": ["magi"],
      "exclude": []
    },
    "models": {
      "cheap": "magi/deepseek-v4-flash",
      "strong": "magi/gpt-5.4"
    },
    "modelOverrides": {
      "local/Qwen3.6-35B-A3B-UD-MLX-4bit": {
        "canonical": "qwen3.6-35b-a3b-ud-mlx-4bit",
        "costTier": "cheap",
        "profiles": ["fast", "coder"],
        "frontier": false
      }
    },
    "forceStrongOnHighReasoning": false,
    "quota": {
      "enabled": true,
      "reserveRatio": 0.05,
      "inTurnRetry": false,
      "maxRetries": 2,
      "defaultCooldownMs": 300000
    },
    "log": false
  }
}
```

`modelFilter` is optional. Use `include` / `exclude` substring filters to restrict the automatically built pool by provider, model id, display name, or canonical key. Empty `include` means allow all; `exclude` wins over `include`.

`models` is optional. Use it when catalog prices do not match your actual quality/cost preferences.

`modelOverrides` is optional. Use it to classify unknown/private/local models. Keys may be `provider/model-id`, model id, or normalized model id. Supported fields:

- `canonical`: display key used by `/router`
- `costTier`: `cheap`, `standard`, `premium`, or `unknown`
- `profiles`: any of `deep`, `fast`, `coder`, `balanced`, `vision`, `frontier`
- `frontier`: whether the model should enter the strong pool as a frontier candidate

When `log` is true, routing decisions are appended to `.pi/router.log`.

## Quota-aware routing

Quota-aware routing is enabled by default. The router records rate-limit signals from response headers and `429` responses, then skips cooling plan identities on later automatic turns until the reset window has passed. A plan identity is `provider + baseUrl + hashed auth identity`, so API-paid and subscription-backed models under the same provider do not cool each other down when their credentials or upstream URL differ. Cooldown state is persisted in `~/.pi/agent/quota-state.json`, so a five-hour provider window survives Pi restarts.

Forced routes such as `@model:provider/id`, `@cheap`, and `@strong` bypass quota filtering because the user explicitly requested that route. If the forced provider is rate-limited, the provider error is allowed to surface.

Known MVP limits:

- OAuth/subscription providers may not expose remaining quota headers, so they cool down only after a real `429`.
- Soft cooldown depends on provider header units being comparable within the same provider.
- The router does not estimate or accumulate token spend on its own.

## Debug

Use the command below inside Pi to inspect cheap / standard / strong / unknown pools, quota plan state, and the last routing decision, including canonical key, cost tier, profile, confidence, reason, and alternatives:

```text
/router
```

## Package layout

```text
pi-model-router/
├── package.json      # Pi package manifest
├── src/index.ts      # Extension entry
├── src/router-core.ts
├── src/quota.ts
├── src/canonical-models.ts
├── tsconfig.json
└── README.md
```
