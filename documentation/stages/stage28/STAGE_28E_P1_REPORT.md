# Stage 28E — P1 single analytical engine & routing consolidation

**Result: BLOCKED on the stated 6 -> 1 target. Delivered: one analytical engine
for the whole schema-analytical domain, and zero fallback generations.**

Baseline: `ab96a4a` (P0 complete — 2371 passed / 27 skipped / 0 failed).
P0 ownership (PeriodIntent, AnswerIntent, PresentationPlan, verifyNarration) was
not touched.

---

## 1. The map, re-measured post-P0

`recordAnalyticalExecution` call sites, read off the current tree rather than the
audit's line numbers.

| ENGINE | ENTRY | TRIGGER | FLAG | CALL SITE (before) | TURNS IT OWNED | V2 REPLACEMENT | V2 CAN DO IT? | ACTION |
|---|---|---|---|---|---|---|---|---|
| `analytical_engine_v2` | `runAnalyticalEngine` | `classifyTurnOwner` = V2_OWNED | `VITE_UNIFIED_ANALYTICAL_ENGINE_V2` | `use-agent.ts:2560` | every analytical turn over a non-records TableSchema | — | — | **AUTHORITATIVE** |
| `stage24_compiler` | `runAnalyticalRoute` -> `runAnalyticalAnalysis` | `detectAnalyticalIntent(text).any`; declines `row_records` / `confidence < 0.5` | — | `use-agent.ts:3253` | **exactly V2's domain** | V2 tools wrap the same Stage 24.7-24.9 primitives | yes | **DELETED** |
| `stage24_schema` | `runSchemaRoute` -> `runSchemaAnalysis` | `detectSchemaIntent(text).any` | — | `use-agent.ts:3431` | V2's domain, **plus** describe over `row_records` | `schema.describe` -> `table_overview` finding | matrix: yes / records: **no** | **DELETED**, records-describe preserved as a primitive |
| `stage25_planner` | `runAnalyticalPlanner` | `classifyIntent.analytical` OR `isExploratoryRequest` OR `lastAnalyticalTable` OR `followUpOnStandingResult`; `plannerSnapValid` is **the identical domain predicate to V2's `usable`** | `VITE_ANALYTICAL_PLANNER_V1` | `use-agent.ts:1318` | exactly V2's domain | the V2 planner + the 39-tool registry (30 names shared) | yes | **DELETED** |
| `stage24_grouped_ranking` | `planGroupedRanking` | `detectGroupedRanking(text)`, over `snap.headers` | — | `use-agent.ts:3265` | flat **records** tables | none | **no** | **RETAINED** |
| `stage24_agent` | `runAgentLoop` | `classifyAgentEligibility(text, route)` | — | `use-agent.ts:2050` | flat records + **cross-sheet** | none | **no** | **RETAINED** |
| `stage24_followup`, `flat_analyzer` | — | — | — | none (F-24 confirmed) | none | — | — | **type members removed** |

The decisive measurement: `runAnalyticalRoute`, `runSchemaRoute` and
`runStage25Planner` each gate on `orientation !== "row_records" && confidence >= 0.5`
— byte-for-byte the predicate `resolveV2Table` uses. Those three were competing
generations of one domain. The other two are a different data domain.

## 2. Every NON_V2 reason, classified

| REASON | CATEGORY | DISPOSITION |
|---|---|---|
| `flag_off` | F — legacy fallback | **REMOVED** with `VITE_UNIFIED_ANALYTICAL_ENGINE_V2` |
| `no_planner_transport` | capability precondition | KEPT — not a flag; the engine cannot run without a planner transport |
| `slash_command` | C | KEPT |
| `undo` | C | KEPT |
| `result_action` | B | KEPT |
| `mutation_request` | B | KEPT |
| `general_knowledge` | D | KEPT |
| `v1_clarification_pending` | B/C | KEPT — the analytical clarification kinds (`analytical_agent`, `schema_norm`, `schema_threshold`, `analysis_subject`, `analysis_period`) had their producers and resume branches deleted; what remains is chart / reference / column / entity / dataset / flat-agent, all preserved capabilities |
| `v1_conversation_standing` | B | KEPT — a deterministic transform of a stored records result |
| `not_analytical` | A -> migrated | `workbook_qa` and `mixed` are now analytical; this is section 10's fix |
| `no_table` | **G -> E** | the flat-records / cross-sheet capability boundary. **This is the blocking gap.** |

## 3. What changed

**Ownership widened (section 10).** `workbook_qa` (`isStructuralQuestion` —
"О чём эта таблица?", "Что это за данные?", "Опиши эту таблицу") and `mixed` (a
computation that also asks what it means) are analytical. V2 answers them with
`schema.describe` -> `table_overview`, which it already had.

**Pre-router analytical classifiers: 4 -> 2.** The ownership context asked
`routeTurn`, `detectAnalyticalIntent` (512 LOC of Stage 24 regex),
`classifyIntent` and `isExploratoryRequest`. It now asks `routeTurn` and
`isExploratoryRequest`. `classifyIntent` keeps its one legitimate home inside
`routeTurn`. The narrowing is provably outcome-neutral: every turn it drops was
already declined earlier in `classifyTurnOwner`'s fixed order as
`general_knowledge`, because `routeTurn`'s general-chat rule requires `!deixis`,
so a deixis-carrying general-chat turn cannot exist.

**`buildOwnershipContext` extracted** to
`analytical-engine-v2/production/turn-context.ts`. It is the ONE place raw request
text is read before the planner, and the only question it answers is which
capability the turn belongs to. Ranking, count, direction, grouping, comparison,
period and answer shape are deliberately absent. This also makes ownership
unit-testable without mounting the hook — `use-agent.ts` now calls
`buildOwnershipContext` + `classifyTurnOwner` and nothing else.

**Shared utilities moved out of the legacy namespaces first** (section 12,
class B): `renderTableForUser` -> `app/answer-table.ts`, `containsForbiddenLeak`
-> `app/answer-leak.ts`, `isAnalyticalFollowUp` + `isExploratoryRequest` ->
`app/analytical-turn.ts`, `describeSchema` -> `app/schema/describe-schema.ts`.
V2's last import from `analytics-agent/` is gone.

**Flat-records describe preserved as a capability, not an engine.** The Stage 24
schema route also answered "о чем эта таблица" over a flat records list with no
model call. V2 induces no metric schema for that shape, so deleting the route
outright would have lost the behaviour. `describeSchema` survives as a discovery
primitive, routed on `route.route === "workbook_qa"` — the verdict the router
already computes, so no classifier was added. No tools, no model call, no
findings: trace route `flat_table_describe`.

## 4. Blocked — the gap, precisely

**Legacy engines retained:** `stage24_grouped_ranking`, `stage24_agent`.

**Missing V2 capability:** V2 analyses one induced `TableSchema` whose
`orientation !== "row_records"` and `confidence >= 0.5`. It has no capability for
a flat records list and no capability that reads across sheets. `resolveV2Table`
returns `null` for both, so those turns decline with `no_table` by construction.

**Affected user requests:** "покажи 3 менеджеров с худшим Variance" over a
records table (deterministic group-by + rank); "выдели их" grounding that result
to its source rows; "о чем эта таблица" over a records table; any cross-sheet
discovery or causal question.

**Tests proving the gap:**
`analytical-engine-v2/production/turn-routing.test.ts` — "a flat-records
selection the engine cannot induce a schema for is not the engine's" asserts
`no_table`. `taskpane/use-agent-flat-records.test.tsx` asserts the three
behaviours that would be lost.

**Smallest prerequisite:** a records capability in the V2 registry — a
`row_records` schema projection plus `group_by` / `filter_rows` tools over it —
so `resolveV2Table` can accept a records table. Cross-sheet scope is a second,
independent prerequisite (P1-4's `workbook_discovery` capability). Neither is this
stage's slice, and neither can be faked by renaming.

## 5. Feature flags

| FLAG | OLD PATH | NEW PATH | DEFAULT | PRODUCTION | TEST | MIGRATION | ACTION |
|---|---|---|---|---|---|---|---|
| `VITE_UNIFIED_ANALYTICAL_ENGINE_V2` | Stage 24/25 cascade | V2 | on | yes | 1 rollback test | **complete — nothing left to roll back to** | **REMOVED** |
| `VITE_ANALYTICAL_PLANNER_V1` | Stage 24 deterministic only | Stage 25 planner | on | yes | none | engine deleted | **REMOVED** |
| `VITE_ANALYTICAL_AGENT_LOOP` | one-shot sandbox | iterative sandbox loop | off | yes | `stage-27-2a` | not started | **KEPT** — sandbox consolidation owns it |

The rollback test's invariant died with the dual architecture; it was rewritten as
"without a planner transport the turn is not the engine's and the engine never
starts", which is the real remaining precondition.

## 6. Test migration

| SUITE | INVARIANT IT PROTECTED | DISPOSITION |
|---|---|---|
| `analytics-agent/*.test.ts` (10 files) | the Stage 25 registry, winner algorithm, semantic frame, canonical refs | deleted with the implementation |
| `use-agent-stage-25*.test.tsx` (11 files) | pronoun/focus continuity, narrowest-set, superlative-by-verified-reduction, clause coverage, no-JSON-leak, clarification resume, exploratory cardinality | every one has a V2-level equivalent that already passes — `lifecycle.test.ts`, `recovery.test.ts`, `primary.test.ts`, `units.test.ts`, `serialization.test.ts`, `production.test.ts`, `narration.test.ts`. The suites themselves were pinned to `decideAgentStep` scripts and the legacy cascade order; deleted |
| `use-agent-stage-24-8/24-9.test.tsx` | EventRef/ResultSetRef/DirectionChange follow-ups over the Stage 24 compiler | the product invariant (a follow-up resolves to the subject already in focus) is V2's `reference.last_metric` + `state-commit` narrowest-set, covered in `lifecycle.test.ts` and end-to-end in `use-agent-stage-26-8.test.tsx`; deleted |
| `use-agent-analytical.test.tsx`, `use-agent-schema.test.tsx` | mostly the two deleted engines; **three surviving records-domain invariants** | rewritten as `use-agent-flat-records.test.tsx` |
| `schema-overview-27-7.test.ts`, `stage-24-7/8/9-*.test.ts`, `analytical-intent.test.ts`, `analytical-analysis.test.ts` | the deleted compiler/executor/validator | deleted with the implementation |
| `metric-resolver.test.ts`, `matrix-analysis.test.ts` | shared primitives plus the deleted orchestration | orchestration blocks removed; `describeSchema` keeps its own no-raw-serials invariant |

**New durable tests:** `production/turn-routing.test.ts` (28 tests — the required
routing cases 1-13 over the real production context builder) and three ledger
invariants in `use-agent-stage-26-8.test.tsx` (exactly one engine per owned turn,
it is `analytical_engine_v2`, and no Stage 24/25 generation executes on any turn
of a mixed session).

## 7. Complexity metrics

| METRIC | BEFORE | AFTER |
|---|---|---|
| Live analytical engine call sites | 6 | **3** (1 authoritative + 2 flat-records) |
| Declared analytical engine identities | 8 | **3** |
| Normal analytical fallback generations | 3 (`stage24_compiler` -> `stage24_schema` -> `stage25_planner`) | **0** |
| Pre-router analytical semantic classifiers | 4 | **2** |
| Legacy analytical entry points in production | 5 | **0** |
| Production imports from `analytics-agent/` | 8 (1 from V2) | **0** (folder gone) |
| Production imports from Stage 24 analytical orchestration | 5 | **0** |
| Agent feature flags | 3 | **1** |
| `use-agent.ts` LOC | 4 369 | **3 075** (-1 294) |
| `use-agent.ts` imports | 136 | **59** |
| Production TS/TSX files (add-in) | 224 | **207** |
| Production LOC (add-in) | 55 626 | **48 933** (-6 693) |
| Test files (add-in) | 172 | **142** |
| Files deleted | — | **54** |
| LOC deleted | — | **14 450** (131 added) |

## 8. Validation

- Stage 28A PeriodIntent, 28B AnswerIntent, 28C PresentationPlan, 28D verifier,
  routing/ownership, follow-up, lifecycle, recovery, flat-records: **193/193**
- sandbox suites + mutation/result-action trace + `use-agent.test.tsx`: **334/334**
- full add-in: **2 007 passed, 27 skipped, 0 failed** (134 files)
- root `node --test`: **29/29**
- `tsc`: PASS (repo-wide). `eslint`: PASS (one pre-existing unrelated warning in
  `packages/excel-adapter-officejs`)
- No companion change, so no companion run. No live Qwen benchmark.
- Commit: `a1efae1` refactor(agent): consolidate analytical routing on v2

## 9. Remaining routing debt

1. **`routeTurn` rule 6** sends anything not positively identified as chat to
   `workbook_analysis`, so "Привет" with a table selected is an analytical turn.
   Pre-existing and unchanged by this stage; it is a general-chat precision
   question, not an engine-consolidation one. `turn-routing.test.ts` pins the
   current behaviour so a future change to it is deliberate.
2. **Two conversation state stores** still exist. The dead analytical
   `PendingClarification` members and the unwritten `SessionMemory` analytical
   refs survive until that merge — their producers are gone, so nothing sets them.
3. `countAsks` still drives a second planner loop (P1-6).
4. Two sandbox orchestration loops (P1-2 / P2-1).
5. `agent/index.ts` dead barrel and the other P1-7 dead code.
6. `use-agent.ts` is still one file holding the routing graph; physical
   decomposition is deliberately deferred.
