// @vitest-environment node
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { HttpChatClient } from "../../app/chat-client.js";
import { createNodeSandbox } from "./node-sandbox.js";
import { benchmarkPortfolio } from "./sandbox-tables.js";
import { buildDataset } from "../sandbox/dataset.js";
import { buildAgentMessages, extractDecision } from "../sandbox/analysis-agent-prompt.js";
import { renderAgentTrace, runAnalysisAgent, type AnalysisAgentOutcome, type SessionRuntime } from "../sandbox/analysis-agent.js";
import type { SandboxPlan } from "../sandbox/types.js";

const endpoint = process.env["SHEET_AGENT_LIVE_ENDPOINT"];
const model = process.env["SHEET_AGENT_LIVE_MODEL"];
const outFile = process.env["SHEET_AGENT_RECOVERY_OUT"];
const live = Boolean(endpoint && model);
const NEWLINE = String.fromCharCode(10);
const py = (...lines: readonly string[]): string => lines.join(NEWLINE);

interface RecoveryCase {
  readonly id: string;
  readonly request: string;
  readonly plan: Omit<SandboxPlan, "datasetRefs">;
  /** §28–§31 — the FIRST action, replaced with a specific break. */
  readonly forceFirstCode?: string;
  /** What the observation must contain for the case to be a fair test. */
  readonly observationMustMention?: readonly string[];
}

const CASES: readonly RecoveryCase[] = [
  {
    id: "case-1-simple-complete",
    request: "Посчитай среднее по каждому числовому столбцу и верни самое большое из них.",
    plan: {
      objective: "compute the mean of every numeric column and return the largest",
      requestedOutputs: [{ id: "o1", description: "the largest column mean", shape: "scalar" }],
    },
  },
  {
    id: "case-2-nameerror",
    request: "Посчитай среднее по каждому числовому столбцу и верни самое большое из них.",
    plan: {
      objective: "compute the mean of every numeric column and return the largest",
      requestedOutputs: [{ id: "o1", description: "the largest column mean", shape: "scalar" }],
    },
    forceFirstCode: py('labels = entity_df["metric"]', "means = numeric_data.mean()"),
    observationMustMention: ["NameError", "entity_data"],
  },
  {
    id: "case-3-api",
    request: "Опиши распределение числовых показателей и верни самое большое среднее по столбцу.",
    plan: {
      objective: "describe the numeric columns and return the largest column mean",
      requestedOutputs: [{ id: "o1", description: "the largest column mean", shape: "scalar" }],
    },
    forceFirstCode: py("summary = numeric_data.describe(axis=1)", "means = summary.loc['mean']"),
    observationMustMention: ["axis"],
  },
  {
    id: "case-4-shape",
    request: "Отбери продукты, у которых значение в последнем периоде выше среднего, и верни их количество.",
    plan: {
      objective: "count the products above the mean in the final period",
      requestedOutputs: [{ id: "o1", description: "how many products are above the mean", shape: "scalar" }],
    },
    forceFirstCode: py(
      "mask = np.array([True, False] * 6)",
      "selected = numeric_data[mask]",
    ),
    observationMustMention: ["length"],
  },
];

interface CaseResult {
  readonly probe: RecoveryCase;
  readonly outcome: AnalysisAgentOutcome;
  readonly trace: string;
  readonly rawDecisions: readonly string[];
  readonly firstObservation: string;
  readonly elapsedMs: number;
}

describe.skipIf(!live)("Stage 27.2A §28–§31 — live recovery, loop driven directly", () => {
  it(
    "runs the four cases and reports what happened",
    async () => {
      const sandbox = createNodeSandbox();
      const table = benchmarkPortfolio();
      const built = buildDataset({ schema: table.schema, grids: table.grids });
      if (!built.ok) throw new Error("the benchmark dataset did not build");
      const dataset = built.dataset;
      const client = new HttpChatClient(endpoint!, model!);
      const results: CaseResult[] = [];

      try {
        for (const probe of CASES) {
          const started = Date.now();
          const rawDecisions: string[] = [];
          let firstObservation = "";
          let round = 0;

          const outcome = await runAnalysisAgent({
            runtime: sandbox.runtime as unknown as SessionRuntime,
            sessionId: `rec_${probe.id}`,
            request: probe.request,
            plan: { ...probe.plan, datasetRefs: [dataset.datasetId] },
            dataset,
            currentSourceVersion: () => dataset.freshnessToken,
            decide: async (context) => {
              round += 1;
              // §28–§31 — the break, and only the break.
              if (round === 1 && probe.forceFirstCode) {
                const forced = JSON.stringify({ action: "EXECUTE_CODE", purpose: "first attempt", code: probe.forceFirstCode });
                rawDecisions.push(`[FORCED] ${forced}`);
                return forced;
              }
              if (round === 2 && probe.forceFirstCode) {
                // Record exactly what the model was shown, so a case that
                // fails can be told apart from a case that was never fair.
                const last = context.observations[context.observations.length - 1];
                firstObservation = last ? JSON.stringify(last, null, 2) : "(none)";
              }
              const raw = await client.decideAnalysisStep(buildAgentMessages(context), new AbortController().signal, model!);
              rawDecisions.push(raw);
              return extractDecision(raw);
            },
          });

          results.push({
            probe,
            outcome,
            trace: renderAgentTrace(probe.request, outcome.trace, outcome),
            rawDecisions,
            firstObservation,
            elapsedMs: Date.now() - started,
          });
          process.stdout.write(
            `${probe.id}: ${outcome.status} rounds=${outcome.metrics.decisionRounds} code=${outcome.metrics.codeExecutions} ` +
              `errors=${outcome.metrics.executionErrors} batched=${outcome.metrics.batchedDecisions} recovered=${outcome.metrics.selfRecoverySuccess}${NEWLINE}`,
          );
        }
      } finally {
        await sandbox.dispose();
      }

      const recoveryCases = results.filter((r) => r.probe.forceFirstCode);
      const recovered = recoveryCases.filter((r) => r.outcome.status === "complete");
      const lines: string[] = [
        "STAGE 27.2A — LIVE RECOVERY CASES",
        `model: ${model}`,
        `when: ${new Date().toISOString()}`,
        "",
        `case 1 (can it COMPLETE at all): ${results[0]?.outcome.status ?? "n/a"}`,
        `recovery cases completed: ${recovered.length}/${recoveryCases.length}`,
        `SELF_RECOVERY_RATE: ${recoveryCases.length === 0 ? "n/a" : `${((recovered.length / recoveryCases.length) * 100).toFixed(0)}%`}`,
        "",
        "=".repeat(70),
      ];
      for (const r of results) {
        lines.push(
          "",
          `## ${r.probe.id} — ${r.outcome.status}`,
          `request: ${r.probe.request}`,
          r.probe.forceFirstCode ? `forced first action:${NEWLINE}${r.probe.forceFirstCode}` : "first action: the model's own",
          "",
          `rounds=${r.outcome.metrics.decisionRounds} code=${r.outcome.metrics.codeExecutions} errors=${r.outcome.metrics.executionErrors} ` +
            `batched=${r.outcome.metrics.batchedDecisions} control=${r.outcome.metrics.controlErrors} completionRejections=${r.outcome.metrics.completionRejections}`,
          "",
          r.firstObservation ? `WHAT THE MODEL WAS SHOWN AFTER THE BREAK:${NEWLINE}${r.firstObservation}` : "",
          "",
          `TRACE:${NEWLINE}${r.trace}`,
          "",
          `RAW DECISIONS:${NEWLINE}${r.rawDecisions.map((d, i) => `--- round ${i + 1} ---${NEWLINE}${d}`).join(NEWLINE)}`,
          "-".repeat(70),
        );
      }
      const text = lines.join(NEWLINE);
      if (outFile) writeFileSync(outFile, text, "utf8");
      process.stdout.write(NEWLINE + text.slice(0, 4000) + NEWLINE);

      // §46 — the run is the evidence; the verdict is read off the report.
      expect(results).toHaveLength(CASES.length);

      // The observations must actually have carried what the case claims to
      // test. A case whose break produced an unrelated error is not evidence
      // about recovery either way, and silently counting it would be worse
      // than reporting nothing.
      for (const r of recoveryCases) {
        for (const token of r.probe.observationMustMention ?? []) {
          expect(r.firstObservation, `${r.probe.id} must have shown "${token}"`).toContain(token);
        }
      }
    },
    30 * 60 * 1000,
  );
});
