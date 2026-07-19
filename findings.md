# Findings & Decisions

## Requirements
- Support an open-source deployment where users have different provider pools.
- Avoid pinning the classifier to a specific model.
- Do not send user prompts to unexpected third-party endpoints.
- Provide a one-switch classifier opt-out.
- Remove language-specific regex dependence from the long-term routing core.
- Preserve deterministic router-core tests via dependency injection.

## Research Findings
- Before Phase 2, `src/router-core.ts` computed hardness in `classify()` from context tokens, last user text length, `keywordScore()`, and recent tool density.
- Before Phase 2, `DEFAULT_CONFIG.weights.keyword` was the largest default weight, so English keyword matching had a large routing effect.
- Before Phase 2, `inferRequestedProfile()` also used English regexes for deep, fast, and coder profile selection.
- `resolveRouteModel()` is synchronous and side-effect free; provider-backed LLM classification cannot fit that API without a separate async path or injected precomputed classification.
- Runtime routing in `src/index.ts` already owns session state, quota filtering, model auth, turn reuse, and cache-aware stickiness. It is the natural place for async classifier refresh.
- `RoutingState` currently stores cache lease and usage-derived signals. It can be extended or paired with classifier state.
- README publicly documents "keywords" as part of task difficulty. That statement must change with the refactor.
- Phase 2 removed the deterministic keyword score. The fallback score now uses context tokens, last user length, and recent tool-result density.
- Phase 2 changed `inferRequestedProfile()` to return `vision` for image requests and `balanced` otherwise. Semantic profiles should come back through the future classifier interface, not regex.
- On the AA balanced fallback axis, `deepseek-v4-flash` is dominated; the test frontier for buckets is `deepseek-v4-pro`, `glm-5.2`, `glm-5.2`, `gpt-5.5`.
- Phase 3 added `TaskClassifier` and `ClassificationResult` to `router-core`. A classifier returns `hardness` plus optional `profile`, `score`, and `reason`.
- `HEURISTIC_CLASSIFIER` is now the default deterministic implementation. It wraps the language-neutral fallback score.
- `selectFromPool()` now uses `Decision.requestedProfile`, so injected classifier profiles actually affect the Pareto axis.
- Current canonical model data already includes `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `kimi-k3`; old model names in tests are fixtures, not evidence that the model table is stale.
- Phase 4 added `classifier: "off"`, `classifierModel`, tolerant output parsing, cheapest-pool classifier selection, and per-model failure cooldown.
- Phase 5 wired the classifier as sticky async runtime state: current turn uses the previous classification result, then `completeSimple` refreshes for the next turn in the background.
- README now documents that the classifier sends the last user message plus routing stats to a model inside the user's authenticated, filtered pool.
- Review fix: runtime `loadConfig()` now reuses `mergeClassifierConfig()` so partial `router.classifier` objects keep default `enabled: true`.
- Review fix: forced `@cheap` and `@strong` tiers no longer invoke the injected/cached classifier, preventing stale profiles from affecting explicit tier overrides.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| First remove keyword dependence from fallback | This immediately fixes small-language bias even before provider-backed classification exists. |
| Keep provider calls outside `router-core` | `router-core` should stay deterministic and easy to test. |
| Add a classifier interface before production classifier logic | Enables fake classifiers in tests and clean fallback composition. |
| Make behavior-based escalation a later phase | It needs usage/tool/edit signals over time and should not block the classifier foundation. |
| Preserve image profile in fallback | It is not language semantics; it is a model eligibility constraint. |
| Let classifier score be optional | Fake and LLM classifiers can return categorical hardness only; router-core maps it to a representative score for logging/backward compatibility. |
| Keep classifier model health separate from cache-aware routing state | Failure cooldown is specific to classification providers and should not affect normal model selection. |
| Forced tiers use fallback profile only | A forced tier is an explicit routing command; stale classifier state from a previous turn must not influence it. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Existing working tree is dirty | Avoid touching existing code until user asks to implement. |
| Typecheck initially failed because `dist` still had the old `RouterConfig.weights.keyword` type | Running `npm test` rebuilt `dist`, then `npm run typecheck` passed. |
| Typecheck failed once after runtime wiring because `userTurnIndex` was not imported in `src/index.ts` | Added the missing import and reran verification successfully. |
| Review found two P2 classifier edge cases | Added shared classifier config merge for runtime config and moved forced-tier handling before classifier invocation. |

## Resources
- `src/router-core.ts`
- `src/index.ts`
- `src/router-core.test.ts`
- `README.md`
