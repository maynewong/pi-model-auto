# Task Plan: Language-Independent Router Classification

## Goal
Replace keyword-driven task classification with an open-source friendly, language-independent routing stack: heuristic fallback first, optional pool-local LLM classification, and later behavior-based correction.

## Current Phase
Phase 6 complete; next optional work is behavior-signal correction.

## Phases

### Phase 1: Requirements & Discovery
- [x] Inspect current router classification and selection flow.
- [x] Identify privacy, determinism, and open-source constraints.
- [x] Document findings in findings.md.
- **Status:** complete

### Phase 2: Heuristic Baseline Cleanup
- [x] Remove keyword weighting from default classification.
- [x] Keep context tokens, last user length, and tool density as the deterministic fallback.
- [x] Remove or de-emphasize `inferRequestedProfile` keyword matching so language dependence is isolated from core routing.
- [x] Update tests that currently rely on English prompt keywords.
- **Status:** complete

### Phase 3: Classifier Interface
- [x] Introduce an injectable classifier contract that returns hardness plus optional profile.
- [x] Keep deterministic heuristic classification as the default implementation.
- [x] Make router-core tests inject fakes instead of invoking provider logic.
- **Status:** complete

### Phase 4: Optional Pool-Local LLM Classifier
- [x] Add config for classifier mode: enabled/off plus optional explicit `classifierModel`.
- [x] Select a default classifier from the authenticated pool by simple minimum price, not full routing.
- [x] Parse classifier output tolerantly and fall back on failure.
- [x] Track classifier failures and temporarily disable unstable classifier models.
- **Status:** complete

### Phase 5: Async Sticky Classification
- [x] Store last classifier result in runtime state.
- [x] Use the previous result for the current turn, then refresh classification asynchronously for the next turn.
- [x] Ensure first turns use the deterministic fallback.
- [x] Keep tool-call continuation reuse unchanged.
- **Status:** complete

### Phase 6: Documentation & Verification
- [x] Update README privacy disclosure and `classifier: off` documentation.
- [x] Update settings table and "How It Chooses" section.
- [x] Run `npm run typecheck` and `npm test`.
- **Status:** complete

## Key Questions
1. Should profile routing remain semantic, or collapse to `balanced` until the LLM classifier is available?
2. Where should classifier state live: existing `RoutingState`, a new `ClassificationState`, or both?
3. What provider call surface is available for a non-streaming classifier call inside the extension?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Keep deterministic heuristics as the base layer | It is language-independent, free, and testable. |
| Make the LLM classifier optional and pool-local | Avoids silently expanding the user's privacy surface beyond configured providers. |
| Use simple min-price classifier selection | Avoids recursive dependency on the full router. |
| Prefer sticky async classification | Avoids TTFT cost while matching the existing cache-aware reuse direction. |
| Make fallback profile `balanced` except for images | Avoids embedding English semantic regexes in the deterministic layer; image routing remains a hard capability constraint. |
| Keep provider calls out of `router-core` | The core stays synchronous and deterministic; runtime can inject a cached or fake classification result through `TaskClassifier`. |
| Use `completeSimple` only in runtime | Provider auth and privacy-sensitive calls stay in `src/index.ts`, where authenticated model access already lives. |
| Reuse classifier config merge in runtime | User and project config paths must preserve classifier defaults when users tune only one field. |
| Forced tiers ignore cached classifier output | Explicit `@cheap`/`@strong` should route on the current request, not stale previous-turn profile data. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `npm test` failed after profile cleanup because AA balanced frontier changed bucket expectations | 1 | Recomputed the bucket choices and updated tests to assert the language-neutral frontier. |
| Review found partial runtime classifier config could disable the classifier | 1 | Exported `mergeClassifierConfig()` and reused it in `src/index.ts` runtime config loading. |
| Review found stale classifier profile could affect forced tiers | 1 | Moved forced-tier handling before classifier invocation and added a regression test. |
