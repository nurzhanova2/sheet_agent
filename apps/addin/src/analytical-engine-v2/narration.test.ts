// ---------------------------------------------------------------------------
// Stage 26.1 §35/§36/§37/§38 — narration is the least powerful component.
//
// It sees only what the planner named, it cannot move the conversation, and
// anything it says that the named results do not support is replaced by those
// results rendered deterministically.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildNarratorMessages, gateNarration, renderDeterministic, type NarrationInput } from "./narration/narrator.js";
import { buildFindings } from "./insight/extract-findings.js";
import { ResultStore } from "./results/result-store.js";
import { runAnalyticalEngine } from "./engine.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import type { EngineAnalysis, ResultField } from "./types.js";

const METRIC: ResultField = { name: "metric", kind: "metric" };
const NUM = (n: string): ResultField => ({ name: n, kind: "number" });

function analysis(): EngineAnalysis {
  const s = new ResultStore("S!A1:D5", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
  const primary = s.put({
    tool: "set.argmax",
    type: "metric_winner",
    fields: [METRIC, NUM("absoluteChange"), NUM("percentageChange"), { name: "startCell", kind: "cell" }],
    rows: [["Defect ratio", -43.74, -0.1379, "Ops!D5"]],
    metricKeys: ["Defect ratio"],
  });
  const supporting = s.put({
    tool: "series.get",
    type: "series",
    fields: [METRIC, { name: "periodLabel", kind: "text" }, NUM("value")],
    rows: [["Defect ratio", "01.11.2025", 317.1601], ["Defect ratio", "01.12.2025", 273.4174]],
    metricKeys: ["Defect ratio"],
  });
  return { primary, supporting: [supporting], answerStyle: "concise" };
}

/**
 * Stage 27 §55 — narration's whole input: the named results plus the
 * observations drawn from them. Built without a schema on purpose here, so
 * these tests exercise the path where no unit evidence exists and prove it
 * still produces prose rather than claiming a unit it cannot show.
 */
function narration(request = "Из них какой изменился сильнее всего?"): NarrationInput {
  const a = analysis();
  return { request, analysis: a, findings: buildFindings(a.primary, a.supporting, { locale: "ru" }), locale: "ru" };
}

describe("Stage 26 §35 — the narrator sees the named results and nothing else", () => {
  it("labels the primary result as the answer and supporting results as backing", () => {
    const messages = buildNarratorMessages(narration());
    const user = messages.find((m) => m.role === "user")!.content;
    // Stage 27 §55 — the lead observation is marked, and it comes from the
    // planner's named PRIMARY result; supporting ones follow it unmarked.
    expect(user).toContain("[ГЛАВНОЕ]");
    expect(user).toContain("Defect ratio");
    expect(user).toMatch(/НАБЛЮДЕНИЯ/);
    // no other metric of the workbook leaked in
    expect(user).not.toContain("Throughput index");
  });

  it("never shows the narrator a provenance cell address", () => {
    const user = buildNarratorMessages(narration("q")).find((m) => m.role === "user")!.content;
    expect(user).not.toContain("Ops!D5");
  });
});

describe("Stage 26 §37/§38 — verification, then the named primary", () => {
  it("passes prose whose every number comes from the named results", () => {
    const gated = gateNarration("Сильнее всего изменился Defect ratio: -43,74.", narration());
    expect(gated.usedFallback).toBe(false);
    expect(gated.text).toContain("Defect ratio");
  });

  it("replaces prose carrying an unsupported number with the verified table", () => {
    const gated = gateNarration("Показатель изменился на 999999.5.", narration());
    expect(gated.usedFallback).toBe(true);
    expect(gated.text).not.toContain("999999.5");
    expect(gated.reasons.length).toBeGreaterThan(0);
  });

  it("replaces prose that leaks an internal identifier", () => {
    const gated = gateNarration("См. result_42 из set.argmax.", narration());
    expect(gated.usedFallback).toBe(true);
    expect(gated.text).not.toContain("result_42");
  });

  it("Stage 27 §57 — the fallback is PROSE built from the named results, not a table under an apology", () => {
    const body = renderDeterministic(narration());
    expect(body).toContain("Defect ratio");
    // §57 — no apology, and no raw column headers or provenance cells
    expect(body).not.toMatch(/Не удалось подтвердить/);
    expect(body).not.toContain("startCell");
    expect(body).not.toContain("Ops!D5");
    expect(body).not.toContain("percentageChange");
    // the supporting series is still represented — a clause is never silently
    // dropped, it is now stated rather than tabulated
    expect(body).toContain("01.11.2025");
    // §43 — prose, so it ends in a sentence rather than a pipe table
    expect(body).not.toContain("|");
  });

  it("an empty narrator output falls back rather than answering with nothing", () => {
    const gated = gateNarration("   ", narration());
    expect(gated.usedFallback).toBe(true);
    expect(gated.reasons).toContain("empty narrator output");
  });
});

describe("Stage 26 §36 — narration cannot change analytical state", () => {
  it("the committed state is identical whether narration succeeds or fails", async () => {
    const table = fixtureOperations();
    const script = (): string => JSON.stringify({ kind: "tool_call", tool: "series.get", arguments: { metric: "Defect ratio" } });
    const decide = (messages: readonly { readonly role: string; readonly content: string }[]): string =>
      messages.some((m) => m.content.includes("result_1 = series.get")) ? JSON.stringify({ kind: "complete", primaryResultRef: "result_1", supportingResultRefs: [] }) : script();

    const good = await runAnalyticalEngine({
      turnId: "t1",
      request: "Покажи динамику Defect ratio.",
      schema: table.schema,
      grids: table.grids,
      language: "ru",
      state: EMPTY_ANALYTICAL_STATE,
      decide,
      narrate: async () => "Динамика показателя Defect ratio приведена ниже.",
    });
    const bad = await runAnalyticalEngine({
      turnId: "t1",
      request: "Покажи динамику Defect ratio.",
      schema: table.schema,
      grids: table.grids,
      language: "ru",
      state: EMPTY_ANALYTICAL_STATE,
      decide,
      narrate: async () => "Показатель вырос на 88888.77.",
    });

    expect(good.kind).toBe("answered");
    expect(bad.kind).toBe("answered");
    if (good.kind !== "answered" || bad.kind !== "answered") return;
    expect(good.usedFallback).toBe(false);
    expect(bad.usedFallback).toBe(true);
    expect(bad.body).not.toContain("88888.77");
    // §36 — identical structured state either way
    expect(bad.state.lastMetric).toEqual(good.state.lastMetric);
    expect(bad.state.lastResult?.tool).toEqual(good.state.lastResult?.tool);
    expect(bad.state.lastResult?.rows).toEqual(good.state.lastResult?.rows);
  });
});
