// Stage 25.1.3c §5/§6 — an authoritative resolvedSubject must reach the
// planner's OWN prompt context as a distinct, prominently-labeled line — not
// buried among (or conflated with) soft conversation memory — so the model
// can use the metric name directly without any resolution tool call.
import { describe, expect, it } from "vitest";
import { induceTableSchema } from "../app/schema/schema-induction.js";
import { fixtureDirectionAndSets } from "../app/schema/__fixtures__/tables.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import { buildAnalyticalToolEnv } from "./tool-registry.js";
import { buildAnalyticalWorkbookContext } from "./workbook-context.js";

function schemaAndEnv() {
  const fx = fixtureDirectionAndSets();
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: "v1",
    startsBelowRow1: false,
  });
  const grids: AnalysisGrids = { values: fx.values, numberFormats: fx.numberFormats };
  return { schema, grids };
}

describe("Stage 25.1.3c §5/§6 — buildAnalyticalWorkbookContext renders RESOLVED SUBJECT distinctly", () => {
  it("renders a RESOLVED SUBJECT line with the metric name when inherited.resolvedSubject is present", () => {
    const { schema, grids } = schemaAndEnv();
    const a = schema.rowAxis[0]!.display;
    const env = buildAnalyticalToolEnv(schema, grids, "ru", { resolvedSubject: { metricKey: a, source: "conversation_pronoun", authoritative: true } });
    const text = buildAnalyticalWorkbookContext(schema, grids, env.periodIndex, env.inherited);
    expect(text).toMatch(/RESOLVED SUBJECT/);
    expect(text).toContain(`"${a}"`);
  });

  it("distinguishes RESOLVED SUBJECT (this request) from lastMetricFocusRef (stale memory) when both are present and differ", () => {
    const { schema, grids } = schemaAndEnv();
    const a = schema.rowAxis[0]!.display;
    const b = schema.rowAxis[1]!.display;
    const env = buildAnalyticalToolEnv(schema, grids, "ru", {
      resolvedSubject: { metricKey: a, source: "conversation_pronoun", authoritative: true },
      metricFocus: { metricKey: b },
    });
    const text = buildAnalyticalWorkbookContext(schema, grids, env.periodIndex, env.inherited);
    expect(text).toMatch(new RegExp(`RESOLVED SUBJECT[^\\n]*\\n\\s*"${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    expect(text).toContain(`lastMetricFocusRef: "${b}"`);
  });

  it("omits the RESOLVED SUBJECT line entirely when no resolvedSubject was given (never a stray empty section)", () => {
    const { schema, grids } = schemaAndEnv();
    const env = buildAnalyticalToolEnv(schema, grids, "ru", {});
    const text = buildAnalyticalWorkbookContext(schema, grids, env.periodIndex, env.inherited);
    expect(text).not.toMatch(/RESOLVED SUBJECT/);
  });
});

describe("Stage 25.1.3f §3/§4 — the standing analytical result is advertised to the planner", () => {
  it("renders lastAnalyticalResultSetRef with its operation, size, filterable fields, period, and the tool that reads it", () => {
    const { schema, grids } = schemaAndEnv();
    const env = buildAnalyticalToolEnv(schema, grids, "ru", {
      resultTable: {
        operation: "change.compare_periods",
        columns: ["metric", "absoluteChange", "percentageChange"],
        rows: [
          ["A", -1, -0.01],
          ["B", -2, -0.14],
        ],
        startCanonical: "2025-11-01",
        endCanonical: "2025-12-01",
      },
    });
    const text = buildAnalyticalWorkbookContext(schema, grids, env.periodIndex, env.inherited);
    expect(text).toContain("lastAnalyticalResultSetRef");
    expect(text).toContain("change.compare_periods");
    expect(text).toContain("2 row(s)");
    expect(text).toContain("percentageChange");
    expect(text).toContain("2025-11-01 .. 2025-12-01");
    expect(text).toContain("reference.previous_result_table");
  });

  it("says nothing about a standing result when none exists (never an empty placeholder)", () => {
    const { schema, grids } = schemaAndEnv();
    const env = buildAnalyticalToolEnv(schema, grids, "ru", {});
    const text = buildAnalyticalWorkbookContext(schema, grids, env.periodIndex, env.inherited);
    expect(text).not.toContain("lastAnalyticalResultSetRef");
  });
});
