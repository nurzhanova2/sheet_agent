# Stage 28C.1 — P0-3 Presentation Plan

Status: PASS

## Regression classification

The original full add-in run reported nine failures, all in
`taskpane/use-agent-stage-26-8.test.tsx`. They were one fixture-contract defect
with eight downstream assertions:

- obsolete fixture contract: 9
- implementation-pinning tests: 0
- behavioral regressions: 0
- grounding/correctness regressions: 0
- harness defects: 0

`biggestMoverScript` still called `change.compare_periods` with the old
endpoint-only contract. P0-2 requires the typed `periodIntent`; the fixture now
uses `{ periodIntent: { kind: "latest_vs_previous" } }`. No production fix was
needed. The nine tests then passed unchanged, preserving their product
invariants: V2 ownership, source table, progress/timing, follow-up context,
reset, deterministic narration fallback, debug trace, and result handoff.

## PresentationPlan invariant

`planPresentation(analysis, findings, answerIntent, method?)` is the only
production selector. It determines lead/support ordering, shape limit,
meta-finding demotion, redundant-subject suppression, caveat deduplication,
and evidence-table visibility. The engine creates one immutable plan per turn
and passes that same plan to deterministic rendering, first narration, retry
narration, and final deterministic fallback.

`AnswerPlan`, `answer-plan.ts`, the two-value `AnswerShape`, old ordering and
shape selectors, and the duplicate narrator table decision were removed.
`financial-note.ts` remains only as a compatibility formatter for legacy Stage
27.8 tests; it has no production selection ownership.

## Validation

- focused PresentationPlan / Stage 28A / Stage 28B / Stage 27.7–27.8: 141/141
- previously failing Stage 26.8 file: 24/24
- full add-in: 2364 passed, 27 skipped, 0 failed
- root Node contracts: 29/29
- workspace typecheck: passed
- add-in eslint: passed

No live Qwen benchmark or installer build was run. P0-4 is the next stage.
