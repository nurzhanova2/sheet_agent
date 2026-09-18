// ---------------------------------------------------------------------------
// Stage 25 §4 — the compact TABLE CONTEXT block for the planner.
//
// Semantic schema metadata only — sheet, range, orientation, metric labels +
// semantic classes, period labels, prior conversational refs. Never the raw
// workbook grid (that stays behind the tool boundary, read via metric.list /
// series.get / value.at_period so every number keeps its provenance).
// ---------------------------------------------------------------------------

import { isPercentNumberFormat } from "../app/schema/excel-date.js";
import { classifySemanticMetricClass } from "../app/schema/measure-compatibility.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import type { TableSchema } from "../app/schema/schema-induction.js";
import type { PeriodIndex } from "../app/schema/analytical/period-index.js";
import type { AnalyticalInherited } from "./tool-registry.js";

const MAX_METRICS_SHOWN = 40;
const MAX_PERIODS_SHOWN = 30;

export function buildAnalyticalWorkbookContext(
  schema: TableSchema,
  grids: AnalysisGrids,
  periodIndex: PeriodIndex,
  inherited: AnalyticalInherited,
): string {
  const lines: string[] = [];
  lines.push(`sheet: ${schema.sheetName}`);
  lines.push(`range: ${schema.sourceRange}`);
  lines.push(`orientation: ${schema.orientation}`);

  if (schema.orientation === "column_metrics") {
    lines.push("metrics: (column-oriented table — outside this tool set's row-axis scope; only schema.describe is meaningful)");
  } else {
    const metricLines = schema.rowAxis.slice(0, MAX_METRICS_SHOWN).map((m) => {
      const percentFormatted = periodIndex.points.some(
        (per) => per.colIndex >= 0 && isPercentNumberFormat(grids.numberFormats[m.rowIndex]?.[per.colIndex] ?? null),
      );
      const cls = classifySemanticMetricClass(m.display, { percentFormatted });
      return `  - "${m.display}" (${cls})`;
    });
    lines.push(`metrics (${schema.rowAxis.length} total, showing ${metricLines.length}):`);
    lines.push(...metricLines);
  }

  const periodLines = periodIndex.points.slice(0, MAX_PERIODS_SHOWN).map((p) => `  - ${p.canonical} (${p.headerPath})`);
  lines.push(`periods (${periodIndex.points.length} total, showing ${periodLines.length}, oldest first):`);
  lines.push(...periodLines);

  // Stage 25.1.3c §5/§6 — an AUTHORITATIVE subject binding, rendered
  // separately from (and before) soft conversation memory: this is the
  // current request's own subject — a pronoun in the USER REQUEST below has
  // already been resolved to this metric upstream. Every clause targets it
  // directly; it is never re-resolved via metric.resolve.
  if (inherited.resolvedSubject) {
    lines.push("");
    lines.push(`RESOLVED SUBJECT (authoritative for THIS request — a pronoun in the request below refers to this metric):`);
    lines.push(`  "${inherited.resolvedSubject.metricKey}"`);
  }

  const memLines: string[] = [];
  if (inherited.metricFocus) memLines.push(`  - lastMetricFocusRef: "${inherited.metricFocus.metricKey}"`);
  if (inherited.metricSet) memLines.push(`  - lastMetricSetRef: [${inherited.metricSet.metricKeys.join(", ")}]`);
  if (inherited.resultSet) memLines.push(`  - lastResultSetRef: operation=${inherited.resultSet.operation}, ${inherited.resultSet.rows.length} row(s)`);
  // Stage 25.1.3f §3/§4 — the previous turn's OWN result table is the
  // structured input universe for a follow-up, so the planner must see that
  // it exists, which tool reads it, and which fields it can filter on.
  if (inherited.resultTable) {
    const rt = inherited.resultTable;
    memLines.push(
      `  - lastAnalyticalResultSetRef: operation=${rt.operation}, ${rt.rows.length} row(s), fields [${rt.columns.join(", ")}]` +
        `${rt.startCanonical ? `, period ${rt.startCanonical}${rt.endCanonical ? ` .. ${rt.endCanonical}` : ""}` : ""}` +
        ` — read it with reference.previous_result_table, then filter/sort/slice THAT result`,
    );
  }
  if (inherited.period) memLines.push(`  - lastPeriodRef: ${inherited.period.startCanonical}${inherited.period.endCanonical ? ` .. ${inherited.period.endCanonical}` : ""}`);
  if (memLines.length > 0) {
    lines.push("conversation memory (read via reference.previous_* tools, never re-derive from prose):");
    lines.push(...memLines);
  }

  return lines.join("\n");
}
