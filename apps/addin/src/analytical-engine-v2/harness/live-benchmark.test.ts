// @vitest-environment node
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { HttpChatClient } from "../../app/chat-client.js";
import { benchmarkInjection, benchmarkOpaque, benchmarkOperations } from "./benchmark-tables.js";
import { CHAIN_EN, CHAIN_RU, COMPOUND, INJECTION, OPAQUE, PARAPHRASES, PRONOUN_FOLLOWUPS, TEMPORAL } from "./benchmark-questions.js";
import { renderHarnessReport, renderHarnessTraces, runHarnessConversation, runHarnessTurn, summarize, type HarnessQuestion, type HarnessTableEnv, type HarnessTurnReport } from "./live-harness.js";

const endpoint = process.env["SHEET_AGENT_LIVE_ENDPOINT"];
const model = process.env["SHEET_AGENT_LIVE_MODEL"];
const suite = process.env["SHEET_AGENT_LIVE_SUITE"] ?? "all";
const wantTraces = process.env["SHEET_AGENT_LIVE_TRACES"] === "1";
const outFile = process.env["SHEET_AGENT_LIVE_OUT"];
// Stage 26.2L §8 — machine-readable artifact. Purely an output sink: it changes
// no prompt, no tool description, no question and no registry entry.
const jsonFile = process.env["SHEET_AGENT_LIVE_JSON"];
const live = Boolean(endpoint && model);

const want = (name: string): boolean => suite === "all" || suite === name;
const envOf = (t: { schema: HarnessTableEnv["schema"]; grids: HarnessTableEnv["grids"] }): HarnessTableEnv => ({ schema: t.schema, grids: t.grids });

describe.skipIf(!live)("Stage 26.2 §65 — live planner benchmark", () => {
  it(
    "runs the held-out question set against the real model and reports what happened",
    async () => {
      const chatClient = new HttpChatClient(endpoint!, model!);
      const ops = envOf(benchmarkOperations());
      const opaque = envOf(benchmarkOpaque());
      const injection = envOf(benchmarkInjection());
      const reports: HarnessTurnReport[] = [];

      const each = async (table: HarnessTableEnv, questions: readonly HarnessQuestion[], language: "ru" | "en" = "ru"): Promise<void> => {
        for (const question of questions) {
          const { report } = await runHarnessTurn({ chatClient, table, question, language, model: model! });
          reports.push(report);
          process.stderr.write(`  [${report.id}] ${report.outcome}${report.failureClass ? ` ${report.failureClass}` : ""} ${report.elapsedMs}ms\n`);
        }
      };

      if (want("chain")) reports.push(...(await runHarnessConversation({ chatClient, table: ops, questions: CHAIN_RU, model: model! })));
      if (want("english")) reports.push(...(await runHarnessConversation({ chatClient, table: ops, questions: CHAIN_EN, language: "en", model: model! })));
      if (want("paraphrase")) {
        await each(ops, PARAPHRASES);
        for (const pair of PRONOUN_FOLLOWUPS) {
          const chain = await runHarnessConversation({ chatClient, table: ops, questions: [pair.setup, pair.followUp], model: model! });
          const last = chain[chain.length - 1];
          if (last) reports.push(last);
        }
      }
      if (want("compound")) await each(ops, COMPOUND);
      if (want("temporal")) await each(ops, TEMPORAL);
      if (want("opaque")) await each(opaque, OPAQUE);
      if (want("injection")) await each(injection, INJECTION);

      const summary = summarize(reports);
      const text = renderHarnessReport(reports, summary) + (wantTraces ? `\n\n=== TRACES ===\n${renderHarnessTraces(reports)}` : "");
      process.stdout.write(`\n${text}\n`);
      if (outFile) writeFileSync(outFile, text, "utf8");
      if (jsonFile) {
        // §8 — aggregate metrics + per-question results. The endpoint is recorded
        // as host:port only and the API key never passes through this process.
        const host = (() => {
          try {
            return new URL(endpoint!).host;
          } catch {
            return "unknown";
          }
        })();
        writeFileSync(
          jsonFile,
          JSON.stringify(
            {
              stage: "26.2L",
              generatedAt: new Date().toISOString(),
              endpointHost: host,
              model,
              suite,
              summary,
              questions: reports.map((r) => ({
                id: r.id,
                question: r.question,
                concepts: r.concepts,
                outcome: r.outcome,
                toolSequence: r.toolSequence,
                plannerRounds: r.plannerRounds,
                toolCalls: r.toolCalls,
                workbookReads: r.workbookReads,
                cacheHits: r.cacheHits,
                protocolCorrections: r.protocolCorrections,
                completionRetries: r.completionRetries,
                primaryCorrections: r.primaryCorrections,
                reusedReference: r.reusedReference,
                completion: r.completion ?? null,
                primaryType: r.primaryType ?? null,
                primaryMetrics: r.primaryMetrics ?? null,
                usedFallback: r.usedFallback ?? null,
                validCompletion: r.validCompletion,
                semanticallyCorrect: r.semanticallyCorrect,
                mismatches: r.mismatches,
                failureClass: r.failureClass ?? null,
                elapsedMs: r.elapsedMs,
                rounds: r.trace.rounds.map((round) => ({
                  round: round.round,
                  decision: round.decision ?? null,
                  parseError: round.parseError ?? null,
                  decisionProblem: round.decisionProblem ?? null,
                  // §17 — the model's actual text, so a serialization failure can be
                  // CLASSIFIED rather than guessed at from the parser's message.
                  rawDecision: round.rawDecision ?? null,
                  serialization: round.serialization ?? null,
                  toolError: round.toolError ?? null,
                  toolResultId: round.toolResultId ?? null,
                  cached: round.cached ?? false,
                })),
                results: r.trace.results,
                declaredOutputs: r.trace.declaredOutputs ?? null,
                coverageUnsatisfied: r.trace.coverageUnsatisfied ?? null,
                serializationClasses: r.trace.serializationClasses ?? null,
                declaredPrimaryOutputId: r.trace.declaredPrimaryOutputId ?? null,
                boundPrimaryResultRef: r.trace.boundPrimaryResultRef ?? null,
                completePrimaryResultRef: r.trace.completePrimaryResultRef ?? null,
                primaryBindingMismatch: r.trace.primaryBindingMismatch ?? false,
                primaryCorrectionAttempted: r.trace.primaryCorrectionAttempted ?? false,
                primaryCorrectionSucceeded: r.trace.primaryCorrectionSucceeded ?? false,
                stateBefore: r.trace.stateBefore ?? null,
                stateAfter: r.trace.stateAfter ?? null,
                stateRejected: r.trace.stateRejected ?? null,
                narratorStatus: r.trace.narratorStatus ?? null,
                traceOutcome: r.trace.outcome,
                failureReason: r.trace.failureReason ?? null,
              })),
            },
            null,
            2,
          ),
          "utf8",
        );
      }
      // §67 — the engineering targets, reported rather than asserted.
      process.stderr.write(
        `\ntargets: validCompletion ${(summary.validCompletionRate * 100).toFixed(1)}% (>=90) · ` +
          `semantic ${(summary.semanticCorrectnessRate * 100).toFixed(1)}% (>=90) · ` +
          `compound ${(summary.compoundCompletenessRate * 100).toFixed(1)}% (>=80)\n`,
      );
    },
    { timeout: 30 * 60 * 1000 },
  );
});

describe.skipIf(live)("Stage 26.2 §65 — live planner benchmark (not configured)", () => {
  it("is skipped unless SHEET_AGENT_LIVE_ENDPOINT and SHEET_AGENT_LIVE_MODEL are set", () => {
    // Deliberately a no-op: the benchmark must never silently "pass" with zero
    // questions, and must never run against a model in ordinary CI.
  });
});
