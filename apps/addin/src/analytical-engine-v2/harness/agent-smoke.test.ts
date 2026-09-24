// @vitest-environment node
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { HttpChatClient } from "../../app/chat-client.js";
import { createNodeSandbox } from "./node-sandbox.js";
import { benchmarkPortfolio } from "./sandbox-tables.js";
import { AGENT_SMOKE_CASES, type AgentSmokeCase } from "./agent-smoke-questions.js";
import { runHarnessTurn, type HarnessTableEnv, type HarnessTurnReport } from "./live-harness.js";
import type { AgentMetrics } from "../sandbox/analysis-agent.js";
import type { EngineTurn } from "../engine.js";

const endpoint = process.env["SHEET_AGENT_LIVE_ENDPOINT"];
const model = process.env["SHEET_AGENT_LIVE_MODEL"];
const outFile = process.env["SHEET_AGENT_SMOKE_OUT"];
const jsonFile = process.env["SHEET_AGENT_SMOKE_JSON"];
const live = Boolean(endpoint && model);
const NEWLINE = String.fromCharCode(10);

interface SmokeResult {
  readonly probe: AgentSmokeCase;
  readonly outcome: EngineTurn["kind"];
  readonly body: string;
  readonly report: HarnessTurnReport;
  readonly metrics?: AgentMetrics;
  readonly trace?: string;
  readonly forcedFailure: boolean;
  readonly elapsedMs: number;
}

/**
 * §47 — the metrics table, computed from what happened rather than declared.
 *
 * SELF_RECOVERY_RATE is the one to read carefully. Its denominator is turns
 * that CONTAINED an execution error, not all turns: a run in which nothing
 * broke has no recovery rate, and reporting 100% for it would be a number
 * about nothing. When the denominator is zero the rate is reported as "n/a",
 * never as a percentage.
 */
function summarise(results: readonly SmokeResult[]): readonly string[] {
  const agentTurns = results.filter((r) => r.metrics);
  const withErrors = agentTurns.filter((r) => (r.metrics?.executionErrors ?? 0) > 0);
  const recovered = withErrors.filter((r) => r.metrics?.selfRecoverySuccess === true);
  const completed = results.filter((r) => r.outcome === "answered");
  const mean = (values: readonly number[]): string => (values.length === 0 ? "n/a" : (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));

  return [
    "METRICS (§47)",
    `turns tested:                 ${results.length}`,
    `turns that ran the loop:      ${agentTurns.length}`,
    `task completion:              ${completed.length}/${results.length}`,
    `turns with execution errors:  ${withErrors.length}`,
    `self-recovery opportunities:  ${withErrors.length}`,
    `self-recovery successes:      ${recovered.length}`,
    `SELF_RECOVERY_RATE:           ${withErrors.length === 0 ? "n/a (no turn hit an execution error)" : `${((recovered.length / withErrors.length) * 100).toFixed(0)}%`}`,
    `mean decision rounds:         ${mean(agentTurns.map((r) => r.metrics!.decisionRounds))}`,
    `mean code executions:         ${mean(agentTurns.map((r) => r.metrics!.codeExecutions))}`,
    `mean inspections:             ${mean(agentTurns.map((r) => r.metrics!.inspections))}`,
    `control errors (total):       ${agentTurns.reduce((a, r) => a + r.metrics!.controlErrors, 0)}`,
    `repeated actions (total):     ${agentTurns.reduce((a, r) => a + r.metrics!.repeatedActions, 0)}`,
    `batched responses (trimmed):  ${agentTurns.reduce((a, r) => a + r.metrics!.batchedDecisions, 0)}`,
    `completion rejections:        ${agentTurns.reduce((a, r) => a + r.metrics!.completionRejections, 0)}`,
    `terminal execution failures:  ${results.filter((r) => r.outcome === "failed").length}`,
    `budget exhaustions:           ${agentTurns.filter((r) => r.metrics!.decisionRounds >= 8).length}`,
    "",
    "LATENCY (§38)",
    `mean total turn:              ${mean(results.map((r) => r.elapsedMs))} ms`,
    `mean decision latency:        ${mean(agentTurns.map((r) => r.metrics!.decisionMs))} ms`,
    `mean execution latency:       ${mean(agentTurns.map((r) => r.metrics!.executionMs))} ms`,
    `mean inspection latency:      ${mean(agentTurns.map((r) => r.metrics!.inspectionMs))} ms`,
    "",
    "NOT MEASURED HERE — these need a human reading the answers (§48 Safety PASS):",
    "  silentSubstitutions, missingToZero, stalePresentations, unsupportedNumericClaims.",
    "  The per-case bodies are printed in full below so they can be read.",
  ];
}

describe.skipIf(!live)("Stage 27.2A §46 — live agent smoke", () => {
  it(
    "runs the ten cases and reports what happened",
    async () => {
      const chatClient = new HttpChatClient(endpoint!, model!);
      const sandbox = createNodeSandbox();
      const table = benchmarkPortfolio();
      const env: HarnessTableEnv = { schema: table.schema, grids: table.grids };
      const results: SmokeResult[] = [];

      try {
        for (const probe of AGENT_SMOKE_CASES) {
          const started = Date.now();
          let forced = false;

          // §28–§31 — replace the FIRST decision only, and only with a break.
          const client = probe.forceFirstCode
            ? new Proxy(chatClient, {
                get(target, key, receiver) {
                  if (key !== "decideAnalysisStep") return Reflect.get(target, key, receiver);
                  return async (messages: readonly { readonly role: string; readonly content: string }[], signal: AbortSignal, m?: string) => {
                    if (!forced) {
                      forced = true;
                      return JSON.stringify({ action: "EXECUTE_CODE", purpose: "first attempt", code: probe.forceFirstCode });
                    }
                    return target.decideAnalysisStep!(messages as never, signal, m);
                  };
                },
              })
            : chatClient;

          let outcome: SmokeResult;
          try {
            const run = await runHarnessTurn({
              chatClient: client,
              table: env,
              question: { id: probe.id, text: probe.question, concepts: [] },
              runtime: sandbox.runtime,
              model: model!,
            });
            outcome = {
              probe,
              outcome: run.turn.kind,
              body: run.turn.kind === "answered" ? run.turn.body : run.turn.kind === "clarify" ? run.turn.question : String(run.turn.reason ?? ""),
              report: run.report,
              ...(run.report.analysis?.agent ? { metrics: run.report.analysis.agent } : {}),
              ...(run.report.analysis?.agentTrace ? { trace: run.report.analysis.agentTrace } : {}),
              forcedFailure: forced,
              elapsedMs: Date.now() - started,
            };
          } catch (err) {
            // A harness error is reported, not swallowed and not retried: a
            // case that could not be run is not a case that passed.
            outcome = {
              probe,
              outcome: "failed",
              body: `HARNESS ERROR: ${String(err)}`,
              report: { id: probe.id } as unknown as HarnessTurnReport,
              forcedFailure: forced,
              elapsedMs: Date.now() - started,
            };
          }
          results.push(outcome);
          // Printed as it goes, so a run that is killed halfway still taught
          // something.
          process.stdout.write(
            `${probe.id}: ${outcome.outcome}` +
              (outcome.metrics
                ? ` rounds=${outcome.metrics.decisionRounds} code=${outcome.metrics.codeExecutions} errors=${outcome.metrics.executionErrors} recovered=${outcome.metrics.selfRecoverySuccess}`
                : " (one-shot path)") +
              NEWLINE,
          );
        }
      } finally {
        await sandbox.dispose();
      }

      const lines: string[] = [
        "STAGE 27.2A — LIVE AGENT SMOKE",
        `model: ${model}`,
        `endpoint: ${endpoint}`,
        `when: ${new Date().toISOString()}`,
        "",
        ...summarise(results),
        "",
        "=".repeat(70),
      ];
      for (const result of results) {
        lines.push(
          "",
          `## ${result.probe.id} — ${result.outcome}`,
          `question: ${result.probe.question}`,
          `probes:   ${result.probe.probes}`,
          result.forcedFailure ? "first action: FORCED BROKEN (§28–§31)" : "first action: the model's own",
          "",
          "answer:",
          result.body,
          "",
          result.trace ? `trace:${NEWLINE}${result.trace}` : "trace: (one-shot path, no agent trace)",
          "-".repeat(70),
        );
      }
      const text = lines.join(NEWLINE);
      if (outFile) writeFileSync(outFile, text, "utf8");
      if (jsonFile) writeFileSync(jsonFile, JSON.stringify(results, null, 2), "utf8");
      process.stdout.write(NEWLINE + text + NEWLINE);

      // §46 — the only assertion. Everything else is for a human to read.
      expect(results).toHaveLength(AGENT_SMOKE_CASES.length);
    },
    45 * 60 * 1000,
  );
});
