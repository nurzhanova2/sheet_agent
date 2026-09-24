RESUME HERE
documentation/HANDOFF_STAGE_27_8.md is the authoritative resume document.
Read it first. This file is the short status summary only.

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
