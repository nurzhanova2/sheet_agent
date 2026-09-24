import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { induceTableSchema } from "../app/schema/schema-induction.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import { ResultStore } from "./results/result-store.js";
import { buildFindings, extractFindings, type ExtractContext } from "./insight/extract-findings.js";
import { displayUnit, metricSemanticClass, relativeChangeOf } from "./insight/measure-semantics.js";
import { humanizeValue, percentagePointMove } from "./insight/humanize.js";
import { valueOf } from "./insight/verified-finding.js";
import { verifyNarration } from "./narration/narration-verifier.js";
import { planPresentation } from "./narration/presentation-plan.js";
import { renderDeterministic, gateNarration, buildNarratorMessages, type NarrationInput } from "./narration/narrator.js";
import type { EngineAnalysis, ResultField } from "./types.js";

/**
 * Intl groups thousands with U+00A0, not a plain space. Comparing against a
 * source literal typed with a normal space fails for a reason that has nothing
 * to do with the behaviour under test, so both sides are normalised here.
 */
function norm(text: string): string {
  return text.replace(/[\u00a0\u202f\u2009]/g, " ");
}

const METRIC: ResultField = { name: "metric", kind: "metric" };
const NUM = (n: string): ResultField => ({ name: n, kind: "number" });
const TEXT = (n: string): ResultField => ({ name: n, kind: "text" });

// --- the fixture ------------------------------------------------------------

/** Excel date serials for 01.01.2025 and 01.12.2025. */
const JAN = 45658;
const DEC = 45992;

const ASSETS = "Активы";
const LIQUID_SHARE = "доля ликвидных активов в активах";
const DOLLARIZATION = "уровень долларизации всего вкладов";
const REPO = "обратное РЕПО";

function bankTable(): { readonly schema: ReturnType<typeof induceTableSchema>; readonly grids: AnalysisGrids } {
  const values: CellValue[][] = [
    ["Наименование показателя", JAN, DEC],
    // an amount, in the table's own units
    [ASSETS, 17941.741778, 19871.544896],
    // a SHARE: percent-formatted, so Excel stores it as a fraction
    [LIQUID_SHARE, 0.311, 0.304],
    [DOLLARIZATION, 0.2782, 0.2863],
    // a row that grew from nothing — its relative change does not exist
    [REPO, 0, 273.4],
  ];
  const numberFormats = values.map((row, r) =>
    row.map((_, c) => {
      if (r === 0) return c === 0 ? "General" : "dd.mm.yyyy";
      if (c === 0) return "General";
      const label = String(values[r]?.[0] ?? "");
      return label === LIQUID_SHARE || label === DOLLARIZATION ? "0.0%" : "#,##0.0";
    }),
  );
  const schema = induceTableSchema({
    values,
    numberFormats,
    formulas: values.map((r) => r.map(() => null)),
    sheetName: "Баланс",
    sourceRange: "Баланс!A1:C5",
    sourceVersion: "v1",
    startsBelowRow1: false,
  });
  return { schema, grids: { values, numberFormats } };
}

function ctx(): ExtractContext {
  const t = bankTable();
  return { schema: t.schema, grids: t.grids, locale: "ru" };
}

function store(): ResultStore {
  return new ResultStore("Баланс!A1:C5", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
}

const CHANGE_FIELDS: readonly ResultField[] = [
  METRIC,
  TEXT("startPeriodLabel"),
  TEXT("endPeriodLabel"),
  NUM("startValue"),
  NUM("endValue"),
  NUM("absoluteChange"),
  NUM("percentageChange"),
];

// --- §52 ---------------------------------------------------------------------

describe("Stage 27 §52 — numbers are written for a human, from schema units", () => {
  it("an amount loses the noise decimals and gains grouping", () => {
    // §52's own example: 19871.544896 → 19 871.5
    expect(norm(humanizeValue(19871.544896, { kind: "amount" }, "ru"))).toBe("19 871,5");
    expect(norm(humanizeValue(19871.544896, { kind: "amount" }, "en"))).toBe("19,871.5");
  });

  it("a fraction whose semantic type is a percentage is shown as one", () => {
    // §52's other example: 0.286253 → 28.63%
    expect(humanizeValue(0.286253, { kind: "percent_fraction" }, "ru")).toBe("28,63%");
  });

  it("does not blindly convert a number with no percentage evidence", () => {
    // §52 — "Do not blindly convert ratios."
    expect(humanizeValue(0.286253, { kind: "unknown" }, "ru")).not.toContain("%");
    expect(humanizeValue(6.5555, { kind: "ratio" }, "ru")).toBe("6,56×");
  });

  it("reads the unit from the metric, not from the magnitude", () => {
    const c = ctx();
    expect(metricSemanticClass(c.schema!, c.grids!, LIQUID_SHARE)).toBe("share");
    expect(metricSemanticClass(c.schema!, c.grids!, DOLLARIZATION)).toBe("rate");
    expect(metricSemanticClass(c.schema!, c.grids!, ASSETS)).toBe("amount");
  });
});

// --- §53 ---------------------------------------------------------------------

describe("Stage 27 §53 — percent and percentage points are different quantities", () => {
  it("the change of a SHARE is measured in percentage points", () => {
    const unit = displayUnit({ schema: ctx().schema!, grids: ctx().grids! }, "absoluteChange", LIQUID_SHARE);
    expect(unit.kind).toBe("percent_point_delta");
  });

  it("the change of an AMOUNT stays an amount", () => {
    const unit = displayUnit({ schema: ctx().schema!, grids: ctx().grids! }, "absoluteChange", ASSETS);
    expect(unit.kind).toBe("amount");
  });

  it("a relative change is a percentage even for a percentage metric", () => {
    // Doubly important: 4.2% → 3.1% is -26% RELATIVE and -1.1 п.п. — both true,
    // different statements, and the relative one is never percentage points.
    expect(displayUnit(null, "percentageChange", LIQUID_SHARE).kind).toBe("percent_fraction");
  });

  it("states both readings of one move, and keeps them apart", () => {
    // §53's worked example, in the workbook's own fraction scale.
    const move = percentagePointMove(0.2782, 0.2863, false, "ru");
    expect(move.pointsText).toBe("+0,81 п.п.");
    expect(move.relativeText).toBe("+2,91%");
    expect(move.points).toBeCloseTo(0.0081, 6);
    expect(move.relative).toBeCloseTo(0.0291, 4);
  });

  it("a change finding on a share renders in points, not percent", () => {
    const s = store();
    const result = s.put({
      tool: "period.compare",
      type: "comparison",
      fields: CHANGE_FIELDS,
      rows: [[LIQUID_SHARE, "01.01.25", "01.12.25", 0.311, 0.304, -0.007, -0.0225]],
      metricKeys: [LIQUID_SHARE],
    });
    const [finding] = extractFindings(result, ctx());
    expect(finding).toBeDefined();
    expect(valueOf(finding!, "absoluteChange")?.text).toBe("-0,70 п.п.");
    expect(valueOf(finding!, "percentageChange")?.text).toBe("-2,25%");
    // §58 — a share's sentence leads with the points, as an analyst would
    expect(finding!.statement).toContain("0,70 п.п.");
  });
});

// --- §39 ---------------------------------------------------------------------

describe("Stage 27 §39 — materiality is measured against the data, never a fabricated threshold", () => {
  it("flags a large percentage that comes from a small base", () => {
    const s = store();
    const result = s.put({
      tool: "period.compare",
      type: "comparison",
      fields: CHANGE_FIELDS,
      rows: [
        [ASSETS, "01.12.24", "01.12.25", 17394.3, 19871.5, 2477.2, 0.1424],
        [REPO, "01.12.24", "01.12.25", 38.6, 273.4, 234.8, 6.083],
      ],
      metricKeys: [ASSETS, REPO],
    });
    const findings = extractFindings(result, ctx());
    const repo = findings.find((f) => f.subject === REPO);
    expect(repo).toBeDefined();
    expect(repo!.caveats.map((c) => c.code)).toContain("low_base_percentage");
    // and the ordinary row carries no such caveat
    const assets = findings.find((f) => f.subject === ASSETS);
    expect(assets?.caveats ?? []).toHaveLength(0);
  });

  it("records rank within the same result rather than an absolute verdict", () => {
    const s = store();
    const result = s.put({
      tool: "period.compare",
      type: "comparison",
      fields: CHANGE_FIELDS,
      rows: [
        [ASSETS, "a", "b", 100, 110, 10, 0.1],
        [DOLLARIZATION, "a", "b", 0.2782, 0.2863, 0.0081, 0.0291],
      ],
      metricKeys: [ASSETS, DOLLARIZATION],
    });
    const findings = extractFindings(result, ctx());
    const ranks = findings.flatMap((f) => f.materiality.filter((m) => m.kind === "rank"));
    expect(ranks.length).toBeGreaterThan(0);
    expect(ranks.every((r) => r.kind === "rank" && r.outOf === 2)).toBe(true);
  });
});

// --- §23/§25 -----------------------------------------------------------------

describe("Stage 27 §23/§25 — an undefined relative change never becomes zero", () => {
  it("keeps the missing percentage missing and says why", () => {
    const s = store();
    const result = s.put({
      tool: "period.compare",
      type: "comparison",
      fields: CHANGE_FIELDS,
      rows: [[REPO, "01.01.25", "01.12.25", 0, 273.4, 273.4, null]],
      metricKeys: [REPO],
    });
    const [finding] = extractFindings(result, ctx());
    expect(finding).toBeDefined();
    expect(valueOf(finding!, "percentageChange")).toBeUndefined();
    expect(finding!.caveats.map((c) => c.code)).toContain("relative_undefined_zero_base");
    // §25 — and the sentence must not present the gap as "0%" or "no change"
    expect(finding!.statement).not.toContain("0%");
    expect(finding!.statement).not.toContain("без изменений");
  });
});

// --- §44/§45 -----------------------------------------------------------------

describe("Stage 27 §44/§45 — structure comes from the evidence, not the phrasing", () => {
  function analysisOf(rows: readonly (readonly CellValue[])[]): EngineAnalysis {
    const s = store();
    const primary = s.put({ tool: "period.compare", type: "comparison", fields: CHANGE_FIELDS, rows, metricKeys: rows.map((r) => String(r[0])) });
    return { primary, supporting: [], answerStyle: "concise" };
  }

  it("a single observation plans a direct answer with no structure", () => {
    const analysis = analysisOf([[ASSETS, "01.01.25", "01.12.25", 17941.741778, 19871.544896, 1929.8, 0.1076]]);
    const plan = planPresentation(analysis, buildFindings(analysis.primary, [], ctx()), { shape: "direct", count: null, direction: null, subjects: [], periodIntent: { kind: "full_range" }, wantsTable: false, wantsRecommendation: false, answerStyle: "concise" });
    expect(plan.shape).toBe("direct");
    expect(plan.showEvidenceTable).toBe(false);
  });

  it("several observations plan a structured answer", () => {
    const analysis = analysisOf([
      [ASSETS, "a", "b", 100, 110, 10, 0.1],
      [LIQUID_SHARE, "a", "b", 0.311, 0.304, -0.007, -0.0225],
      [DOLLARIZATION, "a", "b", 0.2782, 0.2863, 0.0081, 0.0291],
    ]);
    const plan = planPresentation(analysis, buildFindings(analysis.primary, [], ctx()), { shape: "comparison", count: null, direction: null, subjects: [], periodIntent: { kind: "full_range" }, wantsTable: false, wantsRecommendation: false, answerStyle: "concise" });
    expect(plan.shape).toBe("comparison");
    expect(plan.support.length).toBeGreaterThan(0);
  });

  it("the lead observation comes from the PRIMARY result, never re-guessed", () => {
    const analysis = analysisOf([[ASSETS, "01.01.25", "01.12.25", 17941.741778, 19871.544896, 1929.8, 0.1076]]);
    const plan = planPresentation(analysis, buildFindings(analysis.primary, [], ctx()), { shape: "direct", count: null, direction: null, subjects: [], periodIntent: { kind: "full_range" }, wantsTable: false, wantsRecommendation: false, answerStyle: "concise" });
    expect(plan.lead?.subject).toBe(ASSETS);
    expect(plan.lead?.provenance.resultRef).toBe(analysis.primary.resultId);
  });
});

// --- §56 ---------------------------------------------------------------------

describe("Stage 27 §56 — narration verification catches what result tables could not", () => {
  function shareFindings() {
    const s = store();
    const result = s.put({
      tool: "period.compare",
      type: "comparison",
      fields: CHANGE_FIELDS,
      rows: [[DOLLARIZATION, "01.01.25", "01.12.25", 0.2782, 0.2863, 0.0081, 0.0291]],
      metricKeys: [DOLLARIZATION],
    });
    return { result, findings: extractFindings(result, ctx()) };
  }

  it("accepts a percentage-point claim backed by a percentage-point value", () => {
    const { findings } = shareFindings();
    const check = verifyNarration("Долларизация выросла на 0,81 п.п.", findings, "ru");
    expect(check.ok).toBe(true);
  });

  it("rejects a percentage-point value written as a percent", () => {
    // The Stage 26 numeric gate cannot see this: 0.0081 legitimises "0.81"
    // in either scaling. Only the UNIT WORD distinguishes the two claims.
    const { findings } = shareFindings();
    const check = verifyNarration("Долларизация выросла на 0,81%.", findings, "ru");
    expect(check.ok).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/percentage-POINT/i);
  });

  it("accepts the genuine relative change as a percent", () => {
    const { findings } = shareFindings();
    expect(verifyNarration("Долларизация выросла на 2,91%.", findings, "ru").ok).toBe(true);
  });

  it("rejects a percentage-point claim when nothing measured points", () => {
    const s = store();
    const result = s.put({
      tool: "period.compare",
      type: "comparison",
      fields: CHANGE_FIELDS,
      rows: [[ASSETS, "a", "b", 17941.7, 19871.5, 1929.8, 0.1076]],
      metricKeys: [ASSETS],
    });
    const check = verifyNarration("Активы выросли на 10,76 п.п.", extractFindings(result, ctx()), "ru");
    expect(check.ok).toBe(false);
  });

  it("rejects an unhedged causal claim but allows a labelled hypothesis", () => {
    const { findings } = shareFindings();
    expect(verifyNarration("Рост произошёл из-за притока валютных вкладов.", findings, "ru").ok).toBe(false);
    expect(
      verifyNarration("Причину по таблице определить нельзя; приток валютных вкладов — гипотеза для проверки.", findings, "ru").ok,
    ).toBe(true);
  });

  it("rejects a superlative that the verified ranking does not support", () => {
    const s = store();
    const result = s.put({
      tool: "period.compare",
      type: "comparison",
      fields: CHANGE_FIELDS,
      rows: [
        [REPO, "a", "b", 38.6, 273.4, 234.8, 6.083],
        [ASSETS, "a", "b", 17394.3, 19871.5, 2477.2, 0.1424],
        [DOLLARIZATION, "a", "b", 0.2782, 0.2863, 0.0081, 0.0291],
      ],
      metricKeys: [REPO, ASSETS, DOLLARIZATION],
    });
    const findings = extractFindings(result, ctx());
    // Dollarization ranks last by relative change; calling it the largest move
    // contradicts the ranking the engine actually computed.
    const bad = verifyNarration(`Сильнее всего изменился ${DOLLARIZATION}.`, findings, "ru");
    expect(bad.ok).toBe(false);
    const good = verifyNarration(`Сильнее всего изменился ${REPO}.`, findings, "ru");
    expect(good.ok).toBe(true);
  });

  it("rejects a bare score with no comparative explanation", () => {
    const s = store();
    const result = s.put({
      tool: "series.volatility",
      type: "volatility",
      fields: [METRIC, NUM("score")],
      rows: [[REPO, 5.2], [ASSETS, 0.4]],
      metricKeys: [REPO, ASSETS],
    });
    const findings = extractFindings(result, ctx());
    expect(verifyNarration("Волатильность 5,20.", findings, "ru").ok).toBe(false);
    expect(verifyNarration("Показатель заметно нестабильнее остальных — оценка 5,20.", findings, "ru").ok).toBe(true);
  });
});

// --- §57/§58 -----------------------------------------------------------------

describe("Stage 27 §57/§58 — the fallback is prose, keyed off the result TYPE", () => {
  function narration(rows: readonly (readonly CellValue[])[]): NarrationInput {
    const s = store();
    const primary = s.put({ tool: "period.compare", type: "comparison", fields: CHANGE_FIELDS, rows, metricKeys: rows.map((r) => String(r[0])) });
    const analysis: EngineAnalysis = { primary, supporting: [], answerStyle: "concise" };
    return { request: "На сколько выросли активы с начала года?", analysis, findings: buildFindings(primary, [], ctx()), locale: "ru" };
  }

  it("renders §45's simple question as one sentence with readable numbers", () => {
    const body = norm(renderDeterministic(narration([[ASSETS, "01.01.25", "01.12.25", 17941.741778, 19871.544896, 1929.803119, 0.1076]])));
    expect(body).toContain("19 871,5");
    expect(body).toContain("17 941,7");
    expect(body).toContain("10,76%");
    // §45 — not an apology, not a table
    expect(body).not.toMatch(/Не удалось/);
    expect(body).not.toContain("|");
    expect(body.split(/[.!?]\s/).length).toBeLessThanOrEqual(4);
  });

  it("an empty filtered set is answered as a finding, not an error", () => {
    const s = store();
    const primary = s.put({ tool: "set.filter", type: "filtered_set", fields: CHANGE_FIELDS, rows: [], metricKeys: [] });
    const analysis: EngineAnalysis = { primary, supporting: [], answerStyle: "concise" };
    const body = renderDeterministic({ request: "q", analysis, findings: buildFindings(primary, [], ctx()), locale: "ru" });
    expect(body).toContain("Ни один показатель");
  });

  it("the narrator prompt shows observations and the exact strings it may quote", () => {
    const input = narration([[ASSETS, "01.01.25", "01.12.25", 17941.741778, 19871.544896, 1929.803119, 0.1076]]);
    const user = norm(buildNarratorMessages(input).find((m) => m.role === "user")!.content);
    expect(user).toContain("[ГЛАВНОЕ]");
    expect(user).toContain("19 871,5");
    expect(user).toContain("ВОПРОС");
    // §55 — the narrator never sees the raw store or a provenance address
    expect(user).not.toContain("result_");
    expect(user).not.toContain("Баланс!A1:C5");
  });

  it("a draft that survives both gates is shown as written", () => {
    const input = narration([[ASSETS, "01.01.25", "01.12.25", 17941.741778, 19871.544896, 1929.803119, 0.1076]]);
    const gated = gateNarration("Активы выросли на 10,76% — с 17 941,7 до 19 871,5.", input);
    expect(gated.usedFallback).toBe(false);
    expect(norm(gated.text)).toContain("19 871,5");
  });
});

// --- helpers ----------------------------------------------------------------

describe("Stage 27 §53 — relative change is undefined on a zero base", () => {
  it("returns null rather than Infinity", () => {
    expect(relativeChangeOf(0, 273.4)).toBeNull();
    expect(relativeChangeOf(100, 110)).toBeCloseTo(0.1, 9);
  });
});
