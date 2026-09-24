STAGE 28F - STATE & REGISTRY CONSOLIDATION - PASS

P0 COMPLETE. P1 engine/routing: BLOCKED on 6->1 only (see 28E).
P1 state/registry: PASS.

AUTHORITATIVE ANALYTICAL STATE
`analytical-engine-v2/state/` (conversation-state, state-commit, state-refs,
clarification-loop). It alone answers "what were we just talking about":
tableRef, lastResult, recentResults, lastMetric, lastMetricSet, lastPeriod,
lastPeriodRange, lastSeries, lastEvent, lastAnalysis, suspended - each typed,
lineage-carrying and freshness-checked. The narrowest-set rule, ResultRef /
RowSetRef lineage and the analytical follow-up references are unchanged.

AUTHORITATIVE V2 TOOL REGISTRY
`analytical-engine-v2/tools/registry.ts` (V2_TOOLS, 39 ToolSpec). ToolSpec is
the single metadata definition: name, description, capability, args, returns,
accepts, reads, usable, run. `tools/projection.ts` is the single projection of
it (signatureOf, argSummaryOf, sharedArgumentsOf, ownArgLinesOf, projectTools).

DERIVED CAPABILITY PROJECTIONS (all from the registry, none independent)
capability-index (grouping + descriptors), capability-selection (dynamic
exposure), capability/tool-context (planner prompt text), capability/agent-tools
(sandbox agent-loop shape), context/build-context (full-catalogue baseline).
Stage 27 dynamic tool exposure is preserved - the prompt still carries a tiered
subset, never every contract.

MUTATION STORE BOUNDARY (the second store, by design)
`app/session-memory.ts` + `app/conversation-memory.ts`, narrowed 1340 -> 766 LOC
and 19 -> 8 fields: recentResults, lastResultId, lastRowSet, lastChart,
lastCreatedSheet, pendingClarification, seq, knownIds. It owns what a WRITE acts
on - ResultRef identity for Preview/Approve/Execute/Undo, RowSetRef, ChartRef,
SheetRef - plus the chart/column/entity/dataset clarifications. Merging it into
V2 would put read-only analytical state in charge of workbook writes.

FLAT-RECORDS REGISTRY BOUNDARY (the second registry, by domain)
`agent/tool-registry.ts` (13 tools) serves records lists and cross-sheet
questions. Names are disjoint from V2's; a test asserts no overlap and that V2
advertises no records capability.

MIRRORED WRITES REMOVED
10 analytical reference fields and their 10 `remember*` writers
(lastPeriodRef, lastCompositeRef, lastRankingRef, lastEventRef,
lastAnalyticalTable, lastDirectionChangeRef, lastMetricSetRef, lastResultSetRef,
lastAnalyticalResultSetRef, lastMetricFocusRef) had no production writer after
28E and no non-debug reader. Also removed: resolvedEntities / rememberResolved /
ResolvedWorkbookRef (no caller anywhere), and the dead
`analyticalContinuationStanding` guard.

CLARIFICATION
Analytical clarification lifecycles 2 -> 1 (V2 SuspendedPlannerState).
ClarificationKind 14 -> 6, every survivor non-analytical: column_ambiguous,
dataset_ambiguous, reference_ambiguous, chart_columns, agent, entity_action.

CORRECTION TO THE PLAN
P1-5(a) proposed carrying verified findings across the V2->V1 bridge instead of
`facts: []`. `ResultRef.facts` has no production reader, so that would add a
field with no consumer. The bridge is unchanged; the dead field is recorded as
debt.

DEAD CODE REMOVED (with evidence)
agent/index.ts (0 importers), app/qwen-key-store.ts + test (companion holds the
key via DPAPI), 4 orphaned clarification builders, 4 duplicate projection
helpers. tools/compatibility-matrix.gen.ts + test moved to harness/.

COMPLEXITY
SessionMemory fields 19 -> 8; mutation-store reference types 20 -> 7; mirrored
analytical writers 10 -> 0; ClarificationKind 14 -> 6; clarification builders
10 -> 6; analytical clarification lifecycles 2 -> 1; mutation-store LOC
1340 -> 766; duplicate tool-projection implementations 4 -> 1; authoritative
tool metadata definitions 1 (unchanged); build-context 211 -> 171 LOC;
use-agent.ts 3075 -> 2969 LOC (59 -> 58 imports); production LOC
48933 -> 48172; 3 files deleted, 2 moved, 893 LOC removed.

VALIDATION
full add-in 2035 passed / 27 skipped / 0 failed; focused batch 365/365; new
state tests 28/28; new registry tests 17/17; root Node 29/29; tsc PASS; eslint
PASS. No companion run, no installer, no live Qwen.

Report: documentation/stages/stage28/STAGE_28F_REPORT.md
Commit: recorded below by the docs commit.
Next: Stage 28G - sandbox consolidation + final architecture cleanup.
Stage 28 is NOT PASS.

STAGE 28E - P1 ANALYTICAL ENGINE & ROUTING - BLOCKED ON 6->1, CONSOLIDATION DONE

P0 COMPLETE. P1 engine/routing: BLOCKED (on the 6 -> 1 engine target only).

AUTHORITATIVE ANALYTICAL ENGINE
`analytical_engine_v2`. It owns every analytical turn over a TableSchema it can
induce (`orientation != "row_records"`, `confidence >= 0.5`) - computation,
change, comparison, ranking, grouped ranking, overview/schema description,
trend, volatility, exploration, sandbox work, cross-metric analysis, and every
analytical follow-up on its own result. There is no analytical fallback chain
across generations any more: 0 fallback generations, and a turn the engine owns
never reaches a second analytical engine.

REMAINING NON-ANALYTICAL ROUTES
slash commands; undo; mutations; result actions; deterministic transforms of a
stored result; general chat / concept questions; the flat-records describe
capability (`describeSchema`, no model call).

LEGACY ENGINES REMOVED
`stage25_planner` (the whole `analytics-agent/` folder), `stage24_compiler`
(`analytical-intent` / `analytical-compiler` / `analytical-executor` /
`analytical-plan-validator` / `analytical-analysis` / `subject-resolver`),
`stage24_schema` (`schema-result.ts`), plus the dead `stage24_followup` and
`flat_analyzer` ledger members and the Stage 24.8/24.9 follow-up cascade.

LEGACY ENGINES RETAINED - WHY
`stage24_grouped_ranking` and `stage24_agent` own FLAT RECORDS tables and
CROSS-SHEET questions. V2 induces no metric schema for either, so
`resolveV2Table` returns null and those turns decline with `no_table` by
construction. Deleting them would lose real behaviour, so this is a BLOCKED
result, not a compatibility cascade. Smallest prerequisite: a `row_records`
projection plus `group_by`/`filter_rows` tools in the V2 registry; cross-sheet
scope is a second, independent prerequisite (P1-4 `workbook_discovery`).

REMAINING LEGACY UTILITIES (preserved primitives, not engines)
`app/schema/analytical/{metric-resolver,period-index,period-resolver,
series-aggregates,temporal-primitives,temporal-series,derive-expr,types}`,
`matrix-analysis`, `measure-compatibility`, `schema-induction`,
`app/schema/describe-schema.ts`, `app/grouped-ranking.ts`,
`app/agent-eligibility.ts`, `agent/*` (the flat-records agent).

FEATURE FLAGS
`VITE_UNIFIED_ANALYTICAL_ENGINE_V2` REMOVED, `VITE_ANALYTICAL_PLANNER_V1`
REMOVED, `VITE_ANALYTICAL_AGENT_LOOP` KEPT (sandbox loop; default off).

COMPLEXITY
live analytical engine call sites 6 -> 3; declared engine identities 8 -> 3;
analytical fallback generations 3 -> 0; pre-router analytical classifiers 4 -> 2;
legacy analytical entry points 5 -> 0; production imports from `analytics-agent/`
8 -> 0; agent flags 3 -> 1; `use-agent.ts` 4369 -> 3075 LOC (136 -> 59 imports);
production files 224 -> 207; production LOC 55626 -> 48933; 54 files and 14450
LOC deleted.

VALIDATION
full add-in 2007 passed / 27 skipped / 0 failed; focused routing + Stage
28A-28D regressions 193/193; sandbox + mutation 334/334; root Node 29/29; tsc
PASS; eslint PASS. No live Qwen, no installer build.

Report: documentation/stages/stage28/STAGE_28E_P1_REPORT.md
Commit: a1efae1 refactor(agent): consolidate analytical routing on v2
Next: state / registry / sandbox consolidation.
Stage 28 is NOT PASS.

STAGE 28D - P0-4 ONE NARRATION VERIFIER - COMPLETE

P0-4 is complete at the current worktree. The authoritative V2 narration gate is
`verifyNarration` in `apps/addin/src/analytical-engine-v2/narration/narration-verifier.ts`.
Numeric authority remains `resolveNumericClaims`; causal and leak checks are
consolidated in the V2 facade, while `scanPresented` remains the actual-text
boundary and the taskpane final leak gate remains the final UI defense. V2 no
longer converts EngineResult/VerifiedFinding into AgentObservation for narration
validation and no longer imports `agent/evidence.ts` for that purpose.

Validation: focused verifier 7/7; full add-in 2364 passed, 27 skipped, 0 failed.
No live Qwen or installer build. Commit: `refactor(v2): consolidate narration verification`.
Next: P1 engine/routing consolidation. Stage 28 is not PASS.

STAGE 28C.1 - P0-3 PRESENTATION PLAN - PASS

RESUME HERE
documentation/HANDOFF_STAGE_27_8.md is the authoritative resume document.
Read it first. This file is the short status summary only.

STAGE 28C — P0-3 PRESENTATION PLAN — COMPLETE / BLOCKED

P0-3 implementation and regression closure are complete. The nine Stage 26.8-era
failures were obsolete fixture-contract failures: the fixture planner emitted
`change.compare_periods` without the now-required typed `periodIntent`. The
fixture was migrated to `latest_vs_previous`; no production behavior was
changed for these failures. Focused presentation and Stage 27 regression tests
are green (141/141).

PresentationPlan is defined in
`apps/addin/src/analytical-engine-v2/narration/presentation-plan.ts`. It is the
single selector derived from `AnswerIntent`, `EngineAnalysis`, and verified
findings. It owns lead/support ordering, shape limits, meta-finding demotion,
redundant-subject suppression, caveat deduplication, and the evidence-table
decision. The engine creates one plan per turn and passes that same object to
the deterministic writer, first narrator prompt, and retry narrator prompt.

Removed: `narration/answer-plan.ts`, `AnswerPlan`, the two-value `AnswerShape`,
`orderByRelevance`, `selectForShape`, `withoutRedundantSubjects`, and the
duplicate table decision in `narrator.ts`. `financial-note.ts` is retained only
as a Stage 27.8 compatibility formatter used by its legacy tests; it is no
longer imported by production narration and does not select findings.

Measured P0-3 complexity: answer-selection stages 9 → 1 authoritative
`planPresentation`; presentation selector representations `AnswerPlan` plus
the two-value `AnswerShape` → `PresentationPlan`; narration production files
9 → 9 (one new plan module, one removed answer-plan module); financial-note
selection branches 0 in production (the compatibility formatter remains);
duplicate table-decision helpers 2 → 1. The legacy
`AnalyticalNoteFact`/`AnalyticalNoteStructure` representations remain for the
Stage 27.8 compatibility tests and are deferred for later cleanup.

Validation: add-in typecheck passed; add-in eslint passed; focused PresentationPlan,
Stage 28A period, Stage 28B AnswerIntent, and Stage 27.7/27.8 tests passed
(141/141). Full add-in suite: 2355 passed, 27 skipped, 9 failed in the
pre-existing Stage 26.8 fixture. Root Node gate passed (29/29). No commit was
this blocked gate is recorded. Next: P0-4 — one narration verifier. Do not
start P0-4 in this session.

CORRECTION: the fixture migration closed all nine failures. The final full
add-in result is 2364 passed, 27 skipped, 0 failed; root Node is 29/29. Commit
is created for this completed P0-3 slice.

STAGE 28B — P0-1 COMPLETE (`refactor(v2): preserve planner AnswerIntent`): V2 `AnswerIntent` is defined in
`analytical-engine-v2/types.ts` and is owned by the existing planner. The
planner protocol carries it on `complete` and final `tool_call` decisions;
the loop, engine and narrator preserve it without another model call.
`PeriodIntent` is retained unchanged within it. `answer-shape.ts` no longer
parses request text for shape, count, direction, table or recommendation;
its sole omission fallback is result/finding-derived and the engine records
`answerIntentOmitted` in the trace. The recommendation regex remains only in
`answer-evaluator.ts` as a fail-closed output-quality guard. P0-0 and P0-2
are complete. Do not mark Stage 28 PASS. Next: P0-3 PresentationPlan.

STAGE 28A — P0-0 is complete (baseline `2f5f54a`). P0-2 period ownership is
implemented and committed: `PeriodIntent` is owned by `analytical-engine-v2/types.ts` and
`resolvePeriodIntent` in `tools/semantic-refs.ts` is the authoritative V2
resolver over `PeriodIndex`. Stage 24/25 period implementations remain outside
V2 and intentionally untouched. Focused period tests, the full add-in suite,
root Node tests, tsc and eslint pass. Every current V2 change-tool caller now
declares its intent. Next step: P0-1 AnswerIntent. Do not mark all of Stage 28
PASS.

STAGE 28 AUDIT COMPLETED — NO REFACTOR IMPLEMENTED YET.
Stage 28 is NOT marked PASS. It was an audit-only session: no production source,
tests or installer were changed.

Authoritative next documents:
documentation/stages/stage28/ARCHITECTURE_AUDIT.md
documentation/stages/stage28/REFACTOR_PLAN.md
(supporting: documentation/stages/stage28/ARCHITECTURE_MAP.md)

Note for the next session: the working tree still carries the uncommitted
Stage 27.8 work (169 modified files, 62 untracked, on top of 7b16fb4). The
refactor plan's first step (P0-0) is to decide what of it survives and commit a
green baseline before anything else moves.

CURRENT STAGE
Stage 27.7 — PASS. Manual Excel verification has been performed.

LAST VERIFIED BASELINE
2348 add-in tests passed
27 skipped
17 companion tests passed
tsc clean
eslint clean

CURRENT INSTALLER
artifacts/installer/SheetAgentSetup-x64.exe
87,469,534 bytes
SHA-256:
d120d4d9f7eb2a2d6be5996ef0bacb1d5c323617dbe8a05794de26d9a5c6f1ea

Companion SHA-256:
f7bd878b262e3abae1df35805dc79dc984452ed95dc70481d8f63f5bfbc52ef3

Installer handoff:
documentation/stages/stage27_7/INSTALLER_HANDOFF.md
Stage report:
documentation/stages/stage27_7/stage27_7_real_excel_performance.md

Previous installers are archived under artifacts/installer/archive-*.
All are ~83 MiB and report version 0.3.0 — distinguish them by SHA-256 only.

WHAT STAGE 27.7 DELIVERED (do not redo — see HANDOFF §4)

1. SANDBOX WORKS IN REAL EXCEL.
Root cause: the companion did not serve .whl files at all. ASP.NET Core has no
mapping for that extension and does not serve unmapped extensions, so all 9
Python wheels returned 404 and Pyodide died fetching numpy. Fixed in
apps/windows-companion/Program.cs; no CDN fallback. A release gate
(installer/tests/Assert-SandboxAssetsServable.ps1) now requests every shipped
file over TLS before the installer is packaged.
Confirmed by manual test: clustering ran, 2 Python runs.

2. FEWER MODEL ROUND TRIPS.
A simple deterministic request went from 4 planner rounds + 1 narration to
1 round + 0 narration, with identical results asserted. Mechanism: a
"final": true flag on tool_call, period defaults on the change tools, and a
prompt section saying the periods and metrics are already listed.
Simple turns now measure ~3–7 s in Excel.

3. DETERMINISTIC-FIRST ANSWERS, COLLAPSED EXECUTION UI, REAL TIMINGS.
renderDeterministic runs first for simple shapes behind the same grounding
gate; progress rows collapse into one expandable line above the answer;
plannerRounds / sandboxMs / pythonExecutionCount are recorded for the first
time.

WHAT IS STILL BROKEN (see HANDOFF §5, §6)

BUG — PERIOD_RESOLUTION_PRODUCTION_BUG
Production still compares first vs last across the whole history for
"относительно предыдущего периода" and "на сколько выросли активы"
(observed: 01.01.2024 → 01.12.2025, +32.98%). The tools support
latest-vs-previous; the production selection does not reach them.

QUALITY — FINANCIAL_NOTE_COMPOSITION_GAP
Answers still serialise findings: «Рост «Активы» составил…», «оценка
волатильности — 5,2», «Cluster_0 — …», «В таблице 19 показателей за 15
периодов…».

PERFORMANCE — SANDBOX_LATENCY_DEBT
Sandbox clustering took 130 s with 2 Python runs.

CARRIED DEBT
SANDBOX_CODEGEN_RELIABILITY
EXTRACTOR_QUALITY_DEBT

NEXT STAGE
Stage 27.8 — Financial Analytical Note Composer & Period Correctness.
Scope, design principle and first actions: documentation/HANDOFF_STAGE_27_8.md

DO NOT
- start Stage 28;
- add another planner;
- create keyword routing;
- weaken grounding or sandbox security;
- replace Pyodide with a CDN;
- rerun old broad Qwen benchmark suites;
- redesign the working Stage 27.7 execution UX;
- solve answer quality only by prompt engineering.
