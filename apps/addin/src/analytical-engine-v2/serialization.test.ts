// ---------------------------------------------------------------------------
// Stage 26.6 §18–§26 — planner protocol serialization.
//
// ONE PLANNER ROUND PRODUCES ONE DECISION. When the model violates that, the
// engine must name the violation, preserve every bit of state, and ask again —
// without guessing which decision was meant and without speculatively running
// any of them (§45).
//
// The shapes exercised here are the ones the Stage 26.5 forensics actually
// recorded: newline-separated tool calls, a plan followed by the whole route
// the model intended, and one response with a code fence around a second
// object. Metric labels are generic — what is under test is structure.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { runAnalyticalEngine, type EngineTurn } from "./engine.js";
import { parsePlannerDecision } from "./planner/planner-prompt.js";
import { scanDecisions } from "./planner/decision-scan.js";
import { EMPTY_ANALYTICAL_STATE, type AnalyticalConversationState } from "./state/conversation-state.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";

const table = fixtureOperations();

async function withPlanner(reply: (round: number, prompt: string) => string, state: AnalyticalConversationState = EMPTY_ANALYTICAL_STATE): Promise<EngineTurn> {
  let round = 0;
  return runAnalyticalEngine({
    turnId: "serialization",
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

const VOLATILITY = '{"kind":"tool_call","tool":"analysis.volatility","arguments":{}}';
const SERIES = '{"kind":"tool_call","tool":"series.get","arguments":{"metric":"Defect ratio"}}';
const EVENT = '{"kind":"tool_call","tool":"event.max_adjacent_change","arguments":{"metric":"Defect ratio","basis":"percentage"}}';

// --- §18: a single decision inside harmless formatting -----------------------

describe("Stage 26.6 §18/§4 — one decision wrapped in formatting is still one decision", () => {
  it("accepts a fenced single object with no protocol correction", () => {
    const parsed = parsePlannerDecision('```json\n{"kind":"complete","primaryResultRef":"result_1"}\n```');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.decision.kind).toBe("complete");
    expect(parsed.serialization).toBe("single");
  });

  it("accepts a bare single object", () => {
    const parsed = parsePlannerDecision(VOLATILITY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.serialization).toBe("single");
  });

  it("accepts one object preceded by short non-semantic text, and says it was wrapped", () => {
    const parsed = parsePlannerDecision(`Sure, here is the next step:\n\n${VOLATILITY}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.decision.kind).toBe("tool_call");
    expect(parsed.serialization).toBe("wrapped_single");
  });
});

// --- §19/§20: several decisions ---------------------------------------------

describe("Stage 26.6 §19/§20/§10 — several decisions are named, not resolved", () => {
  it("classifies two concatenated objects as MULTIPLE_DECISIONS", () => {
    const parsed = parsePlannerDecision(`\n\n${SERIES}\n${EVENT}`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MULTIPLE_DECISIONS");
    expect(parsed.problem.severity).toBe("recoverable");
    expect(parsed.serialization).toBe("concatenated");
    expect(parsed.problem.correction).toContain("exactly ONE planner decision");
  });

  it("classifies a top-level array of decisions as MULTIPLE_DECISIONS, not a bad container", () => {
    const parsed = parsePlannerDecision(`[${SERIES},${EVENT}]`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MULTIPLE_DECISIONS");
    expect(parsed.serialization).toBe("array");
  });

  it("still rejects a single-element array as a bad container", () => {
    const parsed = parsePlannerDecision(`[${SERIES}]`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("BAD_CONTAINER");
  });

  it("classifies a plan followed by the route the model intended to take", () => {
    const parsed = parsePlannerDecision(
      '{"kind":"plan","outputs":["a","b"],"primaryOutputId":"o2"}\n' + SERIES + "\n" + EVENT,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MULTIPLE_DECISIONS");
    expect(parsed.error).toContain("3 decisions");
  });

  it("treats one complete object plus an unfinished second decision as MULTIPLE, never running the first", () => {
    // Recorded live: a batch whose later members were cut off mid-string. §5
    // forbids taking the first object, and a half-written second decision is
    // still evidence the response carried more than one.
    const parsed = parsePlannerDecision(`${SERIES}\n{"kind":"tool_call","tool":"set.argmax","arguments":{"inputRef":"result_2`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MULTIPLE_DECISIONS");
  });

  it("executes ZERO tools from a rejected batch", async () => {
    const tools: string[] = [];
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return `${VOLATILITY}\n${SERIES}`;
      const volatility = idOf(prompt, "analysis.volatility");
      if (!volatility) {
        tools.push("analysis.volatility");
        return VOLATILITY;
      }
      return JSON.stringify({ kind: "complete", primaryResultRef: volatility, supportingResultRefs: [] });
    });
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    // the batch named analysis.volatility first; it ran only when sent alone
    expect(tools).toEqual(["analysis.volatility"]);
    expect(turn.trace.rounds.filter((r) => r.toolResultId).length).toBe(1);
  });
});

// --- §21: recovery ----------------------------------------------------------

describe("Stage 26.6 §21/§7 — a rejected batch costs a correction, not state", () => {
  it("recovers to a normal single decision with the ResultStore intact", async () => {
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return JSON.stringify({ kind: "plan", outputs: ["the candidates", "the winner"], primaryOutputId: "o2" });
      const volatility = idOf(prompt, "analysis.volatility");
      const winner = idOf(prompt, "set.argmax");
      if (!volatility) return VOLATILITY;
      // a batch AFTER a result already exists: the store must survive it
      if (!winner && round === 3) return `${SERIES}\n${EVENT}`;
      if (!winner) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", arguments: { inputRef: volatility, field: "score" } });
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: winner,
        supportingResultRefs: [volatility],
        outputBindings: [{ outputId: "o1", resultRef: volatility }, { outputId: "o2", resultRef: winner }],
      });
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.analysis.primary.type).toBe("metric_winner");
    // plan state, declared outputs and the earlier result all survived
    expect(turn.trace.declaredOutputs).toHaveLength(2);
    expect(turn.trace.declaredPrimaryOutputId).toBe("o2");
    expect(turn.analysis.supporting.map((s) => s.tool)).toContain("analysis.volatility");
    expect(turn.trace.budget?.protocolCorrections).toBe(1);
    // §7 — it cost no analytical tool call
    expect(turn.trace.budget?.toolCalls).toBe(2);
    expect(turn.trace.serializationClasses).toContain("concatenated");
  });
});

// --- §22: bounded ------------------------------------------------------------

describe("Stage 26.6 §22/§19 — a planner that keeps batching fails closed", () => {
  it("terminates on protocol, not on budget, and runs nothing", async () => {
    let calls = 0;
    const turn = await withPlanner(() => {
      calls += 1;
      return `${VOLATILITY}\n${SERIES}`;
    });
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.reason).toBe("invalid_decision");
    expect(turn.reason).not.toBe("planner_rounds");
    // bounded by the protocol allowance, well short of the analytical budget
    expect(calls).toBeLessThanOrEqual(4);
    expect(turn.trace.rounds.every((r) => r.toolResultId === undefined)).toBe(true);
  });
});

// --- §23/§24: the scanner ----------------------------------------------------

describe("Stage 26.6 §23/§24/§12 — the scanner reads JSON, not braces", () => {
  it("does not treat braces inside a string as another object", () => {
    const scan = scanDecisions('{"kind":"clarify","question":"which one, {example} or the other?","options":["a","b"]}');
    expect(scan.serialization).toBe("single");
    expect(scan.objects).toHaveLength(1);
  });

  it("does not split on an escaped quote", () => {
    const scan = scanDecisions('{"kind":"clarify","question":"the \\"first\\" one? {x}","options":[]}');
    expect(scan.serialization).toBe("single");
  });

  it("does not split on an escaped backslash before a quote", () => {
    const scan = scanDecisions('{"kind":"tool_call","tool":"set.filter","arguments":{"value":"a\\\\"}}\n' + SERIES);
    expect(scan.serialization).toBe("concatenated");
    expect(scan.objects).toHaveLength(2);
  });

  it("handles nested objects and arrays inside one decision", () => {
    const scan = scanDecisions('{"kind":"complete","primaryResultRef":"result_1","outputBindings":[{"outputId":"o1","resultRef":"result_1"}]}');
    expect(scan.serialization).toBe("single");
    expect(scan.objects).toHaveLength(1);
  });

  it("bounds its input rather than scanning a runaway generation", () => {
    const scan = scanDecisions(`{"kind":"clarify","question":"${"x".repeat(80_000)}"}`);
    expect(scan.objects).toHaveLength(0);
    expect(scan.serialization).toBe("truncated");
  });
});

// --- §25: truncation is not batching ----------------------------------------

describe("Stage 26.6 §25/§14 — a cut-off decision stays malformed", () => {
  it("reports MALFORMED_JSON and completes no brace", () => {
    const parsed = parsePlannerDecision('{"kind":"tool_call","tool":"series.get","arguments":{"metric":"Defect ratio"');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MALFORMED_JSON");
    expect(parsed.problem.code).not.toBe("MULTIPLE_DECISIONS");
    expect(parsed.serialization).toBe("truncated");
  });

  it("reports MALFORMED_JSON for balanced but invalid syntax, repairing nothing", () => {
    const parsed = parsePlannerDecision('{"kind":"tool_call","tool":"series.get",}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MALFORMED_JSON");
    expect(parsed.serialization).toBe("invalid");
  });
});

// --- §26: safety outranks serialization --------------------------------------

describe("Stage 26.6 §26/§13 — an unsafe object in a batch is fatal, not a formatting note", () => {
  it("fails closed when any object in the batch carries an executable field", () => {
    const parsed = parsePlannerDecision(`${VOLATILITY}\n{"kind":"tool_call","tool":"series.get","arguments":{},"exec":"rm -rf /"}`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("UNSAFE_PAYLOAD");
    expect(parsed.problem.severity).toBe("fatal");
    expect(parsed.problem.correction).toBe("");
  });

  it("offers no serialization correction for an unsafe single decision either", () => {
    const parsed = parsePlannerDecision('{"kind":"tool_call","tool":"series.get","arguments":{},"sql":"select 1"}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("UNSAFE_PAYLOAD");
    expect(parsed.problem.severity).toBe("fatal");
  });

  it("terminates the turn immediately on an unsafe batch, running nothing", async () => {
    const turn = await withPlanner(() => `${VOLATILITY}\n{"kind":"tool_call","tool":"series.get","arguments":{},"shell":"x"}`);
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.reason).toBe("invalid_decision");
    expect(turn.trace.rounds).toHaveLength(1);
    expect(turn.trace.rounds[0]?.toolResultId).toBeUndefined();
  });
});

// --- §16: the scan is the only authority on shape ----------------------------

describe("Stage 26.6 §16 — a semantic refusal never reports a shape of its own", () => {
  it("labels a well-formed single object that carries a misplaced argument as single", () => {
    // The diagnostic run reported three "invalid" serializations that were in
    // fact three clean single objects refused for WHAT they said. Counting the
    // shape from the refusal path rather than the scan is how that happened.
    const parsed = parsePlannerDecision('{"kind":"tool_call","tool":"period.previous","ofRef":"result_1"}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MISPLACED_ARGUMENTS");
    expect(parsed.serialization).toBe("single");
    expect(parsed.problem.serialization).toBe("single");
  });

  it("labels a fenced object refused for a missing field as single, not invalid", () => {
    const parsed = parsePlannerDecision('```json\n{"kind":"tool_call","arguments":{}}\n```');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MISSING_FIELD");
    expect(parsed.serialization).toBe("single");
  });

  it("labels a plan refused for naming no principal answer as single", () => {
    const parsed = parsePlannerDecision('{"kind":"plan","outputs":["a","b"]}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MISSING_FIELD");
    expect(parsed.serialization).toBe("single");
  });
});

// --- the shapes the live runs actually produced ------------------------------

describe("Stage 26.6 §2 — every serialization shape the Stage 26.5 runs recorded", () => {
  const corpus: readonly { readonly name: string; readonly raw: string; readonly expect: string }[] = [
    { name: "two tool calls, newline separated", raw: `\n\n${SERIES}\n${EVENT}`, expect: "concatenated" },
    {
      name: "four independent tool calls (a fan-out over metrics)",
      raw: `\n\n${EVENT}\n${EVENT}\n${EVENT}\n${EVENT}`,
      expect: "concatenated",
    },
    {
      name: "plan then a fenced tool call",
      raw: '\n\n{"kind":"plan","outputs":["a","b"],"primaryOutputId":"o2"}\n```json\n' + VOLATILITY + "\n```",
      expect: "concatenated",
    },
    {
      name: "plan then two tool calls, the second needing a result not yet produced",
      raw: '\n\n{"kind":"plan","outputs":["a"],"primaryOutputId":"o1"}\n' +
        '{"kind":"tool_call","tool":"period.previous","arguments":{"ofRef":"result_1"}}\n' +
        '{"kind":"tool_call","tool":"change.compare_periods","arguments":{"startPeriodRef":"result_2","endPeriodRef":"result_1"}}',
      expect: "concatenated",
    },
  ];

  for (const c of corpus) {
    it(`classifies: ${c.name}`, () => {
      const scan = scanDecisions(c.raw);
      expect(scan.serialization).toBe(c.expect);
      expect(scan.objects.length).toBeGreaterThanOrEqual(2);
      const parsed = parsePlannerDecision(c.raw);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.problem.code).toBe("MULTIPLE_DECISIONS");
    });
  }

  it("none of these would have been safe to run the first object of", () => {
    // Recorded live: a later object referring to `result_2` before anything has
    // produced it. Speculative execution of a batch is not a smaller version of
    // the iterative loop — it is a different, wrong loop (§9).
    const raw = '{"kind":"tool_call","tool":"period.latest","arguments":{}}\n' +
      '{"kind":"tool_call","tool":"period.previous","arguments":{"ofRef":"result_1"}}';
    const scan = scanDecisions(raw);
    expect(scan.objects).toHaveLength(2);
    expect(scan.objects[1]).toContain("result_1");
    expect(parsePlannerDecision(raw).ok).toBe(false);
  });
});
