# Stage 28F — state & registry consolidation

**Result: PASS.** Two stores remain by design, with clean and disjoint
ownership; the analytical question has exactly one owner. Two tool registries
remain because they serve two data domains. Per section 23 that is reported as
what each owns rather than faked into a 1.

Baseline: `a1efae1` + `3e8884d` (2007 passed / 27 skipped / 0 failed).

---

## 1. State audit, re-measured post-28E

Every stored concept, its writers and its readers as they actually were at
`a1efae1`.

| CONCEPT | STORE(S) BEFORE | WRITERS | READERS | UNIQUE INVARIANT | OWNER | ACTION |
|---|---|---|---|---|---|---|
| current table | V2 `tableRef`; V1 `lastAnalyticalTable` | V2 engine; **V1: none** | V2 refs/freshness; V1: one dead `general_chat` guard + debug | freshness token per range | **V2** | V1 field REMOVED |
| last metric | V2 `lastMetric`; V1 `lastMetricFocusRef` | V2 engine; **V1: none** | V2 `reference.last_metric`; V1: debug only | single-metric focus | **V2** | V1 field REMOVED |
| last metric set | V2 `lastMetricSet`; V1 `lastMetricSetRef` | V2 engine; **V1: none** | V2 `reference.last_metric_set`; V1: debug only | **narrowest-set rule** | **V2** | V1 field REMOVED |
| last period | V2 `lastPeriod`; V1 `lastPeriodRef` | V2 engine; **V1: none** | V2 `reference.last_period`; V1: debug only | canonical endpoints + lineage | **V2** | V1 field REMOVED |
| last period pair | V2 `lastPeriodRange`; V1 `lastCompositeRef` | V2 engine; **V1: none** | V2 `reference.last_period_range`; V1: debug only | both endpoints resolved together | **V2** | V1 field REMOVED |
| last event | V2 `lastEvent`; V1 `lastEventRef`, `lastDirectionChangeRef` | V2 engine; **V1: none** | V2 `reference.last_event`; V1: debug only | event projects to its metric and periods | **V2** | V1 fields REMOVED |
| last ranking / result set | V2 `lastAnalysis`, `recentResults`; V1 `lastRankingRef`, `lastResultSetRef`, `lastAnalyticalResultSetRef` | V2 engine; **V1: none** | V2 `reference.last_analysis` / `reference.recent`; V1: debug + one dead guard | deterministic recency order | **V2** | V1 fields REMOVED |
| `ResultRef` | V1 only | V2→V1 bridge, grouped ranking, transforms, flat agent | Preview/Approve, result actions, reference resolution | Preview → Approve → Undo identity | **V1 (mutation)** | KEPT |
| `RowSetRef` | V1 only | grounding | highlight / copy | grounded source rows | **V1 (mutation)** | KEPT |
| `ChartRef`, `SheetRef` | V1 only | chart insert; **`rememberSheet`: no caller** | chart placement, undo reconciliation | placement identity | **V1 (mutation)** | KEPT (see debt) |
| follow-up references | V2 typed refs; V1 `resolveReference` | V2 engine; V1 result/rowset/chart | V2 planner; V1 result actions | analytical refs are typed, never labels | **split by domain** | V1 narrowed to mutation targets |
| clarification | V2 `SuspendedPlannerState`; V1 `PendingClarification` (14 kinds) | V2 engine; V1 chart/column/entity/dataset/agent | both loops | analytical resume without recompute | **V2 for analytical** | 5 analytical kinds REMOVED |
| freshness | V2 `sourceVersion` + `RefLineage`; V1 `revalidateSource` | — | — | V2: per-range lineage; V1: per-result revalidation before a write | both, different jobs | KEPT |
| lineage | V2 `RefLineage`, `EngineResult.parents` | V2 engine | V2 refs | provenance of every ref | **V2** | KEPT |
| resolved entities | V1 `resolvedEntities` | **none anywhere, tests included** | one always-empty read | — | — | REMOVED |

The decisive measurement: **ten analytical reference fields and their ten
`remember*` writers had zero production writers** at `a1efae1` — their only
writers (`runAnalyticalRoute`, `commitPlannerOutputs`) went with Stage 28E. Their
only readers were the `__sessionMemoryDebug` projection and one dead
`general_chat` guard that could never fire.

## 2. What changed — state

- `SessionMemory` fields **19 → 8**: `recentResults`, `lastResultId`,
  `lastRowSet`, `lastChart`, `lastCreatedSheet`, `pendingClarification`, `seq`,
  `knownIds`. Every one is a mutation concern.
- Reference types in the mutation store **20 → 7**.
- `remember*` writers **16 → 5**; the ten analytical mirrors are gone.
- `ClarificationKind` **14 → 6**: `column_ambiguous`, `dataset_ambiguous`,
  `reference_ambiguous`, `chart_columns`, `agent`, `entity_action`. Every
  surviving kind belongs to a mutation, a chart or the flat-records agent.
  `analytical_agent`, `schema_norm`, `schema_threshold`, `analysis_subject`,
  `analysis_period` are gone with their producers, resume branches and answer
  interpretation; `sheet_ambiguous`, `missing_data` and `reference_missing` had
  never had a producer.
- Clarification builders **10 → 6**; `buildAgentClarification` lost the
  `"agent" | "analytical_agent"` selector.
- The dead `analyticalContinuationStanding` guard is gone. It read two fields
  nothing wrote, so it was always false: removing it is behaviour-identical, and
  the invariant it once protected is now `classifyTurnOwner`'s, which reads V2's
  own table state.

**Correction to the plan.** P1-5 item (a) was "the V2→V1 bridge stops writing
`facts: []` — it carries the verified findings". `ResultRef.facts` is written in
four places and **read in none**; carrying findings across would have added a
field with no consumer, which section 7 forbids. The bridge still writes
`facts: []`, and `ResultRef.facts` is recorded as remaining debt for whoever
either gives it a reader or deletes it.

## 3. Registry audit, re-measured post-28E

| REGISTRY / PROJECTION | CONTAINS | WRITTEN BY | READ BY | UNIQUE RESPONSIBILITY | OVERLAP |
|---|---|---|---|---|---|
| `tools/registry.ts` → `V2_TOOLS` | 39 `ToolSpec` — name, description, capability, args, returns, accepts, reads, usable, run | the seven per-category tool modules | everything below | **the authoritative metadata** | none |
| `capability/capability-index.ts` | capability → tools, name → tool, descriptors | derived from `V2_TOOLS` | selection, prompt view | grouping | none (derived) |
| `capability/capability-selection.ts` | which capabilities this turn exposes | derived from facts + index | prompt view | dynamic exposure | none (derived) |
| `capability/tool-context.ts` | the planner prompt's tool text | derived | planner loop | tiered contract/descriptor rendering | none (derived) |
| `capability/agent-tools.ts` | `DeterministicTool` for the sandbox agent loop | derived | `iterative-runner` (flag-off) | agent-loop shape | none (derived) |
| `context/build-context.ts` | the FULL catalogue text + model | derived | telemetry baseline, tests | full-registry serialization | **had its own copy of every rule** |
| `agent/tool-registry.ts` | 13 flat-records tools | itself | flat agent | **the records / cross-sheet domain** | none — disjoint names |

The finding is not four registries. The metadata source was already one
(`ToolSpec`); the **projection logic was written four times**: `signatureOf` in
`tool-context.ts`, `agent-tools.ts` and inline in `build-context.ts`, plus
`summarizeArgs` as a fourth spelling in `capability-index.ts`; and the
shared-argument algorithm twice (`sharedArgsOf` and `catalogModel`). Four copies
of a rule can drift; a test now forbids a fifth.

## 4. What changed — registry

- New `tools/projection.ts` — the ONE projection of `ToolSpec`: `signatureOf`,
  `argSummaryOf`, `sharedArgumentsOf`, `sharedArgumentKeys`, `ownArgLinesOf`,
  `projectTools`.
- `capability-index.ts`, `capability/tool-context.ts`,
  `capability/agent-tools.ts` and `context/build-context.ts` all project from it.
  `CatalogEntry` / `CatalogModel` are now aliases of the projection types, so
  the full catalogue and the prompt view cannot render a tool differently.
- Dynamic capability exposure is unchanged and still derived; the prompt still
  carries a tiered subset, and `registry-ownership.test.ts` pins that it exposes
  strictly fewer tools than the registry holds and leaks no unexposed name.
- The flat-records registry is untouched and stays its own domain. A test
  asserts no name is claimed by both and that V2 advertises no records
  capability (`row_records`, `group_by`, `filter_rows`).

## 5. Dead code removed (evidence per deletion)

| REMOVED | EVIDENCE |
|---|---|
| `agent/index.ts` (32 LOC) | `grep` for `agent/index` → 0 importers anywhere |
| `app/qwen-key-store.ts` + test (22 LOC) | only its own test imports it; the companion stores `LLM_API_KEY` via DPAPI in `CredentialStore.cs` / `Program.cs` |
| 10 analytical ref types + 10 writers + 4 clarification builders | zero production writers, zero non-debug readers (section 1) |
| `resolvedEntities`, `mergeResolved`, `rememberResolved`, `ResolvedWorkbookRef` | `rememberResolved` has no caller anywhere, tests included |
| 5 `ClarificationKind` members + their interpret branches | no producer after 28E, or never had one |
| 4 duplicate projection helpers | replaced by `tools/projection.ts` |
| `tools/compatibility-matrix.gen.ts` + test → `harness/` | one importer, its own test; the audit's own recommendation |

`SheetRef` / `lastCreatedSheet` / `rememberSheet` are also provably dead
(`rememberSheet` had no caller even before 28E) but were **left alone**: they sit
inside the mutation store that section 20 freezes, they are not duplicated with
V2, and `resolveReference`'s sheet branch and the undo reconciliation touch them.
Recorded as debt rather than risked for no consolidation benefit.

## 6. Required tests

`analytical-engine-v2/state-ownership.test.ts` (28 tests) covers items 1-9:
one consistent committed state per turn; a follow-up on "эти три" resolving
exactly the three the ranking named; staleness when the table moves on; period
provenance; clarification suspend carrying its computed results; suspension
dropped across a moved table; every removed field asserted to have no production
reader or writer (20 parameterised cases); an empty session memory holding only
`recentResults`, `seq`, `knownIds`; and no analytical key of the committed state
appearing in the mutation store.

`analytical-engine-v2/registry-ownership.test.ts` (17 tests) covers items 1-8:
no duplicate tool name; every planner-visible tool is a registry tool; every
tool in exactly one declared capability; the index as a projection, not a second
list; every projected field traced to the spec; the full catalogue and the
capability view rendering identically; one shared-argument implementation; the
exposed subset derived and smaller; no leak of an unexposed name; the validator
agreeing with the schema on required-ness, unknown arguments and unknown tools;
the flat-records registry disjoint; and no production module declaring its own
signature or shared-argument renderer.

Mutation / result-action and Preview→Approve→Undo behaviour is covered by the
unchanged `use-agent.test.tsx`, `result-action-trace.test.ts` and
`use-agent-flat-records.test.tsx`.

## 7. Complexity metrics

| METRIC | BEFORE | AFTER |
|---|---|---|
| Conversation state stores | 2, modelling the same concepts | **2, disjoint domains** |
| Stores answering "what were we just talking about" analytically | 2 | **1** |
| `SessionMemory` fields | 19 | **8** |
| Reference types in the mutation store | 20 | **7** |
| Mirrored analytical writers | 10 | **0** |
| Clarification lifecycles (analytical) | 2 | **1** |
| `ClarificationKind` members | 14 | **6** |
| Clarification builders | 10 | **6** |
| Mutation-store LOC (`session-memory` + `conversation-memory`) | 1 340 | **766** |
| V2 state LOC | 701 | **701** (unchanged) |
| Tool registries | 2 (39 V2 + 13 flat-records) | **2** (unchanged, disjoint) |
| Authoritative tool metadata definitions | 1 (`ToolSpec`) | **1** |
| Duplicate projection implementations | **4** | **1** |
| Capability projections | 4 views, each with its own renderer | **4 views, all derived** |
| Registry + capability + projection LOC | 680 | 717 (+`projection.ts` 75, −38 duplicated) |
| `context/build-context.ts` LOC | 211 | **171** |
| `use-agent.ts` | 3 075 LOC / 59 imports | **2 969 LOC / 58 imports** |
| Production files (add-in) | 207 | **207** |
| Production LOC (add-in) | 48 933 | **48 172** |
| Files deleted | — | **3** (+2 moved to harness) |
| LOC removed | — | **893** (471 added: two test suites + `projection.ts`) |

Registry LOC is flat by design: the win is four rules becoming one, not fewer
lines — the audit's own target was "fewer concepts, not fewer lines".

## 8. Validation

- full add-in: **2 035 passed, 27 skipped, 0 failed** (135 files)
- focused batch (Stage 28A period, 28B AnswerIntent, 28C PresentationPlan, 28D
  narration, 28E routing, lifecycle, recovery, state-ownership,
  registry-ownership, conversation-memory, result-action trace, use-agent,
  stage-26-8, stage-27-7, flat-records): **365/365**
- new state tests: **28/28** · new registry tests: **17/17**
- root `node --test`: **29/29**
- `tsc`: PASS repo-wide · `eslint`: PASS (one pre-existing unrelated warning in
  `packages/excel-adapter-officejs`)
- No companion change, so no companion run. No installer build. No live Qwen.
- Commit: `c3745ab` refactor(agent): consolidate state and tool ownership

## 9. Remaining debt

1. **Two stores, by design.** The analytical store (`analytical-engine-v2/state/`)
   owns what the conversation is about; the mutation store
   (`session-memory` + `conversation-memory`) owns what a write would act on —
   `ResultRef` identity for Preview→Approve→Undo, `RowSetRef`, `ChartRef`,
   `SheetRef`, and the chart/column/entity/dataset clarifications. Merging them
   would put V2's read-only analytical state in charge of workbook writes, which
   is the opposite of the read-only boundary. **Prerequisite for one store:** V2
   would have to own mutation, which it deliberately does not.
2. **Two registries, by domain.** 39 V2 tools over a metric `TableSchema`; 13
   flat-records tools over a records list and across sheets. **Prerequisite:** the
   records capability named in the Stage 28E report.
3. `ResultRef.facts` is written four times and read nowhere.
4. `SheetRef` / `lastCreatedSheet` / `rememberSheet` are unreachable but live
   inside the frozen mutation store.
5. `routeTurn` rule 6 still sends unidentified text with a selected table to
   `workbook_analysis` — pinned by `turn-routing.test.ts`, untouched here.
6. `countAsks` still drives a second planner loop.
7. Two sandbox orchestration loops, and `capability/agent-tools.ts` exists only
   for the flag-off one — Stage 28G.
8. `use-agent.ts` still holds the routing graph in one file.
