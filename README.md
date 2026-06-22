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
    "models": {
      "cheap": "gateway/deepseek-v4-flash",
      "strong": "gateway/gpt-5.4"
    },
    "forceStrongOnHighReasoning": false,
    "log": false
  }
}
```

`models` is optional. Use it when catalog prices do not match your actual quality/cost preferences.

When `log` is true, routing decisions are appended to `.pi/router.log`.

## Debug

Use the command below inside Pi to inspect cheap / standard / strong / unknown pools plus the last routing decision, including canonical key, cost tier, profile, confidence, reason, and alternatives:

```text
/router
```

## Package layout

```text
pi-model-router/
├── package.json      # Pi package manifest
├── src/index.ts      # Extension entry
├── src/router-core.ts
├── src/canonical-models.ts
├── tsconfig.json
└── README.md
```
