import { describe, expect, it } from "vitest";
import { runAnalyticalEngine, type EngineTurn } from "./engine.js";
import { parsePlannerDecision } from "./planner/planner-prompt.js";
import { EMPTY_ANALYTICAL_STATE, type AnalyticalConversationState } from "./state/conversation-state.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";

const table = fixtureOperations();

async function withPlanner(reply: (round: number, prompt: string) => string, state: AnalyticalConversationState = EMPTY_ANALYTICAL_STATE): Promise<EngineTurn> {
  let round = 0;
  return runAnalyticalEngine({
    turnId: "primary",
    request: "Analyse the table.",
    schema: table.schema,
    grids: table.grids,
    language: "en",
    state,
    decide: (messages: readonly PlannerMessage[]) => {
      round += 1;
      return reply(round, messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"));
    },
    narrate: async () => "",
  });
}

const idOf = (prompt: string, tool: string): string | null => {
  const header = "=== RESULTS SO FAR ===\n";
  const start = prompt.indexOf(header);
  if (start < 0) return null;
  const block = prompt
    .slice(start + header.length)
    .split("\n\n")
    .filter((b) => /^result_\d+ = /.test(b.trim()))
    .find((b) => b.includes(`= ${tool} → `));
  return /^(result_\d+) = /.exec(block?.trim() ?? "")?.[1] ?? null;
};

/** The three-part shape §23/§24/§26 all build on: winner → series → event. */
function buildThreeParts(prompt: string): { readonly next: string | null; readonly winner: string | null; readonly series: string | null; readonly event: string | null } {
  const volatility = idOf(prompt, "analysis.volatility");
  const winner = idOf(prompt, "set.argmax");
  const series = idOf(prompt, "series.get");
  const event = idOf(prompt, "event.max_adjacent_change");
  if (!volatility) return { next: JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", arguments: {} }), winner, series, event };
  if (!winner) return { next: JSON.stringify({ kind: "tool_call", tool: "set.argmax", arguments: { inputRef: volatility, field: "score" } }), winner, series, event };
  if (!series) return { next: JSON.stringify({ kind: "tool_call", tool: "series.get", arguments: { metricRef: winner } }), winner, series, event };
  if (!event) return { next: JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", arguments: { metricRef: winner } }), winner, series, event };
  return { next: null, winner, series, event };
}

const THREE_PART_PLAN = JSON.stringify({
  kind: "plan",
  outputs: [
    { id: "o1", description: "select the metric" },
    { id: "o2", description: "show its series", dependsOn: ["o1"] },
    { id: "o3", description: "its largest adjacent move", dependsOn: ["o1", "o2"] },
  ],
  primaryOutputId: "o3",
});

// --- §4/§5: the plan protocol ----------------------------------------------

describe("Stage 26.5 §4/§5 — a plan states its own answer structure", () => {
  it("keeps the ids the planner chose, its dependencies and its primary", () => {
    const parsed = parsePlannerDecision(THREE_PART_PLAN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.decision.kind !== "plan") return;
    expect(parsed.decision.outputs.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
    expect(parsed.decision.outputs[2]?.dependsOn).toEqual(["o1", "o2"]);
    expect(parsed.decision.primaryOutputId).toBe("o3");
  });

  it("parses the FLAT shape the contract teaches, numbering the ids itself", () => {
    // §17 — this is the wire format the planner is actually asked for. The
    // richer object form stays legal (the tests around this one use it), but
    // three levels of brackets is a shape this model cannot reliably close, so
    // what the contract TEACHES is the flat one 26.4 already proved out.
    const parsed = parsePlannerDecision(
      JSON.stringify({ kind: "plan", outputs: ["the candidate set", "the winner", "its largest move"], primaryOutputId: "o3" }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.decision.kind !== "plan") return;
    expect(parsed.decision.outputs.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
    expect(parsed.decision.primaryOutputId).toBe("o3");
  });

  it("numbers only the outputs the planner left unnamed, never dropping one", () => {
    const parsed = parsePlannerDecision(
      JSON.stringify({ kind: "plan", outputs: [{ id: "o2", description: "first" }, { description: "second" }], primaryOutputId: "o2" }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.decision.kind !== "plan") return;
    // "o2" was taken by the planner's own naming, so the unnamed slot moves on
    // rather than colliding and silently losing a declared output.
    expect(parsed.decision.outputs.map((o) => o.id)).toEqual(["o2", "o3"]);
  });

  it("refuses a multi-output plan that names no principal answer", () => {
    const parsed = parsePlannerDecision(JSON.stringify({ kind: "plan", outputs: ["a", "b"] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MISSING_FIELD");
    expect(parsed.problem.severity).toBe("recoverable");
    expect(parsed.problem.correction).toContain("primaryOutputId");
  });

  it("accepts a single-output plan with no primary — that output IS the answer", () => {
    const parsed = parsePlannerDecision(JSON.stringify({ kind: "plan", outputs: ["just the one thing"] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.decision.kind !== "plan") return;
    expect(parsed.decision.primaryOutputId).toBeUndefined();
  });

  it("refuses a primary that names no declared output", () => {
    const parsed = parsePlannerDecision(JSON.stringify({ kind: "plan", outputs: ["a", "b"], primaryOutputId: "o9" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("INCONSISTENT_PLAN");
    expect(parsed.problem.severity).toBe("recoverable");
  });

  it("refuses a dependency on an output that was never declared, or on itself", () => {
    for (const deps of [["o7"], ["o1"]]) {
      const parsed = parsePlannerDecision(
        JSON.stringify({ kind: "plan", outputs: [{ id: "o1", description: "a", dependsOn: deps }, { id: "o2", description: "b" }], primaryOutputId: "o2" }),
      );
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.problem.code).toBe("INCONSISTENT_PLAN");
    }
  });
});

// --- §23: the binding mismatch ---------------------------------------------

describe("Stage 26.5 §23 — a completion that contradicts the declared primary is re-bound", () => {
  it("returns a recoverable mismatch, then accepts the corrected primary without rerunning a tool", async () => {
    const toolCalls: string[] = [];
    let completions = 0;
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return THREE_PART_PLAN;
      const { next, winner, series, event } = buildThreeParts(prompt);
      if (next) {
        toolCalls.push(JSON.parse(next).tool as string);
        return next;
      }
      const bindings = [
        { outputId: "o1", resultRef: winner! },
        { outputId: "o2", resultRef: series! },
        { outputId: "o3", resultRef: event! },
      ];
      completions += 1;
      // First COMPLETE: every output IS bound — coverage is satisfied — but the
      // answer points at the intermediate selection instead of the declared
      // principal output. Coverage cannot see this; §8 must.
      if (completions === 1) {
        return JSON.stringify({ kind: "complete", primaryResultRef: winner, supportingResultRefs: [series, event], outputBindings: bindings });
      }
      return JSON.stringify({ kind: "complete", primaryResultRef: event, supportingResultRefs: [winner, series], outputBindings: bindings });
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(completions).toBe(2);
    expect(turn.analysis.primary.type).toBe("event");
    // §12 — the correction is budgeted apart from the coverage retry, and cost
    // no tool: each tool ran exactly once across both completions.
    expect(turn.trace.budget?.primaryCorrections).toBe(1);
    expect(turn.trace.budget?.completionRetries).toBe(0);
    expect(new Set(toolCalls).size).toBe(toolCalls.length);
    // §13 — the diagnosis is in the trace, not inferred from the outcome.
    expect(turn.trace.declaredPrimaryOutputId).toBe("o3");
    expect(turn.trace.primaryBindingMismatch).toBe(true);
    expect(turn.trace.primaryCorrectionAttempted).toBe(true);
    expect(turn.trace.primaryCorrectionSucceeded).toBe(true);
    expect(turn.trace.boundPrimaryResultRef).toBe(turn.trace.completePrimaryResultRef);
  });

  it("names the bound result in the correction so the planner can act on it", async () => {
    let correction = "";
    let completions = 0;
    await withPlanner((round, prompt) => {
      if (round === 1) return THREE_PART_PLAN;
      const { next, winner, series, event } = buildThreeParts(prompt);
      if (next) return next;
      if (completions === 1) correction = prompt.slice(prompt.indexOf("=== ERRORS FROM YOUR PREVIOUS CALLS"));
      completions += 1;
      const bindings = [
        { outputId: "o1", resultRef: winner! },
        { outputId: "o2", resultRef: series! },
        { outputId: "o3", resultRef: event! },
      ];
      if (completions === 1) return JSON.stringify({ kind: "complete", primaryResultRef: winner, supportingResultRefs: [], outputBindings: bindings });
      return JSON.stringify({ kind: "complete", primaryResultRef: event, supportingResultRefs: [winner, series], outputBindings: bindings });
    });
    expect(correction).toContain("o3");
    // §7 — structural, and never shown to the user; it names the two refs that
    // disagree rather than telling the planner what the answer should be.
    expect(correction).toContain("primaryResultRef");
  });
});

// --- §24: primary is semantic, not chronological ---------------------------

describe("Stage 26.5 §24/§6 — the LAST result is not the answer", () => {
  it("accepts a completion whose primary precedes a later supporting verification", async () => {
    let completions = 0;
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) {
        return JSON.stringify({
          kind: "plan",
          outputs: [{ id: "o1", description: "the candidate set" }, { id: "o2", description: "the winner among them", dependsOn: ["o1"] }],
          primaryOutputId: "o2",
        });
      }
      const volatility = idOf(prompt, "analysis.volatility");
      const winner = idOf(prompt, "set.argmax");
      const check = idOf(prompt, "series.get");
      if (!volatility) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", arguments: {} });
      if (!winner) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", arguments: { inputRef: volatility, field: "score" } });
      // the planner VERIFIES its answer after finding it; that evidence is the
      // most recent result and must not therefore become the answer
      if (!check) return JSON.stringify({ kind: "tool_call", tool: "series.get", arguments: { metricRef: winner } });
      completions += 1;
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: winner,
        supportingResultRefs: [volatility, check],
        outputBindings: [{ outputId: "o1", resultRef: volatility }, { outputId: "o2", resultRef: winner }],
      });
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(completions).toBe(1);
    expect(turn.analysis.primary.type).toBe("metric_winner");
    expect(turn.trace.primaryBindingMismatch).toBeUndefined();
    expect(turn.trace.budget?.primaryCorrections).toBe(0);
  });
});

// --- §25: plan revision -----------------------------------------------------

describe("Stage 26.5 §25/§10/§11 — a revised plan keeps every result already computed", () => {
  it("accepts a wider plan mid-turn and completes against the new primary", async () => {
    const toolCalls: string[] = [];
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return JSON.stringify({ kind: "plan", outputs: [{ id: "o1", description: "the candidate set" }] });
      const volatility = idOf(prompt, "analysis.volatility");
      const winner = idOf(prompt, "set.argmax");
      if (!volatility) {
        toolCalls.push("analysis.volatility");
        return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", arguments: {} });
      }
      // having seen the first result, the planner realises the request asks for
      // more than it declared, and says so
      if (!winner && !prompt.includes("o2:")) {
        return JSON.stringify({
          kind: "plan",
          outputs: [{ id: "o1", description: "the candidate set" }, { id: "o2", description: "the winner among them", dependsOn: ["o1"] }],
          primaryOutputId: "o2",
        });
      }
      if (!winner) {
        toolCalls.push("set.argmax");
        return JSON.stringify({ kind: "tool_call", tool: "set.argmax", arguments: { inputRef: volatility, field: "score" } });
      }
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: winner,
        supportingResultRefs: [volatility],
        outputBindings: [{ outputId: "o1", resultRef: volatility }, { outputId: "o2", resultRef: winner }],
      });
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    // §11 — the result computed under the FIRST plan survived the revision and
    // was bound by the second; nothing was recomputed.
    expect(toolCalls).toEqual(["analysis.volatility", "set.argmax"]);
    expect(turn.analysis.supporting.map((s) => s.tool)).toContain("analysis.volatility");
    expect(turn.trace.declaredOutputs?.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(turn.trace.declaredPrimaryOutputId).toBe("o2");
    expect(turn.trace.budget?.primaryCorrections).toBe(0);
  });

  it("treats a REWORDED plan of the same shape as a restatement, not a revision", async () => {
    // A live turn spent five rounds re-planning because each declaration was
    // phrased slightly differently and a byte comparison never matched. What
    // makes a revision a revision is a changed answer STRUCTURE.
    let nudges = 0;
    const turn = await withPlanner((round, prompt) => {
      if (prompt.includes("Do not send that plan again")) nudges += 1;
      if (round <= 3) {
        return JSON.stringify({
          kind: "plan",
          outputs: [`the candidate set (attempt ${round})`, `the winner among them, round ${round}`],
          primaryOutputId: "o2",
        });
      }
      const volatility = idOf(prompt, "analysis.volatility");
      const winner = idOf(prompt, "set.argmax");
      if (!volatility) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", arguments: {} });
      if (!winner) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", arguments: { inputRef: volatility, field: "score" } });
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: winner,
        supportingResultRefs: [volatility],
        outputBindings: [{ outputId: "o1", resultRef: volatility }, { outputId: "o2", resultRef: winner }],
      });
    });
    expect(nudges).toBeGreaterThan(0);
    expect(turn.kind).toBe("answered");
  });

  it("does NOT nudge a plan that genuinely changes its principal answer", async () => {
    let nudged = false;
    const turn = await withPlanner((round, prompt) => {
      if (prompt.includes("Do not send that plan again")) nudged = true;
      if (round === 1) return JSON.stringify({ kind: "plan", outputs: ["the candidate set", "the winner"], primaryOutputId: "o1" });
      if (round === 2) return JSON.stringify({ kind: "plan", outputs: ["the candidate set", "the winner"], primaryOutputId: "o2" });
      const volatility = idOf(prompt, "analysis.volatility");
      const winner = idOf(prompt, "set.argmax");
      if (!volatility) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", arguments: {} });
      if (!winner) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", arguments: { inputRef: volatility, field: "score" } });
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: winner,
        supportingResultRefs: [volatility],
        outputBindings: [{ outputId: "o1", resultRef: volatility }, { outputId: "o2", resultRef: winner }],
      });
    });
    expect(nudged).toBe(false);
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.trace.declaredPrimaryOutputId).toBe("o2");
  });

  it("still tells a planner that re-sends the SAME plan to get on with it", async () => {
    let nudged = false;
    const turn = await withPlanner((round, prompt) => {
      if (prompt.includes("Do not send that plan again")) nudged = true;
      if (round <= 2) return THREE_PART_PLAN;
      const { next, winner, series, event } = buildThreeParts(prompt);
      if (next) return next;
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: event,
        supportingResultRefs: [winner, series],
        outputBindings: [{ outputId: "o1", resultRef: winner }, { outputId: "o2", resultRef: series }, { outputId: "o3", resultRef: event }],
      });
    });
    expect(nudged).toBe(true);
    expect(turn.kind).toBe("answered");
  });
});

// --- §26: the engine is not an intent compiler ------------------------------

describe("Stage 26.5 §26/§14 — the engine never overrides the planner's semantic choice", () => {
  it("accepts a primary the planner declared, even when a later output exists", async () => {
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) {
        // the planner names the FIRST output as principal — arguably the wrong
        // reading of a request that builds to o3, but its reading to make
        return JSON.stringify({
          kind: "plan",
          outputs: [
            { id: "o1", description: "select the metric" },
            { id: "o2", description: "show its series", dependsOn: ["o1"] },
            { id: "o3", description: "its largest adjacent move", dependsOn: ["o1"] },
          ],
          primaryOutputId: "o1",
        });
      }
      const { next, winner, series, event } = buildThreeParts(prompt);
      if (next) return next;
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: winner,
        supportingResultRefs: [series, event],
        outputBindings: [{ outputId: "o1", resultRef: winner }, { outputId: "o2", resultRef: series }, { outputId: "o3", resultRef: event }],
      });
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    // The engine had every structural fact it would need to "improve" this —
    // o3 is declared, bound, later, and depends on o1 — and still did not.
    // A wrong primary here is a PLANNER semantic failure to be measured (§14),
    // not something the engine quietly rewrites.
    expect(turn.analysis.primary.type).toBe("metric_winner");
    expect(turn.trace.primaryBindingMismatch).toBeUndefined();
    expect(turn.trace.declaredPrimaryOutputId).toBe("o1");
    expect(turn.trace.completePrimaryResultRef).toBe(turn.trace.boundPrimaryResultRef);
  });

  it("accepts an unbound primary declaration rather than inventing a binding", async () => {
    // Coverage owns "every output must be bound". If the planner binds nothing,
    // the primary check has nothing to verify and must stay silent instead of
    // picking a result to call the answer.
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return JSON.stringify({ kind: "plan", outputs: [{ id: "o1", description: "the only thing asked for" }], primaryOutputId: "o1" });
      const volatility = idOf(prompt, "analysis.volatility");
      if (!volatility) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", arguments: {} });
      return JSON.stringify({ kind: "complete", primaryResultRef: volatility, supportingResultRefs: [] });
    });
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.trace.primaryBindingMismatch).toBeUndefined();
  });
});

// --- §27: coverage is still checked, as a separate dimension ----------------

describe("Stage 26.5 §27 — primary consistency does not replace output coverage", () => {
  it("catches an unbound output first, then the contradicted primary", async () => {
    const seen: string[] = [];
    let completions = 0;
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return THREE_PART_PLAN;
      const { next, winner, series, event } = buildThreeParts(prompt);
      if (next) return next;
      const errors = prompt.slice(prompt.indexOf("=== ERRORS FROM YOUR PREVIOUS CALLS"));
      if (completions === 1) seen.push(errors.includes("does not account for every output") ? "coverage" : "other");
      if (completions === 2) seen.push(errors.includes("principal answer") ? "primary" : "other");
      completions += 1;
      // 1st: o3 unbound          → coverage
      // 2nd: bound, wrong primary → primary
      // 3rd: consistent
      if (completions === 1) {
        return JSON.stringify({
          kind: "complete",
          primaryResultRef: winner,
          supportingResultRefs: [series],
          outputBindings: [{ outputId: "o1", resultRef: winner }, { outputId: "o2", resultRef: series }],
        });
      }
      const bindings = [
        { outputId: "o1", resultRef: winner! },
        { outputId: "o2", resultRef: series! },
        { outputId: "o3", resultRef: event! },
      ];
      if (completions === 2) return JSON.stringify({ kind: "complete", primaryResultRef: winner, supportingResultRefs: [series, event], outputBindings: bindings });
      return JSON.stringify({ kind: "complete", primaryResultRef: event, supportingResultRefs: [winner, series], outputBindings: bindings });
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(seen).toEqual(["coverage", "primary"]);
    expect(turn.trace.budget?.completionRetries).toBe(1);
    expect(turn.trace.budget?.primaryCorrections).toBe(1);
    expect(turn.analysis.primary.type).toBe("event");
  });

  it("bounds the correction: a planner that keeps contradicting itself is accepted and recorded, never overridden", async () => {
    let completions = 0;
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return THREE_PART_PLAN;
      const { next, winner, series, event } = buildThreeParts(prompt);
      if (next) return next;
      completions += 1;
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: winner,
        supportingResultRefs: [series, event],
        outputBindings: [{ outputId: "o1", resultRef: winner }, { outputId: "o2", resultRef: series }, { outputId: "o3", resultRef: event }],
      });
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    // §12/§14 — exactly one correction is offered; after that the planner's own
    // completion stands, and the disagreement is a measured fact.
    expect(completions).toBe(2);
    expect(turn.analysis.primary.type).toBe("metric_winner");
    expect(turn.trace.primaryBindingMismatch).toBe(true);
    expect(turn.trace.primaryCorrectionSucceeded).toBeUndefined();
  });
});

// --- §17: the raw text of a refused decision is kept ------------------------

describe("Stage 26.5 §17 — a refused decision keeps the model's actual text", () => {
  it("records the raw output, bounded and printable", async () => {
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return `Sure! Here you go:\n\n{"kind":"tool_call","tool":"analysis.volatility",}`;
      const volatility = idOf(prompt, "analysis.volatility");
      if (!volatility) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", arguments: {} });
      return JSON.stringify({ kind: "complete", primaryResultRef: volatility, supportingResultRefs: [] });
    });
    expect(turn.kind).toBe("answered");
    const refused = turn.trace.rounds.find((r) => r.decisionProblem);
    expect(refused?.decisionProblem?.code).toBe("MALFORMED_JSON");
    expect(refused?.rawDecision).toContain("Sure! Here you go");
    expect(refused?.rawDecision).toContain("analysis.volatility");
  });
});
