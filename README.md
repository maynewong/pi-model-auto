# pi-model-auto

`pi-model-auto` adds one Pi model: **Pi Router (Auto)**.

Choose it once with `/model`, then use Pi normally. The router:

1. Classifies work as `Low`, `Medium`, `High`, or `Ultra`.
2. Selects a model in that capability mode.
3. Keeps the selected model warm until a higher mode or a hard constraint requires a switch.

No configuration is required.

## Install

From npm:

```bash
pi install npm:pi-model-auto
```

From git:

```bash
pi install git:github.com/maynewong/pi-model-auto
```

Append a release tag such as `@vX.Y.Z` if you want to pin a version. Update installed extensions with `pi update --extensions`.

For a local checkout:

```bash
pi -e /path/to/pi-model-auto
```

Then run `/model` and choose **Pi Router (Auto)**. If no authenticated models are available, run `/login` and reload Pi.

## The Mental Model

### 1. Capability mode

```text
Low → Medium → High → Ultra
```

The mode says how capable the model must be. It does not describe price.

### 2. Selection policy

Within the required mode:

- `quality` (default): select the strongest model for the task profile.
- `cost`: select the model with the lowest effective price.

### 3. Sticky session

The selected model stays warm across turns:

- Same or lower required mode: keep the current model.
- Higher required mode: switch directly to the selected model in that mode.
- Never automatically downgrade.
- Image support, context limits, quota cooldown, authentication, or model availability may force a fallback.

This avoids cache-invalidating horizontal switches on every turn.

## Why This Design

The router originally mixed several ideas: capability tiers, price buckets, Pareto-frontier ranking, upgrade budgets, and cache break-even calculations. Each idea was reasonable alone, but together they made routing difficult to predict and configure.

The current design intentionally separates three decisions:

- **Capability mode answers “how strong must the model be?”** It is based on benchmark capability, not price.
- **Selection policy answers “which model should represent that mode?”** Quality-first and cost-first users can make different choices without changing model capability labels.
- **Session stickiness answers “should we lose the warm prompt cache?”** Same-mode improvements are usually not worth re-sending the full conversation, while a required capability upgrade is.

This produces a simpler contract: choose a starting model, keep it for ordinary work, and make only necessary one-way upgrades. It favors predictable session behavior over theoretically optimal per-turn model selection.

### Trade-offs

- **A session may remain on a more capable or expensive model than the latest turn needs.** The router does not automatically downgrade because preserving the prompt cache is usually more valuable than a cheaper isolated turn. Start a new conversation when you want a clean lower-mode session.
- **Quality-first can be expensive.** `selectionPolicy: "quality"` is the default because capability is the safest general default. Use `"cost"` when price matters more within each mode.
- **Four modes are deliberately coarse.** Fixed bands are easier to understand, but nearby models and tasks may be more similar than their labels suggest.
- **Benchmarks are imperfect.** Ramp is coding-oriented, while Artificial Analysis is broader but synthetic. The router keeps the sources separate instead of pretending they share one scale.
- **The local heuristic cannot understand every short request.** A short security or architecture request can look easy from length and context alone. The optional classifier improves semantic routing at the cost of one additional bounded model call per user turn.
- **Fallbacks can change cost or quality.** If the target mode has no eligible model, borrowing a stronger mode may cost more; falling back lower may reduce capability.
- **Exact pins trade automation for control.** `modeModels` and `@model:` are predictable, but the user becomes responsible for choosing a suitable endpoint.

Removing price buckets and Pareto climbing is therefore intentional: continuous effective price still exists, but it is used only by the explicit selection policy rather than becoming a second capability system.

## Use

Inspect the current router state with:

```text
/auto
```

Automatic routing should handle most conversations. On the **first user turn** of a new conversation, you may pin the initial mode or model:

```text
@low summarize this file
@medium implement this small change
@high debug this failing test
@ultra review this architecture
@model:anthropic/claude-opus-5 use this exact model
```

The prefix is removed before the model receives the prompt. Later-turn prefixes are ignored because they would carry the existing session context into the new model and lose its prompt cache.

## Configuration

Configuration is optional. Files are loaded in this order:

1. `~/.pi/agent/model-router.json`
2. `.pi/model-router.json` in a trusted project

Project values override user values.

### Prefer lower cost

```jsonc
{
  "router": {
    "selectionPolicy": "cost"
  }
}
```

The default is `"quality"`.

### Limit providers or models

```jsonc
{
  "router": {
    "modelFilter": {
      "include": ["anthropic", "z-ai"],
      "exclude": ["preview"]
    }
  }
}
```

Filters match provider, model id, display name, and canonical model name by substring.

### Pin a mode to an exact endpoint

```jsonc
{
  "router": {
    "modeModels": {
      "low": "gateway/gpt-5.4-nano",
      "ultra": "anthropic/claude-opus-5"
    }
  }
}
```

A mode pin wins before `selectionPolicy`. If the endpoint is unavailable or ineligible for the request, normal mode fallback is used.

### Adjust effective cost

Use `costCoef` when your real economics differ from benchmark list price:

```jsonc
{
  "router": {
    "selectionPolicy": "cost",
    "modelOverrides": {
      "anthropic/claude-opus-5": {
        "costCoef": 0.2
      },
      "z-ai/glm-5.3": {
        "costCoef": 0.4,
        "costCoefHours": [
          { "hours": [14, 18], "factor": 3 }
        ]
      }
    }
  }
}
```

- `costCoef < 1`: cheaper for you, for example through a subscription or discount.
- `costCoef = 1`: benchmark price.
- `costCoef > 1`: more expensive for you.
- Hour windows are local, half-open ranges: `[14, 18]` means 14:00–17:59. `[22, 2]` wraps across midnight.

Cost overrides never change capability mode. They primarily affect `selectionPolicy: "cost"`.

### Opt in to semantic classification

The default classifier is a free, local heuristic based on prompt length, context size, and recent tool activity. To classify the meaning and risk of short requests more accurately, pin an optional classifier model:

```jsonc
{
  "router": {
    "classifierModel": "gateway/gpt-5.4-nano"
  }
}
```

When enabled, the classifier:

- Runs once per new automatic user turn.
- Receives the latest user message plus local context metadata, not the full conversation.
- Does not run for first-turn manual pins or tool-call continuations.
- Falls back to the local heuristic on timeout, malformed output, or repeated failure.

Explicitly disable it with:

```jsonc
{
  "router": {
    "classifier": "off"
  }
}
```

## Capability Data

`capabilitySource` selects one benchmark source. Sources are never mixed.

### Ramp, default

Ramp modes use SWE-Bench resolve rate:

| Mode | Resolve rate |
| --- | ---: |
| `Low` | `< 75%` |
| `Medium` | `75–<80%` |
| `High` | `80–<85%` |
| `Ultra` | `>= 85%` |

### Artificial Analysis v4.2

Set `"capabilitySource": "aa"` to use Artificial Analysis. Mode assignment uses only the general Intelligence Index:

| Mode | Intelligence Index |
| --- | ---: |
| `Low` | `< 40` |
| `Medium` | `40–<47` |
| `High` | `47–<52` |
| `Ultra` | `>= 52` |

Coding, Agentic, and throughput metrics rank candidates within a mode; they do not promote a model into another mode. Missing profile sub-indices fall back to the general Intelligence Index.

The bundled numeric data is in [`src/canonical-models.ts`](src/canonical-models.ts). Ramp remains the default source.

## Mode Fallback

For a requested mode, the router:

1. Uses the exact configured mode pin when eligible.
2. Otherwise selects within that mode using `selectionPolicy`.
3. If the mode has no eligible model, tries the nearest stronger mode.
4. If no stronger mode exists, uses the strongest available lower mode.

Task profiles affect ranking within the chosen mode:

- `balanced`: general capability
- `coder`: coding capability
- `deep`: agentic capability
- `fast`: throughput
- `vision`: image eligibility plus general capability

## Settings Reference

| Setting | Purpose | Default |
| --- | --- | --- |
| `selectionPolicy` | `quality` or `cost` within a mode | `quality` |
| `capabilitySource` | `ramp` or `aa` | `ramp` |
| `modelFilter` | Include or exclude providers/models | all authenticated models |
| `modeModels` | Pin exact endpoints for capability modes | none |
| `modelOverrides` | Adjust cost or metadata for known/private models | none |
| `cacheAware.enabled` | Keep the session model sticky | `true` |
| `classifierModel` | Opt in to semantic classification | none |
| `classifier` | Tune or disable the optional classifier | off unless pinned |
| `quota.enabled` | Avoid quota-cooled plans | `true` |
| `weights` | Tune the local heuristic | built-in weights |
| `log` | Append decisions to `.pi/router.log` | `false` |

Advanced `modelOverrides` fields include `capabilityMode`, `profiles`, `benchmarkEffort`, `priceBlended`, `intelligence`, `scores`, and `tps`. Most users should only need `costCoef`.

Legacy `costTier` and `frontier` override fields are no longer supported. Core API consumers should use `Pool.all`; the old cost-bucket pool fields and Pareto helper exports have been removed.

Quota state is stored at `~/.pi/agent/quota-state.json`.

## Context Window

The virtual `pi-router/auto` model mirrors the selected concrete model's context window. The router preselects before Pi's compaction check and restores the most recent concrete model's window when a session resumes.

## Core API

Other Pi extensions can resolve a model without an `ExtensionContext`:

```ts
import { resolveRouteModel } from "pi-model-auto/core";

const selection = resolveRouteModel({
  models: availableModels,
  hint: "high", // low | medium | high | ultra | auto | provider/model
  context,
});
```

The core API loads user-level configuration and quota state by default. It does not read project config because project configuration requires a host trust decision. Pass `cfg` explicitly when needed, or set `filterQuota: false` to ignore persisted cooldowns.

## Develop

```bash
npm run build
npm run typecheck
npm test
```

Maintainers: see [RELEASING.md](RELEASING.md).
