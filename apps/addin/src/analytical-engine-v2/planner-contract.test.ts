// ---------------------------------------------------------------------------
// Stage 26.2 §15/§47 — PLANNER CONTRACT tests.
//
// A real model will eventually emit every one of these. None of them may
// produce an answer, leak protocol text to the user, or commit state: the
// engine must fail closed, with the failure visible in the trace.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { runAnalyticalEngine, type EngineTurn } from "./engine.js";
import { parsePlannerDecision } from "./planner/planner-prompt.js";
import { EMPTY_ANALYTICAL_STATE, type AnalyticalConversationState } from "./state/conversation-state.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";

const table = fixtureOperations();

async function withPlanner(reply: (round: number, messages: readonly PlannerMessage[]) => string, state: AnalyticalConversationState = EMPTY_ANALYTICAL_STATE): Promise<EngineTurn> {
  let round = 0;
  return runAnalyticalEngine({
    turnId: "contract",
    request: "Сравни последнюю дату с предыдущей.",
    schema: table.schema,
    grids: table.grids,
    language: "ru",
    state,
    decide: (messages) => {
      round += 1;
      return reply(round, messages);
    },
    narrate: async () => "",
  });
}

const call = (tool: string, args: Record<string, unknown> = {}): string => JSON.stringify({ kind: "tool_call", tool, arguments: args });

describe("Stage 26.2 §14 — the decision grammar rejects everything outside it", () => {
  it("refuses executable content, extra protocol keys and malformed shapes", () => {
    const bad = [
      '{"kind":"exec","code":"process.exit(1)"}',
      '{"kind":"tool_call","tool":"period.latest","arguments":{},"then":"rm -rf /"}',
      '{"kind":"complete","primaryResultRef":"result_1","sql":"SELECT 1"}',
      '{"kind":"tool_call","arguments":{}}',
      '{"kind":"tool_call","tool":"period.latest","arguments":[1,2]}',
      '{"kind":"complete"}',
      '{"kind":"clarify","question":""}',
      "[]",
      "null",
      "just some prose about the answer",
      "",
    ];
    for (const raw of bad) expect(parsePlannerDecision(raw).ok, raw).toBe(false);
  });

  it("accepts the three valid shapes, including a fenced one", () => {
    expect(parsePlannerDecision('{"kind":"tool_call","tool":"period.latest","arguments":{}}').ok).toBe(true);
    expect(parsePlannerDecision('```json\n{"kind":"clarify","question":"q","options":[]}\n```').ok).toBe(true);
    expect(parsePlannerDecision('{"kind":"complete","primaryResultRef":"result_1","supportingResultRefs":["result_1","result_2","result_2"]}')).toMatchObject({
      ok: true,
      decision: { supportingResultRefs: ["result_2"] },
    });
  });
});

describe("Stage 26.2 §47 — malformed model behaviour fails closed", () => {
  it("an unknown tool is recoverable once, then terminates", async () => {
    const persistent = await withPlanner(() => call("set.sql", { query: "SELECT 1" }));
    expect(persistent.kind).toBe("failed");
    if (persistent.kind !== "failed") return;
    expect(persistent.reason).toBe("repeated_invalid_call");
    expect(persistent.trace.rounds.some((r) => r.toolError?.code === "UNKNOWN_TOOL")).toBe(true);
  });

  it("a missing required argument is reported with the argument's contract", async () => {
    const turn = await withPlanner(() => call("period.previous", {}));
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    const err = turn.trace.rounds.find((r) => r.toolError)?.toolError;
    expect(err?.code).toBe("INVALID_ARGUMENT");
    // Stage 26.3 §3/§10 — "of" is now satisfiable EITHER literally or by
    // reference, so the contract error names both spellings instead of one.
    expect(err?.message).toMatch(/"of"/);
    expect(err?.message).toMatch(/"ofRef"/);
  });

  it("a wrongly typed argument is refused before the tool runs", async () => {
    const turn = await withPlanner(() => call("set.top", { inputRef: "result_1", field: "x", n: "three" }));
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.trace.rounds.find((r) => r.toolError)?.toolError?.code).toBe("INVALID_ARGUMENT");
  });

  it("an invented ResultRef is UNKNOWN_REFERENCE and lists what exists", async () => {
    const turn = await withPlanner((round) => (round === 1 ? call("period.latest") : call("set.filter", { inputRef: "result_99", field: "x", op: "<", value: 0 })));
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    const err = turn.trace.rounds.find((r) => r.toolError?.code === "UNKNOWN_REFERENCE")?.toolError;
    expect(err?.candidates).toContain("result_1");
  });

  it("an invented metric is refused with the real labels attached", async () => {
    const turn = await withPlanner(() => call("series.get", { metric: "Совершенно выдуманный показатель" }));
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    const err = turn.trace.rounds.find((r) => r.toolError)?.toolError;
    expect(err?.candidates).toEqual(expect.arrayContaining([...table.metricLabels]));
  });

  it("an invalid derive AST never reaches an evaluator", async () => {
    const turn = await withPlanner((round) => {
      if (round === 1) return call("period.latest");
      if (round === 2) return call("period.previous", { of: "PLACEHOLDER" });
      return call("derive.compute", { inputRef: "result_1", field: "x", expr: { op: "require", value: "node:fs" } });
    });
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.trace.rounds.some((r) => r.toolError !== undefined)).toBe(true);
  });

  it("COMPLETE naming a missing result is corrected once, then terminates", async () => {
    const turn = await withPlanner(() => JSON.stringify({ kind: "complete", primaryResultRef: "result_42", supportingResultRefs: [] }));
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.reason).toBe("invalid_decision");
    expect(turn.trace.rounds).toHaveLength(2);
  });

  it("§34 — COMPLETE pointing at a schema description is not an analytical answer", async () => {
    const turn = await withPlanner((round) =>
      round === 1 ? call("schema.describe") : JSON.stringify({ kind: "complete", primaryResultRef: "result_1", supportingResultRefs: [] }),
    );
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.detail).toMatch(/not an analytical answer/);
  });

  it("raw executable output never becomes an answer", async () => {
    const turn = await withPlanner(() => '{"kind":"tool_call","tool":"period.latest","arguments":{},"exec":"drop table"}');
    expect(turn.kind).toBe("failed");
  });

  it("a planner that never finishes exhausts its round budget cleanly", async () => {
    const turn = await withPlanner((round) => call("metric.list", { scope: round % 2 === 0 ? "amount_like" : "all" }));
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(["planner_rounds", "tool_calls"]).toContain(turn.reason);
  });

  it("a model transport error is a clean failure, not a crash", async () => {
    const turn = await withPlanner(() => {
      throw new Error("connection reset");
    });
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.reason).toBe("model_error");
    expect(turn.detail).toBe("connection reset");
  });

  it("§15 — no failure path leaks protocol text, and none commits state", async () => {
    const before: AnalyticalConversationState = { turnId: "t0", lastMetric: { metricKey: "Defect ratio" } };
    const turns = await Promise.all([
      withPlanner(() => call("set.sql"), before),
      withPlanner(() => JSON.stringify({ kind: "complete", primaryResultRef: "result_42" }), before),
      withPlanner(() => "I think Defect ratio changed the most.", before),
    ]);
    for (const turn of turns) {
      expect(turn.kind).toBe("failed");
      // the failure carries a typed reason, never the model's raw protocol text
      if (turn.kind === "failed") {
        expect(turn.detail).not.toMatch(/"kind"\s*:/);
        expect(turn.trace.stateAfter).toBeUndefined();
      }
    }
  });
});

describe("Stage 26.2 §40 — a clarification is structured and commits nothing", () => {
  it("returns the question and options, leaving the conversation state untouched", async () => {
    const before: AnalyticalConversationState = { turnId: "t0", lastMetric: { metricKey: "Defect ratio" } };
    const turn = await withPlanner(
      (round) => (round === 1 ? call("period.latest") : JSON.stringify({ kind: "clarify", question: "Какую норму использовать?", options: ["статистическую", "заданный порог"] })),
      before,
    );
    expect(turn.kind).toBe("clarify");
    if (turn.kind !== "clarify") return;
    expect(turn.options).toEqual(["статистическую", "заданный порог"]);
    expect(turn.question).not.toMatch(/"kind"/);
    // §40 — nothing was committed, and the tool results it did gather are visible in the trace only
    expect(turn.trace.stateAfter).toBeUndefined();
    expect(turn.trace.results.length).toBeGreaterThan(0);
  });
});
