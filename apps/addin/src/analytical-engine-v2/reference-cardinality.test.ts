import { describe, expect, it } from "vitest";
import { ResultStore } from "./results/result-store.js";
import { EMPTY_ANALYTICAL_STATE, storeResult, type AnalyticalConversationState, type StoredResultRef } from "./state/conversation-state.js";
import { buildToolEnv } from "./tools/registry.js";
import { executeCall, validateCall } from "./tools/validator.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import type { EngineResult, ToolOutcome } from "./types.js";

const table = fixtureOperations();

function session(state: AnalyticalConversationState) {
  const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 3000 });
  const env = buildToolEnv(table.schema, table.grids, store, state);
  const cache = new Map<string, string>();
  const call = (tool: string, args: Record<string, unknown> = {}): ToolOutcome => {
    const validated = validateCall({ kind: "tool_call", tool, arguments: args }, env);
    if (!validated.ok) return validated.error;
    return executeCall(validated.call, env, cache).outcome;
  };
  const ok = (tool: string, args: Record<string, unknown> = {}): EngineResult => {
    const outcome = call(tool, args);
    if (!outcome.ok) throw new Error(`${tool} failed: ${outcome.error.code}: ${outcome.error.message}`);
    return outcome.result;
  };
  return { call, ok };
}

function rankedResultOfSize(n: number): StoredResultRef {
  const setup = session(EMPTY_ANALYTICAL_STATE);
  const cmp = setup.ok("change.compare_periods", { periodIntent: { kind: "latest_vs_previous" } });
  const bottom = setup.ok("set.bottom", { inputRef: cmp.resultId, field: "percentageChange", n });
  return storeResult(bottom);
}

describe("Stage 28H.2 — cardinality-aware recent-result resolution", () => {
  it("top3 then top5 then 'these three' resolves the earlier set of 3", () => {
    const top3 = rankedResultOfSize(3);
    const top2 = rankedResultOfSize(2);
    const state: AnalyticalConversationState = { turnId: "t0", recentResults: [top2, top3] };
    const s = session(state);
    const resolved = s.ok("reference.recent", { metricCount: 3 });
    expect(resolved.metricKeys).toEqual(top3.metricKeys);
  });

  it("two sets of the same size resolve to the newest of them", () => {
    const top3Older = rankedResultOfSize(3);
    const top3Newer = rankedResultOfSize(3);
    const state: AnalyticalConversationState = { turnId: "t0", recentResults: [top3Newer, top3Older] };
    const s = session(state);
    const resolved = s.ok("reference.recent", { metricCount: 3 });
    expect(resolved.metricKeys).toEqual(top3Newer.metricKeys);
  });

  it("a single set already matching the requested cardinality resolves to itself", () => {
    const top3 = rankedResultOfSize(3);
    const state: AnalyticalConversationState = { turnId: "t0", recentResults: [top3] };
    const s = session(state);
    const resolved = s.ok("reference.recent", { metricCount: 3 });
    expect(resolved.metricKeys).toEqual(top3.metricKeys);
  });

  it("no set of the requested cardinality fails closed rather than guessing", () => {
    const top2 = rankedResultOfSize(2);
    const state: AnalyticalConversationState = { turnId: "t0", recentResults: [top2] };
    const s = session(state);
    const outcome = s.call("reference.recent", { metricCount: 3 });
    expect(outcome.ok).toBe(false);
  });

  it("a stale result of the right cardinality is still refused by the freshness gate", () => {
    const top3 = rankedResultOfSize(3);
    const state: AnalyticalConversationState = { turnId: "t0", recentResults: [{ ...top3, sourceVersion: "older" }] };
    const s = session(state);
    const outcome = s.call("reference.recent", { metricCount: 3 });
    expect(outcome.ok).toBe(false);
  });
});
