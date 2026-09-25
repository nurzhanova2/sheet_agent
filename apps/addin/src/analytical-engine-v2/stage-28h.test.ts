import { describe, expect, it } from "vitest";
import { runAnalyticalEngine } from "./engine.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import type { AnalysisCapability } from "./sandbox/analysis-runner.js";
import type { AnalyticalRuntime } from "./sandbox/executor.js";
import type { ExecuteOutcome } from "./sandbox/pyodide-runtime.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";
import type { SandboxResult } from "./sandbox/types.js";

function userPrompt(messages: readonly PlannerMessage[]): string {
  return messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
}

function resultId(prompt: string, tool: string): string | null {
  const escaped = tool.replace(".", "\\.");
  return new RegExp(`^(result_\\d+) = ${escaped} `, "m").exec(prompt)?.[1] ?? null;
}

const overviewIntent = {
  shape: "overview" as const,
  count: null,
  direction: null,
  subjects: [],
  periodIntent: { kind: "full_range" as const },
  wantsTable: false,
  wantsRecommendation: false,
  answerStyle: "concise" as const,
};

const sandboxResult = (): SandboxResult => ({
  executionId: "stage28h-exec",
  status: "ok",
  tables: [{ name: "findings", columns: ["subject", "score"], rows: [["A", 1]] }],
  scalars: {},
  series: [],
  groups: [],
  models: [],
  diagnostics: {},
  findingsCandidates: [],
  warnings: [],
  artifacts: [],
  sourceLineage: { datasetIds: ["dataset"], sheet: "Ops", sourceRange: "Ops!A1:D5", freshnessToken: "v1" },
});

function analysisCapability(calls: { count: number }): AnalysisCapability {
  const runtime: AnalyticalRuntime = {
    hardTimeout: true,
    validate: async () => [],
    execute: async (): Promise<ExecuteOutcome> => {
      calls.count += 1;
      return { ok: true, result: sandboxResult(), stdout: "", durationMs: 1 };
    },
  };
  return { runtime, generateCode: async () => "RESULT = {}" };
}

describe("Stage 28H — manual acceptance blocker #1", () => {
  it("answers the exact Russian overview request from schema context without Python", async () => {
    const table = fixtureOperations();
    const calls = { count: 0 };
    let decisions = 0;
    const turn = await runAnalyticalEngine({
      turnId: "stage28h-overview",
      request: "О чем эта таблица?",
      schema: table.schema,
      grids: table.grids,
      language: "ru",
      state: EMPTY_ANALYTICAL_STATE,
      analysis: analysisCapability(calls),
      decide: (messages) => {
        decisions += 1;
        const prompt = userPrompt(messages);
        const schema = resultId(prompt, "schema.describe");
        if (!schema) return JSON.stringify({ kind: "tool_call", tool: "schema.describe", arguments: {} });
        return JSON.stringify({ kind: "complete", primaryResultRef: schema, supportingResultRefs: [], answerIntent: overviewIntent });
      },
      narrate: async () => "",
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.analysis.primary.tool).toBe("schema.describe");
    expect(turn.body).not.toBe("");
    expect(calls.count).toBe(0);
    expect(decisions).toBe(2);
    expect(turn.trace.rounds.some((round) => round.decision?.kind === "analyze")).toBe(false);
    expect(turn.trace.declaredOutputs).toBeUndefined();
  });

  it("does not execute the same successful sandbox request twice", async () => {
    const table = fixtureOperations();
    const calls = { count: 0 };
    let askedAgain = false;
    const analyze = JSON.stringify({
      kind: "analyze",
      objective: "find the bounded overview findings that deterministic tools cannot provide",
      requestedOutputs: [{ id: "a1", description: "overview findings", shape: "table" }],
      necessity: "MISSING_DETERMINISTIC_CAPABILITY",
    });
    const turn = await runAnalyticalEngine({
      turnId: "stage28h-no-duplicate-analysis",
      request: "Find the unsupported overview finding.",
      schema: table.schema,
      grids: table.grids,
      language: "en",
      state: EMPTY_ANALYTICAL_STATE,
      analysis: analysisCapability(calls),
      decide: (messages) => {
        const prompt = userPrompt(messages);
        const sandbox = /^(result_\d+) = sandbox\./m.exec(prompt)?.[1];
        if (!sandbox) return analyze;
        if (!askedAgain) {
          askedAgain = true;
          return analyze;
        }
        return JSON.stringify({ kind: "complete", primaryResultRef: sandbox, supportingResultRefs: [] });
      },
      narrate: async () => "",
    });

    expect(turn.kind).toBe("answered");
    expect(calls.count).toBe(1);
    // A successful analyze is recorded once before execution and once with
    // its result id; the third entry is the refused duplicate decision.
    expect(turn.trace.rounds.filter((round) => round.decision?.kind === "analyze")).toHaveLength(3);
    expect(turn.trace.rounds.filter((round) => round.decision?.kind === "analyze" && round.toolResultId)).toHaveLength(1);
  });

  it("keeps a successful sandbox result when coverage is incomplete instead of restarting Python", async () => {
    const table = fixtureOperations();
    const calls = { count: 0 };
    let completionCount = 0;
    const turn = await runAnalyticalEngine({
      turnId: "stage28h-coverage",
      request: "Compute the unsupported finding and describe its context.",
      schema: table.schema,
      grids: table.grids,
      language: "en",
      state: EMPTY_ANALYTICAL_STATE,
      analysis: analysisCapability(calls),
      decide: (messages) => {
        const prompt = userPrompt(messages);
        if (!prompt.includes("OUTPUTS YOU ALREADY DECLARED")) {
          return JSON.stringify({ kind: "plan", outputs: ["the unsupported finding", "its context"], primaryOutputId: "o1" });
        }
        const sandbox = /^(result_\d+) = sandbox\./m.exec(prompt)?.[1];
        if (!sandbox) {
          return JSON.stringify({
            kind: "analyze",
            objective: "compute the unsupported finding",
            requestedOutputs: [{ id: "a1", description: "the unsupported finding", shape: "table" }],
            necessity: "MISSING_DETERMINISTIC_CAPABILITY",
          });
        }
        completionCount += 1;
        return JSON.stringify({
          kind: "complete",
          primaryResultRef: sandbox,
          supportingResultRefs: [],
          outputBindings: [{ outputId: "o1", resultRef: sandbox }],
        });
      },
      narrate: async () => "",
    });

    expect(turn.kind).toBe("answered");
    expect(calls.count).toBe(1);
    expect(completionCount).toBe(2);
    if (turn.kind !== "answered") return;
    expect(turn.trace.declaredOutputs?.map((output) => output.id)).toEqual(["o1", "o2"]);
    const completeDecisions = turn.trace.rounds.flatMap((round) =>
      round.decision?.kind === "complete" ? [round.decision] : [],
    );
    expect(completeDecisions).toHaveLength(2);
    expect(completeDecisions.map((decision) => decision.outputBindings?.map((binding) => binding.outputId))).toEqual([
      ["o1"],
      ["o1"],
    ]);
    expect(turn.trace.coverageUnsatisfied).toEqual(["o2"]);
    expect(turn.trace.rounds.filter((round) => round.decision?.kind === "analyze" && round.toolResultId)).toHaveLength(1);
  });
});
