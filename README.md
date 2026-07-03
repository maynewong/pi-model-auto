# pi-model-auto

`pi-model-auto` adds one Pi model: **Pi Router (Auto)**.

Choose it once with `/model`. After that, Pi keeps using the router, and the router chooses one of your authenticated models for each turn.

## Start

Install from npm:

```bash
pi install npm:pi-model-auto
```

Or install from git (pin a release with `@vX.Y.Z`, or omit it to track the default branch):

```bash
pi install git:github.com/maynewong/pi-model-auto@v0.1.0
```

Update later with `pi update --extensions`.

To try it once without installing, point `-e` at a local checkout:

```bash
pi -e /path/to/pi-model-auto
```

Then:

1. Run `/model`.
2. Choose **Pi Router (Auto)**.
3. Use Pi normally.

No config is required at first. If the router says no authenticated models are available, run `/login` for the providers you want to use, then reload Pi.

## Use

Check what the router sees:

```text
/auto
```

Force one turn when you know what you want:

```text
@cheap update the README
@strong debug this race condition
@model:anthropic/claude-3-5-sonnet-20241022 use Sonnet here
```

- `@cheap` asks for the cheap end of the current pool.
- `@strong` asks for the strong end.
- `@model:provider/model-id` uses that exact model.

The prefix is removed before the model sees your prompt.

## Configure When Needed

Most people only need config for two reasons:

1. Limit the pool to providers they trust.
2. Tell the router what each model really costs them.

Config lives in either file:

- `~/.pi/agent/model-router.json`
- `.pi/model-router.json` in trusted projects

Project config overrides user config.

```jsonc
{
  "router": {
    "modelFilter": { "include": ["anthropic", "z-ai"], "exclude": [] },
    "modelOverrides": {
      "anthropic/claude-3-5-sonnet-20241022": { "costCoef": 0.05 },
      "z-ai/glm-5.2": {
        "costCoef": 0.4,
        "costCoefHours": [{ "hours": [14, 18], "factor": 3 }]
      }
    }
  }
}
```

Use provider/model ids exactly as they appear in your Pi registry. The names above are public examples.

### `costCoef`

`costCoef` multiplies the benchmark cost:

- `< 1`: cheaper for you than the benchmark, such as a subscription or discount.
- `= 1`: roughly benchmark cost.
- `> 1`: more expensive for you.

Avoid setting a limited subscription near zero unless you want it to win almost every turn.

### `costCoefHours`

Use this when a model is more expensive during local hours:

```jsonc
"z-ai/glm-5.2": {
  "costCoef": 0.4,
  "costCoefHours": [{ "hours": [14, 18], "factor": 3 }]
}
```

This means `0.4` normally, `1.2` from 14:00 through 17:59. Windows are half-open `[start, end)`. `[22, 2]` wraps across midnight.

## How It Chooses

The router compares quality against your effective cost.

Quality comes from one benchmark table. Cost starts from the same table, then applies your `costCoef` and any active time window. The router keeps to the efficient frontier: a model is only worth considering if no other available model is both better and cheaper.

`capabilitySource` chooses the benchmark:

- `"ramp"` (default): this package's [Ramp SWE-Bench](https://labs.ramp.com/swebench#score-vs-spend) table, using coding-agent resolve rate and measured cost per task. It is a narrow coding-agent slice, not a general model score. The task family follows [SWE-bench](https://arxiv.org/abs/2310.06770).
- `"aa"`: [Artificial Analysis](https://artificialanalysis.ai/models) model data, using its Intelligence Index and blended price metrics.

The numeric tables live in [`src/canonical-models.ts`](src/canonical-models.ts). The two sources are not mixed.

Task difficulty is judged from the request itself — context size, prompt length, keywords, and tool activity — never from your thinking level. Your thinking level (`low`/`medium`/`high`/`xhigh`) controls only how deeply the *chosen* model reasons; it does not change which model is chosen. So leaving thinking on `high` out of habit won't silently push every turn to the most expensive model. When you know a task is harder than it looks, say so in the prompt (or pin with `@strong`).

One user turn keeps one model, including tool-call continuations. Automatic routing also avoids quota-cooled plans and avoids switching away from a useful warm cache when the switch is not worth it.

## Settings

| setting | use |
| --- | --- |
| `capabilitySource` | Choose `"ramp"` or `"aa"`. |
| `modelFilter` | Include or exclude providers/models by substring. |
| `models` | Pin the configured `cheap` or `strong` endpoint. |
| `modelOverrides` | Adjust cost or metadata for known/private/local models. |
| `willingness` | Control how far each difficulty climbs toward stronger models. |
| `cacheAware` | Keep warm prompt caches when switching is not worth it. Enabled by default. |
| `quota` | Skip cooled-down plans after rate-limit headers or `429`. Enabled by default. |
| `weights` | Difficulty-scoring weights. Advanced. |
| `log` | Append routing decisions to `.pi/router.log`. |

Useful override fields:

| field | meaning |
| --- | --- |
| `costCoef` | Cost multiplier. |
| `costCoefHours` | Local-hour multipliers. |
| `canonical` | Name shown in `/auto`. |
| `costTier` | `cheap`, `standard`, `premium`, or `unknown`. |
| `profiles` | `deep`, `fast`, `coder`, `balanced`, `vision`, `frontier`. |
| `frontier` | Whether the model can appear in the strong frontier. |
| `priceBlended`, `intelligence`, `scores`, `tps` | Raw metrics for models without benchmark data. |

Quota state is stored at `~/.pi/agent/quota-state.json`. Providers without remaining-quota headers only cool down after a real `429`.

## Core API

Other Pi extensions can resolve a model without an `ExtensionContext`:

```ts
import { resolveRouteModel } from "pi-model-auto/core";

const selection = resolveRouteModel({
  models: availableModels,
  hint: "cheap", // cheap | strong | auto | provider/model
  context,
});
```

The core API loads user-level `model-router.json` and quota state by default. It never reads project config because that requires a trust decision from the host. Pass `cfg` to supply an explicit configuration or `filterQuota: false` to disable persisted cooldown filtering.

## Develop

```bash
npm run build
npm run typecheck
npm test
```

Maintainers: see [RELEASING.md](RELEASING.md) for the publish flow.
