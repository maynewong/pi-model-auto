# pi-model-router

`pi-model-router` adds one Pi model: **Pi Router (Auto)**.

Choose it once with `/model`. After that, Pi keeps using the router, and the router chooses one of your authenticated models for each turn.

## Start

Install from npm:

```bash
pi install npm:pi-model-auto
```

Or install from git (pin a release with `@vX.Y.Z`, or omit it to track the default branch):

```bash
pi install git:github.com/maynewong/pi-model-router@v0.1.0
```

Update later with `pi update --extensions`.

To try it once without installing, point `-e` at a local checkout:

```bash
pi -e /path/to/pi-model-router
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
    "modelFilter": { "include": ["openai", "anthropic", "google"], "exclude": [] },
    "modelOverrides": {
      "anthropic/claude-3-5-sonnet-20241022": { "costCoef": 0.05 },
      "openai/gpt-4o-mini": { "costCoef": 1.0 },
      "google/gemini-1.5-flash": {
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
"google/gemini-1.5-flash": {
  "costCoef": 0.4,
  "costCoefHours": [{ "hours": [14, 18], "factor": 3 }]
}
```

This means `0.4` normally, `1.2` from 14:00 through 17:59. Windows are half-open `[start, end)`. `[22, 2]` wraps across midnight.

## How It Chooses

The router compares quality against your effective cost.

Quality comes from one benchmark table. Cost starts from the same table, then applies your `costCoef` and any active time window. The router keeps to the efficient frontier: a model is only worth considering if no other available model is both better and cheaper.

`capabilitySource` chooses the benchmark:

- `"ramp"` (default): this package's Ramp SWE-Bench table, using coding-agent resolve rate and measured cost per task. It is a narrow coding-agent slice, not a general model score. The task family follows [SWE-bench](https://arxiv.org/abs/2310.06770).
- `"aa"`: [Artificial Analysis](https://artificialanalysis.ai/models) model data, using its Intelligence Index and blended price metrics.

The numeric tables live in [`src/canonical-models.ts`](src/canonical-models.ts). The two sources are not mixed.

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
| `forceStrongOnHighReasoning` | Send `high` or `xhigh` reasoning to the top of the frontier. |
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

## Develop

```bash
npm run typecheck
npm test
```

## Release

This package ships from one source tree to two channels: npm (`npm:pi-model-auto`)
and git (`git:github.com/maynewong/pi-model-router`). One version bump feeds both.

One-shot from a clean `main`:

```bash
npm run release        # version patch -> push commit + tag -> npm publish
```

`release` runs `npm version patch`, which bumps `version`, commits, and creates a
`vX.Y.Z` git tag; `git push --follow-tags` publishes the tag for git installers;
`npm publish` ships to npm. `prepublishOnly` runs `typecheck` and the test suite
first, so a failing build blocks the publish.

For a minor or major release, bump by hand and reuse the rest:

```bash
npm version minor      # or: major
git push --follow-tags
npm publish
```

Check what npm will ship before the first publish:

```bash
npm publish --dry-run  # lists the files in the tarball
```

The `files` allowlist in `package.json` limits the tarball to the four runtime
modules plus `README.md` and `LICENSE`; tests and config stay out.

After release, users on either channel update with `pi update --extensions`. npm
installs move by semver; git installs pinned to a tag stay put until the user
installs a newer tag.
