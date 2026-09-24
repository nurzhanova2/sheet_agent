// @vitest-environment node
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { HttpChatClient } from "../../app/chat-client.js";
import { createNodeSandbox } from "./node-sandbox.js";
import { benchmarkPortfolio } from "./sandbox-tables.js";
import { benchmarkOperations } from "./benchmark-tables.js";
import { ANSWER_CASES, TARGETED_CASE_IDS, type AnswerCase } from "./answer-quality-questions.js";
import { runHarnessTurn, type HarnessTableEnv, type HarnessTurnReport } from "./live-harness.js";
import { countMissingPolicy, countViolations, type ViolationCounts } from "./sandbox-scoring.js";
import type { AnswerQualityTrace } from "../debug/analytical-trace.js";
import type { EngineTurn } from "../engine.js";

const endpoint = process.env["SHEET_AGENT_LIVE_ENDPOINT"];
const model = process.env["SHEET_AGENT_LIVE_MODEL"];
const outFile = process.env["SHEET_AGENT_ANSWER_OUT"];
const suite = process.env["SHEET_AGENT_ANSWER_SUITE"] ?? "targeted";
const live = Boolean(endpoint && model);

const NEWLINE = String.fromCharCode(10);
const RULE = "=".repeat(74);

interface Scored {
  readonly probe: AnswerCase;
  readonly report: HarnessTurnReport;
  readonly outcome: EngineTurn["kind"];
  readonly body: string;
  readonly counts: ViolationCounts;
  readonly quality?: AnswerQualityTrace;
  readonly elapsedMs: number;
}

const ZERO_QUALITY: AnswerQualityTrace = {
  extractedFindings: 0,
  visibleGroundedFindings: 0,
  heldFindings: 0,
  unnamedSubjectFindingsHeld: 0,
  heldByFindingType: {},
  heldByReason: {},
  held: [],
  answerShape: "n/a",
  narratorDrafts: 0,
  narrationGateRejects: 0,
  answerEvaluatorRejects: 0,
  answerEvaluatorIssues: [],
  rewriteFailureReasons: [],
  rejectedDrafts: [],
  answerRewriteAttempts: 0,
  answerRewriteSuccesses: 0,
  deterministicFallbacks: 0,
  minimalFallbacks: 0,
  causalClaimsRejected: 0,
  numericClaimsRejected: 0,
  unnamedSubjectClaimsPresented: 0,
  unsupportedCausalClaimsPresented: 0,
  unsupportedRecommendationsPresented: 0,
  rawEvidenceDumpsPresented: 0,
  unsupportedNumericClaims: 0,
  unsupportedNumericClaimsPresented: 0,
  narratorLatencyMs: 0,
  evaluatorLatencyMs: 0,
  rewriteLatencyMs: 0,
};

const sum = (scored: readonly Scored[], pick: (q: AnswerQualityTrace) => number): number =>
  scored.reduce((n, s) => n + pick(s.quality ?? ZERO_QUALITY), 0);

describe.skipIf(!live)("Stage 27.2B.1 §21 — targeted live answer review", () => {
  it(
    "runs the targeted cases and reports every final answer for manual reading",
    async () => {
      const chatClient = new HttpChatClient(endpoint!, model!);
      const portfolio = benchmarkPortfolio();
      const operations = benchmarkOperations();
      const tables: Record<AnswerCase["table"], HarnessTableEnv> = {
        portfolio: { schema: portfolio.schema, grids: portfolio.grids },
        operations: { schema: operations.schema, grids: operations.grids },
      };

      const sandbox = createNodeSandbox();
      await sandbox.runtime.validate("RESULT = {}");
      const scored: Scored[] = [];
      const cases = suite === "all" ? ANSWER_CASES : ANSWER_CASES.filter((c) => TARGETED_CASE_IDS.includes(c.id));

      try {
        for (const probe of cases) {
          const started = Date.now();
          const { report, turn } = await runHarnessTurn({
            chatClient,
            table: tables[probe.table],
            question: probe,
            model: model!,
            runtime: sandbox.runtime,
          });
          const body = turn.kind === "answered" ? turn.body : turn.kind === "clarify" ? turn.question : "";
          const base = countViolations(report, turn);
          const gapDetail = countMissingPolicy(report, probe.touchesGaps === true);
          const counts = gapDetail ? { ...base.counts, missingToZero: base.counts.missingToZero + 1 } : base.counts;
          const quality = report.trace.answerQuality;
          scored.push({
            probe,
            report,
            outcome: turn.kind,
            body,
            counts,
            ...(quality ? { quality } : {}),
            elapsedMs: Date.now() - started,
          });
          const q = quality ?? ZERO_QUALITY;
          process.stderr.write(
            `  [${probe.id}] ${turn.kind} shape=${q.answerShape} rewrite=${q.answerRewriteAttempts}/${q.answerRewriteSuccesses} ` +
              `fallback=${q.deterministicFallbacks} minimal=${q.minimalFallbacks} ` +
              `presented(unnamed=${q.unnamedSubjectClaimsPresented} causal=${q.unsupportedCausalClaimsPresented} rec=${q.unsupportedRecommendationsPresented} dump=${q.rawEvidenceDumpsPresented}) ` +
              `${Date.now() - started}ms${NEWLINE}`,
          );
        }
      } finally {
        await sandbox.dispose();
      }

      const presentedGates = {
        unnamedSubjectClaimsPresented: sum(scored, (q) => q.unnamedSubjectClaimsPresented),
        unsupportedNumericClaimsPresented: sum(scored, (q) => q.unsupportedNumericClaimsPresented),
        unsupportedCausalClaimsPresented: sum(scored, (q) => q.unsupportedCausalClaimsPresented),
        unsupportedRecommendationsPresented: sum(scored, (q) => q.unsupportedRecommendationsPresented),
        rawEvidenceDumpsPresented: sum(scored, (q) => q.rawEvidenceDumpsPresented),
        silentSubstitutionsPresented: scored.reduce((n, s) => n + s.counts.silentSubstitutions, 0),
        missingToZeroPresented: scored.reduce((n, s) => n + s.counts.missingToZero, 0),
        stalePresentations: scored.reduce((n, s) => n + s.counts.stalePresentations, 0),
        unsafeEscapes: scored.reduce((n, s) => n + s.counts.unsafeEscapes, 0),
      };

      const attempts = {
        narrationGateRejects: sum(scored, (q) => q.narrationGateRejects),
        answerEvaluatorRejects: sum(scored, (q) => q.answerEvaluatorRejects),
        causalClaimsRejected: sum(scored, (q) => q.causalClaimsRejected),
        numericClaimsRejected: sum(scored, (q) => q.numericClaimsRejected),
      };

      const rewriteFailures: Record<string, number> = {};
      for (const s of scored) {
        for (const reason of (s.quality ?? ZERO_QUALITY).rewriteFailureReasons) {
          rewriteFailures[reason] = (rewriteFailures[reason] ?? 0) + 1;
        }
      }

      const lines: string[] = [
        "STAGE 27.2B.1 — TARGETED LIVE ANSWER REVIEW",
        `model: ${model}`,
        `when: ${new Date().toISOString()}`,
        `cases: ${scored.length} (${suite})`,
        "",
        "PRESENTED HARD GATES (§13)",
        ...Object.entries(presentedGates).map(([name, value]) => `  ${name} = ${value}${value === 0 ? "" : "   <-- FAIL"}`),
        "",
        "ATTEMPT-LEVEL COUNTERS (§13 — never mixed with presented)",
        ...Object.entries(attempts).map(([name, value]) => `  ${name} = ${value}`),
        "",
        "REWRITE (§9)",
        `  attempts   ${sum(scored, (q) => q.answerRewriteAttempts)}`,
        `  successes  ${sum(scored, (q) => q.answerRewriteSuccesses)}`,
        `  failures   ${JSON.stringify(rewriteFailures)}`,
        "",
        "FALLBACK",
        `  deterministic ${sum(scored, (q) => q.deterministicFallbacks)}`,
        `  minimal       ${sum(scored, (q) => q.minimalFallbacks)}`,
        "",
        "GROUNDING",
        `  extracted ${sum(scored, (q) => q.extractedFindings)} visible ${sum(scored, (q) => q.visibleGroundedFindings)} held ${sum(scored, (q) => q.heldFindings)}`,
        "",
        "LATENCY (§55)",
        `  narrator   ${sum(scored, (q) => q.narratorLatencyMs)}ms`,
        `  evaluator  ${sum(scored, (q) => q.evaluatorLatencyMs)}ms`,
        `  rewrite    ${sum(scored, (q) => q.rewriteLatencyMs)}ms`,
        "",
        RULE,
      ];

      for (const s of scored) {
        const q = s.quality ?? ZERO_QUALITY;
        lines.push(
          "",
          `## ${s.probe.id} — ${s.outcome}`,
          `question: ${s.probe.text}`,
          `why this case: ${s.probe.why}`,
          `table: ${s.probe.table}   shape: ${q.answerShape}`,
          "",
          `findings extracted=${q.extractedFindings} visible=${q.visibleGroundedFindings} held=${q.heldFindings}`,
          `drafts=${q.narratorDrafts} gateRejects=${q.narrationGateRejects} evaluatorRejects=${q.answerEvaluatorRejects} ` +
            `rewrite=${q.answerRewriteAttempts}/${q.answerRewriteSuccesses} fallback=${q.deterministicFallbacks} minimal=${q.minimalFallbacks}`,
          `evaluatorIssues=${JSON.stringify(q.answerEvaluatorIssues)} rewriteFailed=${JSON.stringify(q.rewriteFailureReasons)}`,
          `presented unnamed=${q.unnamedSubjectClaimsPresented} causal=${q.unsupportedCausalClaimsPresented} ` +
            `recommendation=${q.unsupportedRecommendationsPresented} rawDump=${q.rawEvidenceDumpsPresented}`,
          q.held.length > 0 ? `held: ${q.held.map((h) => `${h.findingType}/${h.subject || "-"} <- ${h.reason}`).join("; ")}` : "held: none",
          `latency narrator=${q.narratorLatencyMs}ms evaluator=${q.evaluatorLatencyMs}ms rewrite=${q.rewriteLatencyMs}ms total=${s.elapsedMs}ms`,
          "",
          "ANSWER AS THE READER SEES IT:",
          "-".repeat(74),
          s.body === "" ? "(no answer)" : s.body,
          "-".repeat(74),
        );
      }

      const text = lines.join(NEWLINE);
      if (outFile) writeFileSync(outFile, text, "utf8");
      process.stdout.write(NEWLINE + text.slice(0, 6000) + NEWLINE);

      expect(scored.length).toBe(cases.length);
      expect(presentedGates).toEqual({
        unnamedSubjectClaimsPresented: 0,
        unsupportedNumericClaimsPresented: 0,
        unsupportedCausalClaimsPresented: 0,
        unsupportedRecommendationsPresented: 0,
        rawEvidenceDumpsPresented: 0,
        silentSubstitutionsPresented: 0,
        missingToZeroPresented: 0,
        stalePresentations: 0,
        unsafeEscapes: 0,
      });
    },
    45 * 60 * 1000,
  );
});
