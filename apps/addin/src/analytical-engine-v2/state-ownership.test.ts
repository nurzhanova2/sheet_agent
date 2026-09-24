import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAnalyticalEngine, type EngineTurn } from "./engine.js";
import { EMPTY_ANALYTICAL_STATE, type AnalyticalConversationState } from "./state/conversation-state.js";
import { stateInconsistency } from "./state/state-commit.js";
import { tableMovedOn } from "./state/state-refs.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { emptySessionMemory } from "../app/conversation-memory.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";

const table = fixtureOperations();

let seq = 0;

async function turn(
  reply: (round: number, prompt: string) => string,
  state: AnalyticalConversationState = EMPTY_ANALYTICAL_STATE,
  request = "Analyse the table.",
): Promise<EngineTurn> {
  let round = 0;
  seq += 1;
  return runAnalyticalEngine({
    turnId: `s${seq}`,
    request,
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

const call = (tool: string, args: Record<string, unknown> = {}): string => JSON.stringify({ kind: "tool_call", tool, arguments: args });
const complete = (primary: string, supporting: readonly string[] = []): string =>
  JSON.stringify({ kind: "complete", primaryResultRef: primary, supportingResultRefs: supporting });

function stateOf(t: EngineTurn): AnalyticalConversationState {
  if (t.kind === "failed") throw new Error(`turn failed: ${t.detail}`);
  return t.state;
}

async function topThree(state = EMPTY_ANALYTICAL_STATE): Promise<EngineTurn> {
  return turn(
    (_r, prompt) => {
      const vol = idOf(prompt, "analysis.volatility");
      const top = idOf(prompt, "set.top");
      if (!vol) return call("analysis.volatility");
      if (!top) return call("set.top", { inputRef: vol, field: "score", n: 3 });
      return complete(top, [vol]);
    },
    state,
    "Назови три показателя с самой высокой волатильностью",
  );
}

describe("one authoritative analytical state", () => {
  it("a verified analytical turn commits exactly one consistent state", async () => {
    const s = stateOf(await topThree());
    expect(stateInconsistency(s)).toBeNull();
    expect(s.tableRef?.sourceRange).toBe(table.schema.sourceRange);
    expect(s.lastResult).toBeDefined();
    expect(s.lastMetricSet?.metricKeys).toHaveLength(3);
  });

  it("a follow-up on those three resolves exactly the three the ranking named", async () => {
    const s1 = stateOf(await topThree());
    const three = s1.lastMetricSet!.metricKeys;
    expect(three).toHaveLength(3);

    const s2 = stateOf(
      await turn(
        (_r, prompt) => {
          const set = idOf(prompt, "reference.last_metric_set");
          const cmp = idOf(prompt, "change.compare_periods");
          if (!set) return call("reference.last_metric_set");
          if (!cmp) return call("change.compare_periods", { inputRef: set, periodIntent: { kind: "latest_vs_previous" } });
          return complete(cmp);
        },
        s1,
        "А теперь сравни только эти три между собой",
      ),
    );
    expect([...s2.lastMetricSet!.metricKeys].sort()).toEqual([...three].sort());
  });

  it("a reference computed over a table that has moved on is stale, not silently reused", async () => {
    const s = stateOf(await topThree());
    const moved = { ...table.schema, sourceVersion: `${table.schema.sourceVersion}-changed` };
    expect(tableMovedOn(s, moved)).toBe(true);
    expect(tableMovedOn(s, table.schema)).toBe(false);
  });

  it("the period the turn used is carried with its own provenance", async () => {
    const s = stateOf(
      await turn((_r, prompt) => {
        const latest = idOf(prompt, "period.latest");
        const prev = idOf(prompt, "period.previous");
        const cmp = idOf(prompt, "change.compare_periods");
        if (!latest) return call("period.latest");
        if (!prev) return call("period.previous", { ofRef: latest });
        if (!cmp) return call("change.compare_periods", { periodIntent: { kind: "latest_vs_previous" } });
        return complete(cmp);
      }),
    );
    expect(s.lastPeriodRange ?? s.lastPeriod).toBeDefined();
    expect(stateInconsistency(s)).toBeNull();
  });

  it("a clarification suspends the task and carries what it already computed", async () => {
    const t = await turn((round) => {
      if (round === 1) return call("analysis.volatility");
      return JSON.stringify({ kind: "clarify", question: "Which period do you mean?", options: ["Q1", "Q2"] });
    });
    expect(t.kind).toBe("clarify");
    const s = stateOf(t);
    expect(s.suspended?.question).toBe("Which period do you mean?");
    expect(s.suspended!.results.length).toBeGreaterThan(0);
  });

  it("a suspension is dropped once the table it was computed over has moved on", async () => {
    const t = await turn((round) => {
      if (round === 1) return call("analysis.volatility");
      return JSON.stringify({ kind: "clarify", question: "Which period?", options: ["Q1"] });
    });
    const s = stateOf(t);
    const moved = { ...table.schema, sourceVersion: `${table.schema.sourceVersion}-changed` };
    expect(tableMovedOn(s, moved)).toBe(true);
  });
});

const SRC = "src";

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__fixtures__" || entry === "harness") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) productionFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

const REMOVED_ANALYTICAL_STATE = [
  "lastPeriodRef",
  "lastCompositeRef",
  "lastRankingRef",
  "lastEventRef",
  "lastAnalyticalTable",
  "lastDirectionChangeRef",
  "lastMetricSetRef",
  "lastResultSetRef",
  "lastAnalyticalResultSetRef",
  "lastMetricFocusRef",
  "rememberPeriod",
  "rememberComposite",
  "rememberRanking",
  "rememberEvent",
  "rememberAnalyticalTable",
  "rememberMetricFocus",
  "rememberDirectionChange",
  "rememberMetricSet",
  "rememberResultSet",
  "rememberAnalyticalResultSet",
] as const;

describe("the mutation store carries no analytical state of its own", () => {
  const files = productionFiles(SRC);

  it.each(REMOVED_ANALYTICAL_STATE)("%s has no production reader or writer", (symbol) => {
    const hits = files.filter((f) => new RegExp(`\\b${symbol}\\b`).test(readFileSync(f, "utf8")));
    expect(hits.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  it("an empty session memory holds only mutation concerns", () => {
    expect(Object.keys(emptySessionMemory()).sort()).toEqual(["knownIds", "recentResults", "seq"]);
  });

  it("the analytical state the engine commits is not mirrored into the mutation store", async () => {
    const s = stateOf(await topThree());
    const analyticalOnly = Object.keys(s).filter((k) => k !== "recentResults" && (k.startsWith("last") || k === "tableRef" || k === "suspended"));
    expect(analyticalOnly.length).toBeGreaterThan(0);
    const mutationKeys = new Set(Object.keys(emptySessionMemory()));
    for (const key of analyticalOnly) expect([...mutationKeys]).not.toContain(key);
  });
});
