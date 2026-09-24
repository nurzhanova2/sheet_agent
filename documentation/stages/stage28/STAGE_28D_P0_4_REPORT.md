# Stage 28D — P0-4 One Narration Verifier

Status: COMPLETE

## Pre-change inventory

| Check | Existing implementation | Input | Unique invariant | Duplicate / overlap | P0-4 target |
|---|---|---|---|---|---|
| unsupported numbers | `resolveNumericClaims` in `narration-facts.ts` | compiled `NarrationFactSet` + draft | every numeric token resolves to verified provenance, unit-aware rendering, or is rejected | legacy numeric clause in `agent/evidence.ts` | keep as the sole V2 numeric authority |
| causal claims | `checkCausalLanguage` in `narration-verifier.ts` | draft + locale | unhedged causal assertion is rejected; hedged hypothesis survives | legacy causal patterns in `agent/evidence.ts`; presented scan repeated it | one V2 causal check; presented scan remains final-text boundary |
| percentage / percentage-points | `checkPercentagePoints` and `checkPercentNotPoints` | draft + `VerifiedFinding[]` | unit label must match verified semantic unit | legacy claim validator partly checked digits only | retain in facade |
| rank / superlative | `checkSuperlatives` | draft + rank materiality | claimed extreme must match verified position | legacy Stage 26 rank checks | retain in facade |
| score explanation | `checkScoreExplained` | draft + score findings | bare score is not accepted without interpretation | no material V2 duplicate | retain in facade |
| answer quality | `evaluateAnswer` in `answer-evaluator.ts` | draft + request + findings | task fulfilled, direct, readable, non-dump, grounded subject, recommendation policy | `scanPresented` reuses it on final text | keep separate inside facade as `answer_quality` |
| internal leaks | `containsForbiddenLeak` in legacy narrator + taskpane final gate | draft / final UI text | internal handles, planner JSON, legacy terms and provenance fields never reach user | duplicate lists across Stage 25 narrator and taskpane | V2 facade owns its copy; taskpane remains a distinct final UI defense |
| presented text | `scanPresented` in `presented-claims.ts` | actual final text + findings + request | catches violations introduced after draft evaluation | causal and quality checks overlap by design at final-text boundary | preserve, without changing writer behavior |

## Implementation

`narration-verifier.ts` now exposes one structured `verifyNarration(input): VerificationResult` facade. It runs semantic checks, `resolveNumericClaims`, answer quality, and V2 leak checks with separate applied-check labels. The old three-argument signature remains as a compatibility overload for existing focused tests, but production V2 narration uses the structured facade.

`narrator.ts` now passes `NarrationFacts`, `VerifiedFinding[]`, request, result presence, locale, and structural row counts directly to the facade. It no longer adapts `EngineResult` or `VerifiedFinding` into `AgentObservation`, and no longer imports `agent/evidence.ts` for narration validation. Writer behavior and `PresentationPlan` ownership were not changed; the existing table renderer remains the writer helper.

The legacy `agent/evidence.ts`, `analytics-agent/narrator.ts`, and taskpane final gate remain available for their own legacy/UI boundaries. They are no longer V2 narration-verifier dependencies solely to validate V2 narration.

## Measurements

- Normal deterministic, LLM-first, retry: one V2 `verifyNarration` call per gate attempt; no legacy validator call and no AgentObservation conversion.
- Distinct V2 invariants: numeric provenance/unit, causal language, percentage-point semantics, rank/superlative, score explanation, answer quality, V2 leak defense; presented-text scan remains a separate final-text pass.
- V2 legacy verifier dependencies: `agent/evidence.ts` removed from `narrator.ts`; `analytics-agent/narrator.ts` retained only for the existing table writer helper.
- V2 back-conversion adapters: `comparisonObservation`, `findingsObservation`, and `asObservation` removed from `narrator.ts`.
- Narration verifier remains a single semantic module with the facade added; answer evaluator remains a separate quality module.
- Presented scan passes: unchanged as a final-text boundary; its existing causal/quality counters still run against actual presented text.

## Required focused cases

Added `narration/narration-verifier.test.ts` covering unsupported and grounded numbers, percent vs pp, grounded pp, causal rejection, hedged hypothesis, rank consistency, internal handles, raw dumps, recommendation policy, no-findings prose, and presented-text rescanning.

## Validation

Focused verifier: 7 tests passed.

Existing full add-in run after the integration: 2364 passed, 27 skipped, 0 failed. No live Qwen and no installer build.

Commit: `refactor(v2): consolidate narration verification` (final commit recorded in the repository history).

Next: P1 engine/routing consolidation. Stage 28 itself is not marked PASS.
