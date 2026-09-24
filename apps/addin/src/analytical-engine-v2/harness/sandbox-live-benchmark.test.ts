// @vitest-environment node
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { HttpChatClient } from "../../app/chat-client.js";
import { createNodeSandbox } from "./node-sandbox.js";
import { benchmarkPortfolio, PORTFOLIO_TRUTH } from "./sandbox-tables.js";
import { ALL_SANDBOX_SUITES, type SandboxQuestion } from "./sandbox-questions.js";
import { runHarnessTurn, type HarnessTableEnv, type HarnessTurnReport } from "./live-harness.js";
import { buildFailureTaxonomy, classifyAnalysisOutcome, classifyAttemptFailure, countMissingPolicy, countSecurity, countViolations, describeAnswer, mentionsEntity, stageLatency, sumCounts, unsupportedByReason, type AnalysisOutcomeClass, type AnswerShape, type FailureClass, type ViolationCounts, type ViolationDetail } from "./sandbox-scoring.js";
import type { EngineTurn } from "../engine.js";

const endpoint = process.env["SHEET_AGENT_LIVE_ENDPOINT"];
const model = process.env["SHEET_AGENT_LIVE_MODEL"];
const suite = process.env["SHEET_AGENT_LIVE_SUITE"] ?? "all";
const outFile = process.env["SHEET_AGENT_LIVE_OUT"];
const jsonFile = process.env["SHEET_AGENT_LIVE_JSON"];
const sheetFile = process.env["SHEET_AGENT_LIVE_SHEET"];
const live = Boolean(endpoint && model);

/** One turn, with everything the three §9x sections need to say about it. */
interface Scored {
  readonly question: SandboxQuestion;
  readonly report: HarnessTurnReport;
  readonly body: string;
  readonly shape: AnswerShape;
  readonly counts: ViolationCounts;
  readonly details: readonly ViolationDetail[];
  /** §3/§4 — did it go where a question of this kind should go? */
  readonly routedAs: "sandbox" | "deterministic" | "refusal" | "clarify" | "failed";
  readonly routeMatched: boolean;
  readonly mentionsFound: readonly string[];
  readonly mentionsMissing: readonly string[];
  /** Stage 27.x §14 — first-pass, repaired, or terminal. */
  readonly outcomeClass: AnalysisOutcomeClass;
  /** Stage 27.x §13 — one class per FAILED attempt, in order. */
  readonly failureClasses: readonly FailureClass[];
  readonly repairAttempts: number;
}

function routeOf(report: HarnessTurnReport, turn: EngineTurn): Scored["routedAs"] {
  // A clarifying question is its own outcome, not a failure and not an answer.
  // For a question the data cannot answer it is a perfectly good response —
  // asking what competitor data means is better than inventing some.
  if (turn.kind === "clarify") return "clarify";
  if (turn.kind === "failed") return turn.reason === "analysis_unavailable" ? "refusal" : "failed";
  return report.analysis?.requested ? "sandbox" : "deterministic";
}

function routeMatches(expected: SandboxQuestion["expectRoute"], actual: Scored["routedAs"]): boolean {
  if (actual === "failed") return false;
  if (expected === "refusal") return actual === "refusal" || actual === "clarify";
  if (expected === "either") return actual === "sandbox" || actual === "deterministic" || actual === "clarify";
  return expected === actual;
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const ms = (n: number): string => `${Math.round(n)}ms`;

describe.skipIf(!live)("Stage 27 §90 — live sandbox benchmark", () => {
  it(
    "runs the held-out sandbox questions against the real model and reports what happened",
    async () => {
      const chatClient = new HttpChatClient(endpoint!, model!);
      const table = benchmarkPortfolio();
      const env: HarnessTableEnv = { schema: table.schema, grids: table.grids };

      // §87 — sandbox startup, measured once and separately. It is a one-off
      // per session in production too, so folding it into per-question latency
      // would overstate every question's cost.
      const bootStarted = Date.now();
      const sandbox = createNodeSandbox();
      await sandbox.runtime.validate("RESULT = {}");
      const sandboxStartupMs = Date.now() - bootStarted;
      process.stderr.write(`\n  sandbox startup: ${ms(sandboxStartupMs)}\n\n`);

      const scored: Scored[] = [];

      try {
        for (const [name, questions] of Object.entries(ALL_SANDBOX_SUITES)) {
          if (suite !== "all" && suite !== name) continue;
          process.stderr.write(`  --- ${name} ---\n`);

          // The hybrid suite is a CONVERSATION: each turn sees the state the
          // previous one committed (§33). The rest are independent.
          let state = undefined as Parameters<typeof runHarnessTurn>[0]["state"];
          for (const question of questions) {
            const { report, turn, state: next } = await runHarnessTurn({
              chatClient,
              table: env,
              question,
              model: model!,
              runtime: sandbox.runtime,
              ...(name === "hybrid" && state ? { state } : {}),
            });
            if (name === "hybrid") state = next;

            const body = turn.kind === "answered" ? turn.body : turn.kind === "clarify" ? turn.question : "";
            const { counts, details } = countViolations(report, turn);
            const gapDetail = countMissingPolicy(report, question.touchesGaps === true);
            const allDetails = gapDetail ? [...details, gapDetail] : details;
            const withGaps = gapDetail ? { ...counts, missingToZero: counts.missingToZero + 1 } : counts;
            const routedAs = routeOf(report, turn);
            const attemptLog = report.analysis?.attemptLog ?? [];
            const mentions = question.expectMentions ?? [];

            scored.push({
              question,
              report,
              body,
              shape: describeAnswer(body),
              counts: withGaps,
              details: allDetails,
              routedAs,
              routeMatched: routeMatches(question.expectRoute, routedAs),
              mentionsFound: mentions.filter((m) => mentionsEntity(body, m)),
              mentionsMissing: mentions.filter((m) => !mentionsEntity(body, m)),
              outcomeClass: classifyAnalysisOutcome(attemptLog, Boolean(report.analysis?.failureCode)),
              failureClasses: attemptLog.filter((n) => !n.ok).map((n) => classifyAttemptFailure(n.errorCode, n.error ?? "", n.failureClass)),
              repairAttempts: Math.max(0, attemptLog.length - 1),
            });

            const last = scored[scored.length - 1]!;
            process.stderr.write(
              `  [${question.id}] ${report.outcome} route=${routedAs}${last.routeMatched ? "" : `(want ${question.expectRoute})`} ` +
                `attempts=${report.analysis?.attempts ?? 0} ${ms(report.elapsedMs)}\n`,
            );
          }
        }
      } finally {
        // A Pyodide worker left alive pins a core and the suite never exits.
        await sandbox.dispose();
      }

      // --- the report ------------------------------------------------------

      const latency = stageLatency(scored.map((s) => s.report));
      const totals = sumCounts(scored.map((s) => s.counts));
      const sandboxTurns = scored.filter((s) => s.report.analysis?.requested);
      const nonTrivial = scored.filter((s) => s.question.expectRoute !== "refusal" && s.report.outcome === "answered");

      const lines: string[] = [];
      const say = (line = ""): void => void lines.push(line);

      say("STAGE 27 — LIVE SANDBOX BENCHMARK");
      say(`model: ${model}`);
      say(`table: ${PORTFOLIO_TRUTH.entities} entities × ${PORTFOLIO_TRUTH.periods} periods`);
      say(`questions: ${scored.length}`);
      say();

      // Stage 27.x §16 — reliability, reported before correctness.
      //
      // The first reports had one number for this, "sandbox failure", and it
      // hid the finding that mattered most: over a third of failed attempts
      // were this engine refusing structurally valid work. Split by class, the
      // patch's target is legible — DATA_CONTRACT_ERROR and
      // VALIDATOR_FALSE_REJECTION should fall, MODEL_CODE_ERROR should become
      // what remains.
      const withAnalysis = scored.filter((x) => x.outcomeClass !== "NOT_REQUESTED");
      const byOutcome = (cls: AnalysisOutcomeClass): number => withAnalysis.filter((x) => x.outcomeClass === cls).length;
      const repairs = withAnalysis.map((x) => x.repairAttempts).sort((a, b) => a - b);
      say("--- Stage 27.x §16 reliability ---");
      say(`analyses requested          ${withAnalysis.length}`);
      say(`first-attempt success       ${byOutcome("FIRST_ATTEMPT_SUCCESS")}  (${pct(byOutcome("FIRST_ATTEMPT_SUCCESS"), withAnalysis.length)})`);
      say(`eventual success            ${byOutcome("FIRST_ATTEMPT_SUCCESS") + byOutcome("REPAIRED_SUCCESS")}  (${pct(byOutcome("FIRST_ATTEMPT_SUCCESS") + byOutcome("REPAIRED_SUCCESS"), withAnalysis.length)})`);
      say(`terminal failure            ${byOutcome("TERMINAL_FAILURE")}  (${pct(byOutcome("TERMINAL_FAILURE"), withAnalysis.length)})`);
      say(`repair attempts mean / p95  ${(repairs.reduce((a, b) => a + b, 0) / Math.max(1, repairs.length)).toFixed(2)} / ${repairs[Math.min(repairs.length - 1, Math.floor(repairs.length * 0.95))] ?? 0}`);
      say();

      // Stage 27.x.1 §31 — attempts AND questions, because they answer
      // different questions and the previous report only had the first.
      //
      // "MODEL_CODE_ERROR: 67" across five runs reads as a catastrophe until
      // you notice a question gets three attempts: one stubborn question
      // contributes three, and a question that stumbles once then succeeds
      // contributes one. Attempts measure how much WORK a class caused;
      // questions measure how much ANSWERING it cost. Only the second is
      // reliability.
      const taxonomy = buildFailureTaxonomy(
        scored.map((x) => ({
          id: x.question.id,
          attempts: (x.report.analysis?.attemptLog ?? []).map((n) => ({
            attempt: n.attempt,
            ok: n.ok,
            ...(n.errorCode ? { errorCode: n.errorCode } : {}),
            ...(n.error ? { error: n.error } : {}),
            ...(n.failureClass ? { failureClass: n.failureClass } : {}),
          })),
          terminal: x.outcomeClass === "TERMINAL_FAILURE",
        })),
      );
      say("--- Stage 27.x.1 §31 failure taxonomy (attempts | questions touched | questions terminal) ---");
      const rows = Object.entries(taxonomy.byClass).sort((a, b) => b[1].attempts - a[1].attempts);
      if (rows.length === 0) say("no failed attempts");
      for (const [cls, t] of rows) {
        say(`${cls.padEnd(28)}${String(t.attempts).padStart(4)} ${String(t.questionsTouched).padStart(11)} ${String(t.questionsTerminal).padStart(18)}`);
      }
      say(`${"TOTAL".padEnd(28)}${String(taxonomy.totalAttempts).padStart(4)} ${String(taxonomy.totalQuestions).padStart(11)}`);
      say();

      // §32 — and the security numbers apart from each other. A successful
      // rejection is the system working; filing it beside `unsafeEscapes`
      // invites the reading that the safe and unsafe outcomes are one event.
      const security = countSecurity(
        scored.map((x) => ({
          attempts: (x.report.analysis?.attemptLog ?? []).map((n) => ({
            attempt: n.attempt,
            ok: n.ok,
            ...(n.errorCode ? { errorCode: n.errorCode } : {}),
            ...(n.error ? { error: n.error } : {}),
          })),
          escaped: x.counts.unsafeEscapes > 0,
        })),
      );
      say("--- Stage 27.x.1 §32 security counters ---");
      say(`unsafe code attempts        ${security.unsafeCodeAttempts}`);
      say(`security rejections         ${security.securityRejections}   (a rejection is the system working)`);
      say(`UNSAFE ESCAPES              ${security.unsafeEscapes}   (the only one that is a defect)`);
      say();

      say("--- Stage 27.x.1 §43 per-question consistency (this run) ---");
      for (const x of scored.filter((q) => q.outcomeClass !== "NOT_REQUESTED")) {
        say(`${x.question.id.padEnd(18)}${x.outcomeClass.padEnd(24)}repairs=${x.repairAttempts}${x.failureClasses.length > 0 ? `  ${x.failureClasses.join(", ")}` : ""}`);
      }
      say("note: §43 asks for PASS n/5 across five runs; one run cannot report that. Aggregate the JSON.");
      say();

      say("--- §92 zero-tolerance counters (every one must read 0) ---");
      say(`unsupported numeric claims  ${totals.unsupportedNumericClaims}`);
      say(`silent substitutions        ${totals.silentSubstitutions}`);
      say(`unsafe sandbox escapes      ${totals.unsafeEscapes}`);
      say(`missing became zero         ${totals.missingToZero}`);
      say(`stale results presented     ${totals.stalePresentations}`);
      for (const s of scored) for (const d of s.details) say(`  ! ${d.id}  ${d.counter}: ${d.evidence}`);
      // Stage 27.x.1 §28 — and WHY each refused number was refused. A count
      // says something was rejected; the reason says whether the narrator or
      // the verifier was wrong, and those need opposite fixes. Establishing
      // that for six violations took a day of reading raw transcripts once.
      const reasons = unsupportedByReason(scored.map((s) => s.report));
      if (Object.keys(reasons).length > 0) {
        say("  unsupported-claim reasons:");
        for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) say(`    ${reason.padEnd(24)}${n}`);
        for (const s of scored) {
          for (const c of s.report.trace.unsupportedClaims ?? []) {
            say(`    ! ${s.question.id}  ${c.reason} "${c.numericToken}" attempt=${c.narratorAttempt} nearest=${c.nearestFacts.join(" ")}`);
          }
        }
      }
      say();

      say("--- §3/§4 routing fidelity ---");
      const routed = scored.filter((s) => s.routeMatched).length;
      say(`went where the question belongs   ${routed}/${scored.length}  ${pct(routed, scored.length)}`);
      for (const s of scored.filter((x) => !x.routeMatched)) say(`  ! ${s.question.id}  wanted ${s.question.expectRoute}, went ${s.routedAs}`);
      say();

      say("--- §19/§37 what the sandbox was asked for ---");
      say(`analyses requested            ${sandboxTurns.length}`);
      say(`analyses that produced a result ${sandboxTurns.filter((s) => !s.report.analysis?.failureCode).length}`);
      const attempts = sandboxTurns.map((s) => s.report.analysis?.attempts ?? 0);
      say(`first-attempt successes       ${attempts.filter((a) => a === 1).length}/${attempts.length}`);
      say(`needed repair                 ${attempts.filter((a) => a > 1).length}/${attempts.length}`);
      for (const s of sandboxTurns) {
        const a = s.report.analysis!;
        say(`  ${s.question.id.padEnd(18)} ${a.method ?? "-"} attempts=${a.attempts} methods=${a.methodsCompared ?? "-"} dims=${(a.explorationDimensions ?? []).join("/") || "-"}${a.failureCode ? `  FAILED ${a.failureCode}` : ""}`);
      }
      for (const s of scored.filter((x) => x.question.minMethodsCompared)) {
        const ran = s.report.analysis?.methodsCompared ?? 0;
        if (ran < s.question.minMethodsCompared!) say(`  ! ${s.question.id}  asked for ${s.question.minMethodsCompared} methods, ${ran} ran`);
      }
      say();

      say("--- §87 latency, median / p95 / max ---");
      for (const [label, p] of Object.entries(latency)) {
        say(`${label.padEnd(20)} ${ms(p.median).padStart(8)} ${ms(p.p95).padStart(8)} ${ms(p.max).padStart(8)}  n=${p.n}`);
      }
      say(`sandbox startup (once) ${ms(sandboxStartupMs)}`);
      say("note: `engine` is the remainder — tools, storage, verification and the state commit.");
      say();

      say("--- §93 answer shape (HEURISTIC — a screen, not a score) ---");
      const share = (f: (s: Scored) => boolean): string => pct(nonTrivial.filter(f).length, nonTrivial.length);
      say(`direct conclusion  ${share((s) => s.shape.hasDirectConclusion)}`);
      say(`explanation        ${share((s) => s.shape.hasExplanation)}`);
      say(`evidence (number)  ${share((s) => s.shape.hasEvidence)}`);
      say(`caveat present     ${share((s) => s.shape.hasCaveat)}`);
      say(`RAW-DUMP RATE      ${share((s) => s.shape.looksLikeRawDump)}   (§93 target < 5%)`);
      for (const s of nonTrivial.filter((x) => x.shape.looksLikeRawDump)) say(`  ! ${s.question.id} reads like a dump`);
      for (const s of scored.filter((x) => x.question.expectCaveat && !x.shape.hasCaveat)) say(`  ! ${s.question.id} needed a caveat and carried none`);
      say();

      say("--- ground truth mentioned ---");
      for (const s of scored.filter((x) => (x.question.expectMentions ?? []).length > 0)) {
        say(`${s.question.id.padEnd(18)} found ${s.mentionsFound.length}/${(s.question.expectMentions ?? []).length}${s.mentionsMissing.length > 0 ? `  missing: ${s.mentionsMissing.join(", ")}` : ""}`);
      }
      say();

      say("--- answers ---");
      for (const s of scored) {
        say(`[${s.question.id}] ${s.question.text}`);
        say(s.body === "" ? `  (no answer — ${s.report.outcome})` : s.body.split("\n").map((l) => `  ${l}`).join("\n"));
        say();
      }

      const text = lines.join("\n");
      process.stderr.write(`\n${text}\n`);
      if (outFile) writeFileSync(outFile, text, "utf8");

      if (jsonFile) {
        writeFileSync(
          jsonFile,
          JSON.stringify(
            {
              model,
              sandboxStartupMs,
              truth: PORTFOLIO_TRUTH,
              latency,
              violations: totals,
              turns: scored.map((s) => ({
                id: s.question.id,
                question: s.question.text,
                expectRoute: s.question.expectRoute,
                routedAs: s.routedAs,
                routeMatched: s.routeMatched,
                outcome: s.report.outcome,
                stages: s.report.stages,
                analysis: s.report.analysis ?? null,
                shape: s.shape,
                counts: s.counts,
                details: s.details,
                mentionsMissing: s.mentionsMissing,
                body: s.body,
                trace: s.report.trace,
              })),
            },
            null,
            2,
          ),
          "utf8",
        );
      }

      // §91 — the sheet a PERSON fills in. Seven dimensions, never collapsed,
      // deliberately left blank: a benchmark that pre-filled them would be
      // marking its own work.
      if (sheetFile) {
        const header = ["id", "question", "answer", "A_numeric", "B_fulfilment", "C_usefulness", "D_explanation", "E_readability", "F_unsupported", "G_method_transparency", "notes"];
        const esc = (v: string): string => `"${v.replace(/"/g, '""')}"`;
        const rows = scored.map((s) => [s.question.id, s.question.text, s.body, "", "", "", "", "", "", "", ""].map(esc).join(","));
        writeFileSync(sheetFile, [header.join(","), ...rows].join("\n"), "utf8");
        process.stderr.write(`\n  §91 evaluation sheet written to ${sheetFile} — score A–G separately, 1–5.\n`);
      }

      // The only assertion: the run completed and produced something to read.
      expect(scored.length).toBeGreaterThan(0);
    },
    60 * 60 * 1000,
  );
});
