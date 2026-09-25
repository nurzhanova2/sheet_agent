# Stage 28B — P0-1 AnswerIntent

V2 path: request → `planner-prompt.ts` → `AnswerIntent` on `complete` or final
`tool_call` → `planner-loop.ts` outcome → `engine.ts` → findings →
`NarrationInput.answerIntent` → deterministic/narrator presentation.

The planner is the sole semantic owner of shape, count, direction, subjects,
period intent, table preference, recommendation preference and answer style.
`PeriodIntent` is carried unchanged; resolving concrete workbook periods remains
owned by P0-2's resolver.

`answer-shape.ts` now has only result/finding helpers. Its explicit omission
fallback is result-derived and records `answerIntentOmitted` in the V2 trace;
it never examines the request. Removed routes: request shape, count, direction,
table and recommendation parsing.

Downstream request uses: `narrator.ts` includes the request as user-visible
context for the narrator, not for semantic routing; `answer-evaluator.ts` uses
the request only for fail-closed quality guards (including unsolicited-advice
detection); `presented-claims.ts` receives it for claim verification. There are
zero V2 downstream raw-request semantic routes.

Complexity: V2 downstream raw-text semantic parsers 1 → 0; AnswerIntent
representations 0 → 1; `answer-shape.ts` 193 → 63 LOC; downstream semantic
decisions re-derived from request 5 (shape/count/direction/table/recommendation)
→ 0. Stage 24/25 are intentionally outside this measurement.

Next: P0-3 PresentationPlan. Do not begin it in this slice.
