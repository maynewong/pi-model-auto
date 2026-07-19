# Progress Log

## Session: 2026-07-19

### Phase 1: Requirements & Discovery
- **Status:** complete
- Actions taken:
  - Read the planning-with-files skill instructions.
  - Checked for prior session catchup.
  - Inspected the repository structure.
  - Read `src/router-core.ts`, `src/index.ts`, `src/router-core.test.ts`, and `README.md`.
  - Identified the current keyword-based classifier and profile inference points.
- Files created/modified:
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### Phase 2: Heuristic Baseline Cleanup
- **Status:** complete
- Actions taken:
  - Removed `weights.keyword` from `RouterConfig` and `DEFAULT_CONFIG`.
  - Removed `keywordScore()` from deterministic hardness classification.
  - Reweighted fallback classification to context tokens, last user length, and tool density.
  - Changed `inferRequestedProfile()` to return `vision` for image requests and `balanced` otherwise.
  - Updated router-core tests to assert language-neutral fallback behavior.
  - Updated README to remove `keywords` from the public routing contract.
- Files created/modified:
  - `src/router-core.ts`
  - `src/router-core.test.ts`
  - `README.md`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### Phase 3: Classifier Interface
- **Status:** complete
- Actions taken:
  - Added `ClassificationResult` and `TaskClassifier` to `src/router-core.ts`.
  - Added `HEURISTIC_CLASSIFIER` as the default deterministic implementation.
  - Updated `decide()` to accept an injectable classifier.
  - Updated `selectFromPool()` to use `Decision.requestedProfile`.
  - Added a fake-classifier test that drives `max` hardness plus `fast` profile.
- Files created/modified:
  - `src/router-core.ts`
  - `src/router-core.test.ts`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### Phase 4: Optional Pool-Local LLM Classifier
- **Status:** complete
- Actions taken:
  - Added `classifier` config with `"off"` support.
  - Added `classifierModel` override.
  - Added cheapest eligible classifier model selection.
  - Added tolerant classifier output parsing.
  - Added classifier failure counting and cooldown.
- Files created/modified:
  - `src/router-core.ts`
  - `src/router-core.test.ts`
  - `README.md`

### Phase 5: Async Sticky Classification
- **Status:** complete
- Actions taken:
  - Added runtime classifier state in `src/index.ts`.
  - Wired previous classification into `decide()` via `TaskClassifier`.
  - Added background `completeSimple` refresh for next-turn classification.
  - Skipped refresh for forced routes and tool-call continuations.
- Files created/modified:
  - `src/index.ts`

### Phase 6: Documentation & Verification
- **Status:** complete
- Actions taken:
  - Documented background classifier privacy behavior.
  - Documented `classifier: "off"` and `classifierModel`.
  - Ran final verification.
- Files created/modified:
  - `README.md`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### Review Fixes: Classifier Config and Forced Tiers
- **Status:** complete
- Actions taken:
  - Exported and reused `mergeClassifierConfig()` in runtime config loading.
  - Moved forced-tier handling before classifier invocation in `decide()`.
  - Added regression tests for partial classifier config and stale classifier profile on forced tiers.
- Files created/modified:
  - `src/router-core.ts`
  - `src/index.ts`
  - `src/router-core.test.ts`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Planning only | Phase 1 | No code verification needed | Not run | n/a |
| Typecheck | `npm run typecheck` | Pass | Pass | pass |
| Unit tests | `npm test` | Pass | 2 files passed, 44 tests passed | pass |
| Typecheck after Phase 4/5 | `npm run typecheck` | Pass | Pass | pass |
| Unit tests after Phase 4/5 | `npm test` | Pass | 2 files passed, 46 tests passed | pass |
| Typecheck after review fixes | `npm run typecheck` | Pass | Pass | pass |
| Unit tests after review fixes | `npm test` | Pass | 2 files passed, 48 tests passed | pass |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-07-19 | `npm test` failed in AA hardness frontier expectation after profile fallback changed to `balanced` | 1 | Recomputed bucket choices from `dist` and updated expected frontier. |
| 2026-07-19 | `npm run typecheck` failed after runtime classifier wiring: missing `userTurnIndex` import | 1 | Added the import and reran typecheck/tests successfully. |
| 2026-07-19 | Review found runtime partial classifier config and forced-tier stale classifier edge cases | 1 | Fixed both and added regression tests. |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Review fixes complete. |
| Where am I going? | Optional follow-up: behavior-signal correction. |
| What's the goal? | Build a language-independent routing classifier stack suitable for open source. |
| What have I learned? | See findings.md. |
| What have I done? | Created the plan and discovery notes. |
