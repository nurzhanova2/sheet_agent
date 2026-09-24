# Handoff — Stage 27.8

Authoritative resume document. Read this and `documentation/CURRENT_STATE.md`
before changing anything.

---

# 1. PROJECT

**Sheet Agent** is an Excel Office.js task-pane add-in that acts as a
conversational analyst over the user's selected table.

- **Add-in**: `apps/addin` — TypeScript / React / Vite, served to Excel's
  WebView2 from the local companion.
- **Companion**: `apps/windows-companion` — .NET 8 WinForms tray app hosting
  Kestrel on `https://localhost:47831`. It serves the add-in's `wwwroot`,
  proxies chat to the Qwen deployment (`Qwen/Qwen3.5-35B-A3B-FP8`), and stores
  the API key in DPAPI.
- **Analysis**: an LLM **planner** chooses among ~51 **deterministic tools**
  (exact, TypeScript, sub-millisecond) and, for operations no tool performs, a
  **Python/Pyodide sandbox** (numpy, pandas, scipy, scikit-learn) running in a
  module Worker with an AST allow-list validator. Pyodide is vendored locally;
  there is no CDN path.
- **Grounding**: results become **verified findings**; answers may only state
  what those findings prove. Numeric claims are resolved against facts,
  causal claims are rejected.
- **Mutations** never come from the model: they go through
  Preview → Approve → Execute → Undo.

---

# 2. CURRENT STATUS

**Stage 27.7 — PASS. Manual Excel verification has been performed.**

Latest installer: `artifacts/installer/SheetAgentSetup-x64.exe`

```
SHA-256: d120d4d9f7eb2a2d6be5996ef0bacb1d5c323617dbe8a05794de26d9a5c6f1ea
Size:    87,469,534 bytes
```

| Gate | Result |
|---|---|
| Add-in tests | **2348 passed**, 27 skipped |
| tsc | clean |
| eslint | clean |
| Companion tests | **17 passed** |
| Pyodide / WebView2 sandbox | **works in real Excel** |

Handoff for that installer:
`documentation/stages/stage27_7/INSTALLER_HANDOFF.md`
Stage report: `documentation/stages/stage27_7/stage27_7_real_excel_performance.md`

---

# 3. AUTHORITATIVE ARCHITECTURE

The current production path, and the only one to reason about:

```
user message
  → turn ownership          production/turn-owner.ts   classifyTurnOwner
  → workbook read + schema  app/schema/schema-induction.ts
  → engine                  analytical-engine-v2/engine.ts
      → planner loop        planner/planner-loop.ts
          → deterministic tools   tools/registry.ts        (51 specs)
          → Python sandbox        sandbox/analysis-runner.ts → executor.ts
      → verification        verification/coverage-verifier.ts
      → findings            insight/extract-findings.ts → VerifiedFinding
      → answer composition  narration/narrator.ts
      → grounding gate      narration/answer-evaluator.ts, presented-claims.ts
  → transcript              taskpane/use-agent.ts → components/AgentTranscript.tsx
```

Who owns what:

| Layer | Owns | File |
|---|---|---|
| Turn ownership | whether V2 handles the turn at all | `production/turn-owner.ts` |
| **Planner decisions** | which tool, in what order, over which result; when to use the sandbox; which result is the principal answer | `planner/planner-loop.ts` + `planner/planner-prompt.ts` |
| **Deterministic calculation** | every number read from the workbook | `tools/*.ts`, executed by `tools/validator.ts` |
| **Sandbox execution** | generated Python, its validation, retries, result normalisation | `sandbox/analysis-runner.ts`, `sandbox/executor.ts`, `sandbox/worker-runtime.ts` |
| **Findings** | turning verified rows into typed observations with units and materiality | `insight/extract-findings.ts`, `insight/statement.ts` |
| **Verification** | coverage of declared outputs; numeric/causal grounding of the answer text | `verification/coverage-verifier.ts`, `narration/answer-evaluator.ts` |
| **Narration** | deterministic rendering first, LLM narrator for the rest | `narration/narrator.ts` (`deterministicAnswerPlan`, `renderDeterministic`) |
| **Execution UI** | live steps, collapse, timings, diagnostics | `production/execution-progress.ts`, `production/progress-labels.ts`, `taskpane/use-agent.ts`, `components/ExecutionSummary.tsx` |

Feature flags: `VITE_UNIFIED_ANALYTICAL_ENGINE_V2` **ON**,
`VITE_ANALYTICAL_AGENT_LOOP` **OFF** (keep it off).

Legacy note: the Stage 24 schema path in `taskpane/use-agent.ts` is still
reachable and **still answers «О чем эта таблица?»** via
`app/schema/schema-result.ts → describeSchema`. That is not dead code; see §5.

---

# 4. STAGE 27.7 CHANGES THAT MUST NOT BE REDONE

All of the following are complete, tested and shipped. Do not redesign them
casually; extend them.

1. **WebView2/Pyodide root cause: the companion did not serve `.whl` at all.**
   ASP.NET Core has no `.whl` content-type mapping and does not serve unmapped
   extensions, so all 9 Python wheels returned **404**. Pyodide booted and then
   died fetching numpy.
2. **Fix**: `apps/windows-companion/Program.cs` declares `.whl`, `.mjs`,
   `.wasm`, `.zip` via an explicit `FileExtensionContentTypeProvider`.
   `ServeUnknownFileTypes` stays **off**. **No CDN fallback** — the runtime is
   the vendored local copy and must stay that way.
3. **Release gate**: `installer/tests/Assert-SandboxAssetsServable.ps1`, wired
   into `installer/build-installer.ps1` after the companion publish and before
   Inno Setup. It boots the published companion against the real install layout
   and requests **every** shipped file over TLS (status 200, matching
   `Content-Length`, non-empty `Content-Type`). Against the old companion it
   reproduces the 9 × 404.
4. **`new Worker(new URL("./sandbox-worker.ts", import.meta.url), …)` must stay
   written inline.** Moving that expression into a helper makes Vite emit no
   worker chunk at all. This was hit and reverted in 27.7.
5. **Planner `"final": true`** on a `tool_call` — the planner declares that the
   call produces the principal answer, so the turn ends on its result without a
   separate `complete` round. Refused when the plan declared several outputs or
   the result cannot structurally answer.
6. **Redundant planner rounds removed**: `change.compare_periods` /
   `change.compute` have period defaults, and the prompt's
   `FINISHING IN ONE STEP` section tells the planner the periods and metrics are
   already listed. Measured 4 rounds + 1 narration → 1 round + 0 narration, with
   identical results asserted.
7. **Deterministic-first answers**: `deterministicAnswerPlan` selects the simple
   shapes and `renderDeterministic` writes them without a narrator call. The
   grounding evaluator still runs on that text; failure falls through to the
   model. `narratorStatus` is now `deterministic` / `verified` / `fallback`.
8. **Execution steps collapse** into one expandable `✓ Готово за N с ▸` placed
   where the steps were, above the answer.
9. **Real timing metrics**: `plannerRounds`, `plannerMs`, `toolMs`,
   `codeGenerationMs`, `sandboxMs`, `narrationMs`, `verificationMs`,
   `llmCallCount`, `toolCallCount`, `pythonExecutionCount`. `addSandbox` and
   `addCodeGeneration` had **no call sites** before 27.7; they do now.
10. **Python stays visible**: every attempt's code, the error type and one-line
    message, the retry and the output summary live inside the collapsed block.
11. **Latest-vs-previous support exists in the tools** —
    `periodPairDefaults` in `tools/semantic-refs.ts`. See §6: it is not
    engaging in production.
12. **Sandbox startup diagnostics**: stage (`worker_construction` /
    `worker_load` / `runtime_boot` / `boot_timeout`), reason, asset, index URL,
    module URL, origin, `document.baseURI`, worker type — surfaced in the
    expandable block. Boot is bounded at 120 s.
13. **The sandbox works in real Excel.** Confirmed by the manual test in §5.

---

# 5. REAL EXCEL RESULTS AFTER STAGE 27.7

Manual test, Stage 27.7 installer (`d120d4d9…`), balance table.

**1. «О чем эта таблица?»**
Answer is still mechanical / schema-like.

**2. «На сколько выросли активы?»**
3.3 s — fast. **Wrong period**: compared `01.01.2024 → 01.12.2025`, reported
`+32.98%`.

**3. «Как изменились активы относительно предыдущего периода?»**
6.6 s. **Wrong period**: again `01.01.2024 → 01.12.2025` instead of the
immediately previous period.

**4. «Какой показатель самый волатильный?»**
6.1 s. Answer: *Самый волатильный показатель — обратное РЕПО*, score `5.2`.
Explanation still mechanical; the meaning of `5.2` is unclear to the reader.

**5. «Проведи кластеризацию показателей по динамике.»**
130 s. **The Python sandbox WORKED** — 2 Python runs. The answer returned
technical cluster labels `Cluster_0`, `Cluster_1`, `Cluster_2` with a weak
explanation.

Two things this tells us beyond the list:

- The 27.7 sandbox fix landed. Case 5 is the proof.
- The 27.7 "state both dates" change also landed — **that is how the wrong
  period became visible at all.** Before 27.7 no answer named its dates, so the
  selection bug was invisible. The reporting is correct; the selection is not.

---

# 6. WHAT IS NOW ACTUALLY BROKEN

Three separate problems. Do not merge them.

## BUG — production period selection is wrong

For natural requests such as «предыдущий период» and «на сколько выросли
активы», production ends up comparing **first vs last** across the whole
history instead of the latest comparable period against the one before it.

The tools support latest-vs-previous (`periodPairDefaults`,
`tools/semantic-refs.ts:137`), but that default **only fires when both
endpoints are absent from the call**:

```ts
const hasStart = args["startPeriod"] !== undefined || args["startPeriodRef"] !== undefined;
const hasEnd   = args["endPeriod"]   !== undefined || args["endPeriodRef"]   !== undefined;
if (hasStart && hasEnd) return args;
```

Leading hypothesis: **the planner supplies explicit endpoints** — it reads the
period list out of the TABLE context block (rendered oldest-first by
`context/build-context.ts:buildTableBlock`) and passes the first and last
canonical strings, so the default never engages. Alternatives to rule out: a
`series.get` / `analysis.trend` route producing a whole-history finding, or a
`reference.last_period*` slot resolving to a range.

**Verify before fixing.** `/debug analytical-engine` prints every round as
`TOOL CALL <tool> <arguments JSON>` (`debug/analytical-trace.ts:288`). One real
turn's trace settles which of the above it is. Do not guess.

This is a **production selection / planner-argument** bug, not a tool bug.

## QUALITY PROBLEM — answers read like serialized analytical results

Preserve these exact examples as the target of Stage 27.8:

- `Рост «Активы» составил...`
- `По используемой метрике его оценка волатильности — 5,2`
- `Cluster_0 — ...`
- `В таблице 19 показателей за 15 периодов...`

One concrete structural cause worth knowing: `computeVolatility`
(`app/schema/analytical/temporal-primitives.ts:134`) already returns
`method` (`std_pct_change` / `std_level_change`), `periods`, `largestSwing`,
`largestSwingFrom`, `largestSwingTo` — and the `analysis.volatility` tool
(`tools/temporal-event-tools.ts:71`) **keeps only `metric` and `score` and
throws the rest away**. The evidence needed to explain `5.2` exists upstream
and is discarded before it reaches a finding. Expect more of this pattern.

## PERFORMANCE PROBLEM — sandbox latency

Simple deterministic turns are now **acceptable: ~3–7 s**. That objective is
met.

Sandbox clustering took **130 s with 2 Python runs**. The breakdown is
recorded per turn (`sandboxMs`, `codeGenerationMs`, `llmCallCount`) and is
visible in the collapsed execution block — read it before optimising anything.

---

# 7. NEXT STAGE

**Stage 27.8 — Financial Analytical Note Composer & Period Correctness**

The goal is **not** longer answers and **not** chattier answers.

The target style is a short **financial analytical note**:

```
conclusion → evidence → decomposition/comparison → analytical takeaway
```

It should read like a concise note a financial analyst writes for a manager.

**Balance overview** — explain the economic meaning of the table, identify the
main balance areas, mention the relevant time horizon, say what the table lets
us understand. Do **not** lead with row counts, header depth or schema details.

**A change** — lead with the actual movement; state absolute and relative
change; state the **correct** period; add grounded context if available;
optionally identify which components explain the move.

**Volatility** — name the most volatile metric, identify the actual volatility
method, explain what the metric means. Avoid a bare "score 5.2" unless the
method and unit are explained.

**Clustering** — do not expose `Cluster_0/1/2` as the main answer. Describe the
groups by their behaviour, identify the unusual group or outlier, and explain
what distinguishes them using only grounded evidence.

**Rankings / anomalies / trends** — analytical conclusion first, then evidence,
then comparison and context.

---

# 8. IMPORTANT DESIGN PRINCIPLE FOR 27.8

**Do not solve this with one larger narrator prompt.** The problem is
structural: the composer is handed per-finding sentences, so it can only
serialise them.

Introduce a **semantic intermediate representation** for note composition:

```
VerifiedFinding / EngineResult
  → AnalyticalNoteFact / AnalyticalNoteStructure
  → Financial Analytical Note Composer
  → verifier
  → answer
```

The semantic layer should carry meaningful fields — names may differ after
inspection:

```
analysisType      subject            period          periodComparison
relativeChange    absoluteChange     rank            method
methodMeaning     groupCount         groupMembers    groupCharacteristics
outlier           comparison         supportingEvidence
takeawayCandidates
```

`VerifiedFinding` (`insight/verified-finding.ts:194`) already has
`detail?: Readonly<Record<string, unknown>>` documented as *"Free-form
structured extras a finding type needs (method, parameters, …)"*.
**Extend that rather than building a parallel result system.** Only add a new
type where `VerifiedFinding` genuinely cannot carry the shape.

The grounding gate stays in front of the answer. The composer produces prose
from semantic facts; the verifier still checks every number and refuses causal
claims.

---

# 9. PERIOD CORRECTNESS REQUIREMENT

Hard requirement.

For **«Как изменились активы относительно предыдущего периода?»** the system
must choose the **latest available comparable period** vs the **immediately
previous comparable period**.

For **«На сколько выросли активы?»** prefer the latest/current workbook
comparison when the table clearly exposes it.

If ambiguity remains, the answer must **explicitly state which comparison was
used**.

**Never silently compare first vs last across the whole history** unless the
user asked for the whole period.

---

# 10. ANSWER STYLE REQUIREMENTS

Tone: concise financial note, conclusion-first.

Forbidden:

- raw schema language ("иерархический отчёт", "заголовок занимает N строк")
- internal field names
- technical cluster IDs in the main answer
- unnecessary quotes around metric names
- «по используемой метрике» unless the actual method is named
- unsupported causes
- chatty filler, «я проанализировал»
- generic recommendations that add nothing

Typical length:

| Answer | Length |
|---|---|
| simple change | 2 short paragraphs |
| ranking | short lead + 3 items + one takeaway |
| overview | 2–3 paragraphs |
| clustering / exploration | 3–5 short analytical paragraphs or findings |

---

# 11. CURRENT DEBT

None of these are fixed.

| Tag | Meaning |
|---|---|
| `SANDBOX_CODEGEN_RELIABILITY` | generated Python still needs retries; failure classes are recorded but not eliminated |
| `EXTRACTOR_QUALITY_DEBT` | the insight extractor draws no finding from some correct results, so the answer is thin |
| `PERIOD_RESOLUTION_PRODUCTION_BUG` | **new** — production compares first vs last for "previous period" and "на сколько выросли" requests (§6) |
| `FINANCIAL_NOTE_COMPOSITION_GAP` | **new** — answers serialise findings instead of composing an analytical note (§6, §7) |
| `SANDBOX_LATENCY_DEBT` | **new** — clustering took 130 s with 2 Python runs (§6) |

---

# 12. DO NOT DO

- Do **not** start the Stage 28 refactor.
- Do **not** add another planner.
- Do **not** create keyword routing.
- Do **not** weaken grounding.
- Do **not** weaken sandbox security.
- Do **not** replace Pyodide with a CDN.
- Do **not** rerun old broad Qwen benchmark suites.
- Do **not** redesign the working Stage 27.7 execution UX.
- Do **not** make answers merely longer.
- Do **not** solve this only by prompt engineering.

---

# 13. FIRST ACTIONS FOR THE NEXT AI

1. Read this handoff and `documentation/CURRENT_STATE.md`.
2. Inspect the actual production period-selection path — start from a real
   `/debug analytical-engine` trace, then `planner/planner-prompt.ts`,
   `context/build-context.ts:buildTableBlock`, `tools/semantic-refs.ts`.
3. Reproduce and fix the first-vs-last bug, with a test that fails before the
   fix.
4. Inspect `insight/verified-finding.ts`, `insight/extract-findings.ts` and
   `narration/narrator.ts` to see what evidence already exists and what is
   discarded on the way (see the volatility example in §6).
5. Design the **smallest** semantic analytical-note representation that carries
   that evidence, extending `VerifiedFinding.detail` where possible.
6. Implement Stage 27.8 narrowly, run the normal gates, and build an installer
   for manual Excel review.

---

# 14. RESUME PROMPT

Read documentation/HANDOFF_STAGE_27_8.md and documentation/CURRENT_STATE.md.

Continue with Stage 27.8 — Financial Analytical Note Composer & Period Correctness.

Do not repeat completed Stage 27.7 work.
Inspect the repository before changing architecture.
Fix production period correctness first.
Then implement the smallest structural change required to produce concise financial analytical notes from verified evidence.
Do not begin Stage 28.
