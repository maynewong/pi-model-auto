# Changelog

## Unreleased

## 0.3.0 - 2026-09-07

### Breaking changes

- Replaced the mixed cost-tier/Pareto routing model with one mode-first contract: classify the task as `low`, `medium`, `high`, or `ultra`, then select within that mode using `selectionPolicy`.
- Added `selectionPolicy: "quality" | "cost"`. The default is `quality`, which chooses the strongest model for the task profile; cost-sensitive users can opt into `cost`.
- Made automatic routing session-sticky. The router keeps the warm model for same-mode or lower-mode work, never automatically downgrades, and switches directly only when a higher capability mode is required or the current model becomes ineligible.
- Removed the legacy `costTier` and `frontier` model/config fields, the `cheapPool`, `standardPool`, `strongPool`, and `unknownPool` fields, and the exported Pareto helper functions. Core API consumers should now use `Pool.all`.
- Legacy overrides containing only `costTier` or `frontier` no longer make an unknown model routable. Use `capabilityMode`, continuous price metadata, and task profiles instead.

### Changed

- Refreshed the bundled Artificial Analysis dataset from Data API v4.2 and updated intelligence, Coding Index, Agentic Index, blended price, throughput, aliases, and recent model coverage.
- Updated AA v4.2 capability boundaries to `Ultra >= 52`, `High >= 47`, `Medium >= 40`, and `Low < 40`. General Intelligence Index assigns the mode; Coding, Agentic, and throughput metrics only rank candidates within it.
- Missing AA Coding or Agentic sub-indices now fall back to the general Intelligence Index instead of receiving synthetic capability bonuses.
- Made `modeModels` exact endpoint pins that take precedence over quality/cost policy while still respecting model filters, image support, context limits, quota state, and availability.
- Improved sticky-session safety so a warm text-only or undersized-context model cannot override a newly required image/context-compatible route.
- The optional semantic classifier now runs once for each new automatic user turn, reuses preselection for the provider request, and remains disabled for forced first-turn routes and tool-call continuations.
- Simplified `/auto`, package metadata, source comments, and README configuration around capability mode, selection policy, and sticky session behavior.

### Trade-offs

- A session may remain on a stronger or more expensive model after hard work because preserving its prompt cache is preferred over automatic downgrade.
- `quality` is safer as a default but can cost more; users who prioritize spend should explicitly select `cost`.
- Four capability modes are intentionally coarse, and benchmark scores remain imperfect proxies for real tasks.
- Semantic classification improves short or ambiguous requests but adds one bounded classifier call per automatic user turn when enabled.

## 0.2.1 - 2026-07-30

### Changed

- Added the Ramp SWE-Bench result for Kimi K3 at high effort: 86.1% resolve rate, $1.63 average cost per task, and 91 average tool-call turns. It is routed in the Ultra capability mode.

## 0.2.0 - 2026-07-26

### Breaking changes

- Replaced user-facing `cheap` / `strong` routing hints with capability-mode hints: `low`, `medium`, `high`, and `ultra`.
- `@low`, `@medium`, `@high`, `@ultra`, and `@model:provider/model` are now only honored on the first user turn of a conversation. Mid-conversation prefixes are ignored and the user is warned, avoiding accidental high-cost routing over long existing histories.
- Core API `resolveRouteModel({ hint })` now accepts `low | medium | high | ultra | auto | provider/model`; `cheap` and `strong` no longer resolve.
- Router config now uses `modeModels` for optional `low` / `medium` / `high` / `ultra` endpoint pins instead of cheap/strong tier pins.
- Classifier output now uses the same mode vocabulary directly (`mode=<low|medium|high|ultra>`) instead of the old `trivial` / `normal` / `hard` / `max` labels.
- The LLM classifier is now opt-in: it only runs when `classifierModel` pins an exact model; default routing uses the local heuristic with no extra classifier model call.

### Changed

- Refreshed the bundled Ramp SWE-Bench data against the August 2026 78-task result set, updated all measured resolve-rate, cost, and tool-call values, and added the high-effort DeepSeek V4 Flash result. The full measured table remains available while Ramp's highlighted score-versus-spend wall is tracked separately for routing priority.
- Artificial Analysis (`aa`) routing now maps models onto the same Low / Medium / High / Ultra capability modes using conservative Intelligence Index bands (`Ultra >= 56`, `High >= 52`, `Medium > 41`, `Low <= 41`), so both `ramp` and `aa` share the same user-facing mode vocabulary.
- README now documents representative models for each capability mode and explains fallback behavior when those models are not available locally.
