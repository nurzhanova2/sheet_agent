import { describe, expect, it } from "vitest";
import { runAnalyticalEngine, resumableSuspension, type EngineTurn } from "./engine.js";
import { buildEngineContext } from "./context/build-context.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { DECLARED_PROJECTIONS, projects, sameTable } from "./state/state-refs.js";
import { EMPTY_ANALYTICAL_STATE, MAX_RECENT_RESULTS, type AnalyticalConversationState } from "./state/conversation-state.js";
import { fixtureOperations, buildDatedTable } from "./__fixtures__/synthetic-tables.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";

const table = fixtureOperations();
const METRIC = "Defect ratio";

type Reply = (round: number, prompt: string) => string;

interface TurnOptions {
  readonly state?: AnalyticalConversationState;
  readonly schema?: typeof table.schema;
  readonly grids?: typeof table.grids;
  readonly narrate?: () => Promise<string>;
  readonly request?: string;
}

let turnSeq = 0;

async function turn(reply: Reply, options: TurnOptions = {}): Promise<EngineTurn> {
  let round = 0;
  turnSeq += 1;
  return runAnalyticalEngine({
    turnId: `t${turnSeq}`,
    request: options.request ?? "Analyse the table.",
    schema: options.schema ?? table.schema,
    grids: options.grids ?? table.grids,
    language: "en",
    state: options.state ?? EMPTY_ANALYTICAL_STATE,
    decide: (messages: readonly PlannerMessage[]) => {
      round += 1;
      return reply(round, messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"));
    },
    narrate: options.narrate ?? (async () => ""),
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

const call = (tool: string, args: Record<string, unknown> = {}): string => JSON.stringify({ kind: "tool_call", tool, arguments: args });
const complete = (primary: string, supporting: readonly string[] = []): string =>
  JSON.stringify({ kind: "complete", primaryResultRef: primary, supportingResultRefs: supporting });

function stateOf(t: EngineTurn): AnalyticalConversationState {
  if (t.kind === "failed") throw new Error(`turn failed: ${t.detail}`);
  return t.state;
}

/** Turn 1 of most chains: rank the metrics by volatility and name a winner. */
async function rankTurn(state = EMPTY_ANALYTICAL_STATE): Promise<EngineTurn> {
  return turn((_r, prompt) => {
    const vol = idOf(prompt, "analysis.volatility");
    const win = idOf(prompt, "set.argmax");
    if (!vol) return call("analysis.volatility");
    if (!win) return call("set.argmax", { inputRef: vol, field: "score" });
    return complete(win, [vol]);
  }, { state });
}

// --- §43: the five-turn chain ------------------------------------------------

describe("Stage 26.7 §43/§22/§52 — a five-turn chain keeps its lineage", () => {
  it("narrows the metric universe at every step and never widens back", async () => {
    // 1 — compare the last two periods: the whole table is in play
    const t1 = await turn((_r, prompt) => {
      const latest = idOf(prompt, "period.latest");
      const prev = idOf(prompt, "period.previous");
      const cmp = idOf(prompt, "change.compare_periods");
      if (!latest) return call("period.latest");
      if (!prev) return call("period.previous", { ofRef: latest });
      if (!cmp) return call("change.compare_periods", { startPeriodRef: prev, endPeriodRef: latest });
      return complete(cmp);
    });
    const s1 = stateOf(t1);
    const universe = s1.lastMetricSet?.metricKeys ?? [];
    expect(universe.length).toBeGreaterThan(2);

    // 2 — keep only what fell: the set NARROWS
    const t2 = await turn((_r, prompt) => {
      const prev = idOf(prompt, "reference.last_result");
      const filtered = idOf(prompt, "set.filter");
      if (!prev) return call("reference.last_result");
      if (!filtered) return call("set.filter", { inputRef: prev, field: "percentageChange", op: "lt", value: 0 });
      return complete(filtered);
    }, { state: s1 });
    const s2 = stateOf(t2);
    expect(s2.lastMetricSet!.metricKeys.length).toBeLessThan(universe.length);
    const narrowed = s2.lastMetricSet!.metricKeys;

    // 3 — rank within that narrowed set: the winner must come from it, and the
    // set carried forward must STILL be the narrowed one, not the whole table
    const t3 = await turn((_r, prompt) => {
      const set = idOf(prompt, "reference.last_result");
      const win = idOf(prompt, "set.argmax");
      if (!set) return call("reference.last_result");
      if (!win) return call("set.argmax", { inputRef: set, field: "percentageChange", magnitude: true });
      return complete(win, [set]);
    }, { state: s2 });
    const s3 = stateOf(t3);
    expect(narrowed).toContain(s3.lastMetric!.metricKey);
    expect(s3.lastMetricSet!.metricKeys).toEqual(narrowed);

    // 4 — the winner's history
    const t4 = await turn((_r, prompt) => {
      const m = idOf(prompt, "reference.last_metric");
      const series = idOf(prompt, "series.get");
      if (!m) return call("reference.last_metric");
      if (!series) return call("series.get", { metricRef: m });
      return complete(series);
    }, { state: s3 });
    const s4 = stateOf(t4);
    expect(s4.lastSeries?.metricKey).toBe(s3.lastMetric!.metricKey);

    // 5 — its largest adjacent move
    const t5 = await turn((_r, prompt) => {
      const m = idOf(prompt, "reference.last_metric");
      const ev = idOf(prompt, "event.max_adjacent_change");
      if (!m) return call("reference.last_metric");
      if (!ev) return call("event.max_adjacent_change", { metricRef: m });
      return complete(ev);
    }, { state: s4 });
    const s5 = stateOf(t5);
    expect(s5.lastEvent?.metricKey).toBe(s3.lastMetric!.metricKey);
    // the whole chain agrees about which metric it is about
    expect(s5.lastMetric!.metricKey).toBe(s5.lastEvent!.metricKey);
    // §7 — every committed reference knows where it came from
    for (const lineage of [s5.lastMetric?.lineage, s5.lastEvent?.lineage, s5.lastMetricSet?.lineage, s5.lastAnalysis?.lineage]) {
      expect(lineage?.resultId).toMatch(/^result_\d+$/);
      expect(lineage?.sourceVersion).toBe(table.schema.sourceVersion);
    }
  });
});

// --- §44: narration is not memory -------------------------------------------

describe("Stage 26.7 §44/§35/§36 — a narrator failure cannot cost the next turn its context", () => {
  it("commits state anyway, and the follow-up resolves the reference", async () => {
    const t1 = await rankTurn();
    expect(t1.kind).toBe("answered");
    const withFailure = await turn((_r, prompt) => {
      const vol = idOf(prompt, "analysis.volatility");
      const win = idOf(prompt, "set.argmax");
      if (!vol) return call("analysis.volatility");
      if (!win) return call("set.argmax", { inputRef: vol, field: "score" });
      return complete(win, [vol]);
    }, {
      narrate: async () => {
        throw new Error("narrator exploded");
      },
    });
    expect(withFailure.kind).toBe("answered");
    if (withFailure.kind !== "answered") return;
    expect(withFailure.trace.narratorStatus).toBe("deterministic");
    const s = withFailure.state;
    expect(s.lastMetric?.metricKey).toBeTruthy();

    // the follow-up reaches the metric the failed narration never described
    const t2 = await turn((_r, prompt) => {
      const m = idOf(prompt, "reference.last_metric");
      const series = idOf(prompt, "series.get");
      if (!m) return call("reference.last_metric");
      if (!series) return call("series.get", { metricRef: m });
      return complete(series);
    }, { state: s });
    expect(t2.kind).toBe("answered");
    if (t2.kind !== "answered") return;
    expect(t2.analysis.primary.metricKeys).toEqual([s.lastMetric!.metricKey]);
  });
});

// --- §45/§46: selection drift and table switch -------------------------------

describe("Stage 26.7 §45/§18 — moving the selection inside a known table keeps the conversation", () => {
  it("survives a new turn over the same sheet and range", async () => {
    const s1 = stateOf(await rankTurn());
    expect(sameTable(s1, table.schema)).toBe(true);
    const t2 = await turn((_r, prompt) => {
      const m = idOf(prompt, "reference.last_metric");
      if (!m) return call("reference.last_metric");
      return complete(m);
    }, { state: s1 });
    expect(t2.kind).toBe("answered");
    if (t2.kind !== "answered") return;
    expect(t2.analysis.primary.metricKeys).toEqual([s1.lastMetric!.metricKey]);
  });
});

describe("Stage 26.7 §46/§19 — a different table cannot silently inherit the old metric", () => {
  it("refuses the foreign reference instead of applying it to the new data", async () => {
    const s1 = stateOf(await rankTurn());
    const other = buildDatedTable("Other", [45292, 45627, 45962], {
      "Alpha reading": [10, 12, 11],
      "Beta reading": [500, 480, 470],
    });
    let refusal = "";
    const t2 = await turn((round, prompt) => {
      if (round === 1) return call("reference.last_metric");
      refusal = prompt.slice(prompt.indexOf("=== ERRORS FROM YOUR PREVIOUS CALLS"));
      const schemaResult = idOf(prompt, "schema.describe");
      if (!schemaResult) return call("schema.describe");
      return complete(schemaResult);
    }, { state: s1, schema: other.schema, grids: other.grids });

    expect(refusal).toContain("INCOMPATIBLE_REFERENCE");
    expect(refusal).toContain("different table");
    if (t2.kind === "answered") {
      // whatever it answered, it is NOT about the old table's metric
      expect(t2.analysis.primary.metricKeys).not.toContain(s1.lastMetric!.metricKey);
    }
  });
});

// --- §47: stale data ---------------------------------------------------------

describe("Stage 26.7 §47/§17 — a reference over changed data is stale, not silently reused", () => {
  it("refuses with STALE_REFERENCE and computes nothing from the old values", async () => {
    const s1 = stateOf(await rankTurn());
    const moved = fixtureOperations("v2");
    let refusal = "";
    await turn((round, prompt) => {
      if (round === 1) return call("reference.last_result");
      refusal = prompt.slice(prompt.indexOf("=== ERRORS FROM YOUR PREVIOUS CALLS"));
      const vol = idOf(prompt, "analysis.volatility");
      if (!vol) return call("analysis.volatility");
      return complete(vol);
    }, { state: s1, schema: moved.schema, grids: moved.grids });

    expect(refusal).toContain("STALE_REFERENCE");
    expect(refusal).toContain("recompute");
  });
});

// --- §48/§49: clarification ---------------------------------------------------

describe("Stage 26.7 §48/§30 — answering a clarification RESUMES the task", () => {
  it("keeps the results already computed and reruns no tool", async () => {
    const calls: string[] = [];
    const t1 = await turn((_r, prompt) => {
      const vol = idOf(prompt, "analysis.volatility");
      if (!vol) {
        calls.push("analysis.volatility");
        return call("analysis.volatility");
      }
      return JSON.stringify({ kind: "clarify", question: "Which threshold do you mean?", options: ["statistical", "a fixed value"] });
    }, { request: "Compare that indicator with the norm." });

    expect(t1.kind).toBe("clarify");
    if (t1.kind !== "clarify") return;
    const suspended = t1.state.suspended;
    expect(suspended).toBeTruthy();
    expect(suspended!.request).toBe("Compare that indicator with the norm.");
    expect(suspended!.results.length).toBeGreaterThan(0);

    // the reply is a bare "20%" — meaningless outside the suspended task
    let sawResume = false;
    let sawOriginal = false;
    const t2 = await turn((_r, prompt) => {
      sawResume = prompt.includes("YOU ASKED FOR A CLARIFICATION");
      sawOriginal = prompt.includes("Compare that indicator with the norm.");
      const vol = idOf(prompt, "analysis.volatility");
      const win = idOf(prompt, "set.argmax");
      if (!vol) {
        calls.push("analysis.volatility");
        return call("analysis.volatility");
      }
      if (!win) {
        calls.push("set.argmax");
        return call("set.argmax", { inputRef: vol, field: "score" });
      }
      return complete(win, [vol]);
    }, { state: t1.state, request: "20%" });

    expect(sawResume).toBe(true);
    expect(sawOriginal).toBe(true);
    expect(t2.kind).toBe("answered");
    // §48 — analysis.volatility ran ONCE, in turn 1; the resume reused it
    expect(calls).toEqual(["analysis.volatility", "set.argmax"]);
    // §33 — the suspension does not survive the turn that consumed it
    if (t2.kind === "answered") expect(t2.state.suspended).toBeUndefined();
  });
});

describe("Stage 26.7 §49/§33 — a suspension never hijacks a later message", () => {
  it("is dropped when the data it was computed over has moved on", async () => {
    const t1 = await turn((_r, prompt) => {
      const vol = idOf(prompt, "analysis.volatility");
      if (!vol) return call("analysis.volatility");
      return JSON.stringify({ kind: "clarify", question: "Which threshold?", options: [] });
    }, { request: "Compare that indicator with the norm." });
    expect(t1.kind).toBe("clarify");
    if (t1.kind !== "clarify") return;

    const moved = fixtureOperations("v2");
    // §32 — the table changed, so the suspended analysis must not be resumed
    expect(resumableSuspension(t1.state, moved.schema)).toBeNull();
    // and on the table it was computed over, it still is
    expect(resumableSuspension(t1.state, table.schema)).not.toBeNull();
  });

  it("is dropped when the next message is handled on a different table", async () => {
    const t1 = await turn((_r, prompt) => {
      const vol = idOf(prompt, "analysis.volatility");
      if (!vol) return call("analysis.volatility");
      return JSON.stringify({ kind: "clarify", question: "Which threshold?", options: [] });
    }, { request: "Compare that indicator with the norm." });
    if (t1.kind !== "clarify") return;
    const other = buildDatedTable("Other", [45292, 45627], { "Alpha reading": [1, 2] });
    expect(resumableSuspension(t1.state, other.schema)).toBeNull();
  });

  it("does not resume a turn whose planner never asked anything", async () => {
    const s = stateOf(await rankTurn());
    expect(s.suspended).toBeUndefined();
    expect(resumableSuspension(s, table.schema)).toBeNull();
  });
});

// --- §50: no history ---------------------------------------------------------

describe("Stage 26.7 §50/§15 — with nothing to refer to, the engine does not guess", () => {
  it("reports absence with this turn's results, and never invents a metric", async () => {
    let refusal = "";
    await turn((round, prompt) => {
      if (round === 1) return call("reference.last_metric");
      refusal = prompt.slice(prompt.indexOf("=== ERRORS FROM YOUR PREVIOUS CALLS"));
      return JSON.stringify({ kind: "clarify", question: "Which indicator do you mean?", options: [] });
    }, { request: "Show its history." });
    expect(refusal).toContain("CAPABILITY_UNAVAILABLE");
    expect(refusal).toContain("references");
  });

  it("a clarification question carries no engine vocabulary", async () => {
    const t = await turn((round) => {
      if (round === 1) return call("reference.last_metric");
      return JSON.stringify({ kind: "clarify", question: "Which indicator do you mean?", options: ["Line load", "Defect ratio"] });
    }, { request: "Show its history." });
    expect(t.kind).toBe("clarify");
    if (t.kind !== "clarify") return;
    for (const forbidden of ["NO_PREVIOUS_RESULT", "INCOMPATIBLE_REFERENCE", "STALE_REFERENCE", "result_"]) {
      expect(t.question).not.toContain(forbidden);
    }
  });
});

// --- §51: the current request wins -------------------------------------------

describe("Stage 26.7 §51/§21 — memory never outranks an explicit current request", () => {
  it("uses the period the request names, not the one state remembers", async () => {
    // every canonical period the table has, straight from the engine
    const probe = await turn((_r, prompt) => {
      const list = idOf(prompt, "period.list");
      if (!list) return call("period.list");
      return complete(list);
    });
    if (probe.kind !== "answered") throw new Error("probe failed");
    const canonicals = probe.analysis.primary.periodCanonicals;
    expect(canonicals.length).toBeGreaterThanOrEqual(3);
    const [first, second] = canonicals;

    // turn 1 remembers the LAST two periods
    const s1 = stateOf(await turn((_r, prompt) => {
      const latest = idOf(prompt, "period.latest");
      const prev = idOf(prompt, "period.previous");
      const cmp = idOf(prompt, "change.compare_periods");
      if (!latest) return call("period.latest");
      if (!prev) return call("period.previous", { ofRef: latest });
      if (!cmp) return call("change.compare_periods", { startPeriodRef: prev, endPeriodRef: latest });
      return complete(cmp);
    }));
    const remembered = s1.lastPeriodRange!;
    expect(remembered.startCanonical).not.toBe(first);

    // turn 2 NAMES the first two periods explicitly
    const t2 = await turn((_r, prompt) => {
      const cmp = idOf(prompt, "change.compare_periods");
      if (!cmp) return call("change.compare_periods", { startPeriod: first, endPeriod: second });
      return complete(cmp);
    }, { state: s1, request: "Now compare the two earliest dates instead." });

    expect(t2.kind).toBe("answered");
    if (t2.kind !== "answered") return;
    // the explicit request decided, and the memory moved to follow it
    expect(t2.analysis.primary.periodCanonicals).toEqual([first, second]);
    expect(t2.state.lastPeriodRange!.startCanonical).toBe(first);
    expect(t2.state.lastPeriodRange!.startCanonical).not.toBe(remembered.startCanonical);
  });

  it("uses the metric the request names, not the one in focus", async () => {
    const s1 = stateOf(await rankTurn());
    const focused = s1.lastMetric!.metricKey;
    const other = table.schema.rowAxis.map((m) => m.display).find((m) => m !== focused)!;

    const t2 = await turn((_r, prompt) => {
      const series = idOf(prompt, "series.get");
      if (!series) return call("series.get", { metric: other });
      return complete(series);
    }, { state: s1, request: `Show the history of ${other}.` });

    expect(t2.kind).toBe("answered");
    if (t2.kind !== "answered") return;
    expect(t2.analysis.primary.metricKeys).toEqual([other]);
    expect(t2.state.lastMetric!.metricKey).toBe(other);
  });
});

// --- §53: projections are declared, not string-matched ------------------------

describe("Stage 26.7 §53/§14 — the allowed projections are declared and nothing else is", () => {
  it("an event stands in for its metric and its periods; a metric does not stand in for an event", () => {
    expect(projects("event", "metric")).toBe(true);
    expect(projects("event", "period")).toBe(true);
    expect(projects("event", "periodRange")).toBe(true);
    expect(projects("series", "metric")).toBe(true);
    expect(projects("periodRange", "period")).toBe(true);
    // nothing projects upward or sideways
    expect(projects("metric", "event")).toBe(false);
    expect(projects("metric", "metricSet")).toBe(false);
    expect(projects("metricSet", "metric")).toBe(false);
    expect(projects("period", "periodRange")).toBe(false);
    expect(projects("result", "metric")).toBe(false);
  });

  it("every declared projection is reflexive and no undeclared pair sneaks in", () => {
    for (const [from, tos] of Object.entries(DECLARED_PROJECTIONS)) {
      for (const to of tos) expect(projects(from as never, to)).toBe(true);
    }
    expect(Object.keys(DECLARED_PROJECTIONS).sort()).toEqual(
      ["analysis", "event", "metric", "metricSet", "period", "periodRange", "result", "series"],
    );
  });

  it("an event in state reaches the metric it happened to, with no string matching", async () => {
    const s = stateOf(await turn((_r, prompt) => {
      const ev = idOf(prompt, "event.max_adjacent_change");
      if (!ev) return call("event.max_adjacent_change", { metric: METRIC });
      return complete(ev);
    }));
    expect(s.lastEvent?.metricKey).toBe(METRIC);
    expect(s.lastMetric?.metricKey).toBe(METRIC);

    const t2 = await turn((_r, prompt) => {
      const ev = idOf(prompt, "reference.last_event");
      const series = idOf(prompt, "series.get");
      if (!ev) return call("reference.last_event");
      // the event result names exactly one metric, so it IS a metric reference
      if (!series) return call("series.get", { metricRef: ev });
      return complete(series);
    }, { state: s });
    expect(t2.kind).toBe("answered");
    if (t2.kind !== "answered") return;
    expect(t2.analysis.primary.metricKeys).toEqual([METRIC]);
  });
});

// --- §54/§27: primary and supporting ------------------------------------------

describe("Stage 26.7 §54/§27 — the answer and its evidence are both reachable", () => {
  it("records both, labelled, in deterministic recency order", async () => {
    const s = stateOf(await rankTurn());
    const recent = s.recentResults ?? [];
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent[0]!.role).toBe("primary");
    expect(recent[0]!.resultId).toBe(s.lastResult!.resultId);
    expect(recent.slice(1).some((r) => r.role === "supporting")).toBe(true);
  });

  it("a follow-up can name the SUPPORTING result deliberately", async () => {
    const s = stateOf(await rankTurn());
    const t2 = await turn((_r, prompt) => {
      const got = idOf(prompt, "reference.recent");
      if (!got) return call("reference.recent", { role: "supporting", n: 1 });
      return complete(got);
    }, { state: s });
    expect(t2.kind).toBe("answered");
    if (t2.kind !== "answered") return;
    // the supporting result was the volatility table, not the single winner
    expect(t2.analysis.primary.metricKeys.length).toBeGreaterThan(1);
  });

  it("says how many results there are when asked past the end, instead of claiming none", async () => {
    // A live turn asked for n=2 with role=supporting when only one supporting
    // result existed, got "there is no previous result", and retried the same
    // call until the turn died. Out of range is not absence.
    const s = stateOf(await rankTurn());
    let refusal = "";
    await turn((round, prompt) => {
      if (round === 1) return call("reference.recent", { n: 5, role: "supporting" });
      refusal = prompt.slice(prompt.indexOf("=== ERRORS FROM YOUR PREVIOUS CALLS"));
      const got = idOf(prompt, "reference.recent");
      if (!got) return call("reference.recent", { n: 1, role: "supporting" });
      return complete(got);
    }, { state: s });
    expect(refusal).toContain("INVALID_ARGUMENT");
    expect(refusal).toContain("past the end");
    expect(refusal).not.toContain("NO_PREVIOUS_RESULT");
  });

  it("bounds what it carries forward", async () => {
    let s = stateOf(await rankTurn());
    for (let i = 0; i < 6; i += 1) s = stateOf(await rankTurn(s));
    expect((s.recentResults ?? []).length).toBeLessThanOrEqual(MAX_RECENT_RESULTS);
  });
});

// --- §8/§9/§56: what the planner actually sees --------------------------------

describe("Stage 26.7 §8/§9/§56 — the state block is descriptors, bounded", () => {
  it("names each slot and its reader without dumping a single row of data", async () => {
    let s = stateOf(await rankTurn());
    for (let i = 0; i < 3; i += 1) s = stateOf(await rankTurn(s));
    const context = buildEngineContext(table.schema, table.grids, buildPeriodIndex(table.schema, table.grids), s);
    expect(context.stateBlock).toContain("lastMetric:");
    expect(context.stateBlock).toContain("reference.last_metric");
    expect(context.stateBlock).toContain("earlier this conversation");
    // §8 — descriptors only: no row of the stored result appears
    const rows = s.lastResult!.rows.flat().filter((v) => typeof v === "number");
    for (const v of rows.slice(0, 5)) expect(context.stateBlock).not.toContain(String(v));
    // §56 — and it stays small
    expect(context.stateBlock.length).toBeLessThan(2000);
  });

  it("says plainly when there is nothing to refer back to", () => {
    const context = buildEngineContext(table.schema, table.grids, buildPeriodIndex(table.schema, table.grids), EMPTY_ANALYTICAL_STATE);
    expect(context.stateBlock).toContain("first analytical turn");
  });
});

// --- §34: protocol recovery must not cost the conversation --------------------

describe("Stage 26.7 §34/§60 — a protocol correction preserves the conversation", () => {
  it("survives a rejected batch mid-turn and still commits the right references", async () => {
    const s1 = stateOf(await rankTurn());
    const t2 = await turn((round, prompt) => {
      // the planner batches two decisions; Stage 26.6 refuses the response
      if (round === 1) return `${call("reference.last_metric")}\n${call("series.get", { metric: METRIC })}`;
      const m = idOf(prompt, "reference.last_metric");
      const series = idOf(prompt, "series.get");
      if (!m) return call("reference.last_metric");
      if (!series) return call("series.get", { metricRef: m });
      return complete(series);
    }, { state: s1 });

    expect(t2.kind).toBe("answered");
    if (t2.kind !== "answered") return;
    expect(t2.trace.serializationClasses).toContain("concatenated");
    expect(t2.state.lastSeries?.metricKey).toBe(s1.lastMetric!.metricKey);
  });
});
