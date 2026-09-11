// ---------------------------------------------------------------------------
// Stage 24.7 — deterministic execution of a validated AnalyticalPlan (§16–§35).
//
// Every number, extremum, ranking value, trend / volatility score and source
// cell is computed here. Output is projected per the plan (period / value /
// period+value / series / ranking / table). A period audit records
// requested-vs-executed endpoints so a silent substitution can never pass.
// ---------------------------------------------------------------------------

import { columnIndexToLetters, parseLocalRange, splitSheetAddress } from "../../a1.js";
import { classifyCell } from "../cell-typing.js";
import type { CellValue } from "@sheet-agent/application";
import type { AnalysisGrids } from "../matrix-analysis.js";
import type { RowAxisMember, TableSchema } from "../schema-induction.js";
import type { PeriodIndex } from "./period-index.js";
import { compareMetricSetAtTwoPoints, computeAdjacentPeriodEvents, getTemporalSeriesSet } from "./temporal-series.js";
import {
  argExtreme,
  changeRowsFor,
  comparePoints,
  computeTrend,
  computeVolatility,
  detectDirectionChanges,
  filterByChange,
  rankByChange,
  rankByField,
  signMatches,
  testMonotonicity,
  type ChangeRow,
} from "./temporal-primitives.js";
import type {
  AnalysisEvent,
  AnalyticalExecution,
  AnalyticalPlan,
  AnalyticalSection,
  PeriodAudit,
  RankingField,
} from "./types.js";

function base(sourceRange: string): { sheet: string; row: number; col: number } {
  const { sheetName, localAddress } = splitSheetAddress(sourceRange);
  try {
    const r = parseLocalRange(localAddress || sourceRange);
    return { sheet: sheetName || "", row: r.start.row, col: r.start.column };
  } catch {
    return { sheet: sheetName || "", row: 0, col: 0 };
  }
}
function addr(sourceRange: string, rowIndex: number, colIndex: number): string {
  const b = base(sourceRange);
  const a1 = `${columnIndexToLetters(b.col + colIndex)}${b.row + rowIndex + 1}`;
  return b.sheet ? `${b.sheet}!${a1}` : a1;
}

function fmt(n: number, percent: boolean): string | number {
  if (percent) return `${(n * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  if (Number.isInteger(n)) return n;
  const r = Number(n.toFixed(4));
  return r;
}

/** Stage 24.8 §6 — human label for the exact field a rank/argmax_event plan
 *  ordered by. Magnitude fields are labelled distinctly so the rendered
 *  heading never implies a signed "grew" when the ranking is direction-
 *  agnostic (§28/§29 — no false semantics). */
function rankingFieldLabel(field: RankingField, ru: boolean): string {
  switch (field) {
    case "percentage_change":
      return ru ? "% изменение" : "% change";
    case "absolute_change":
      return ru ? "абс. изменение" : "absolute change";
    case "abs_percentage_change":
      return ru ? "относительное изменение (модуль)" : "relative change (magnitude)";
    case "abs_absolute_change":
      return ru ? "абсолютное изменение (модуль)" : "absolute change (magnitude)";
    default:
      return ru ? "изменение" : "change";
  }
}

function readColumnByMember(
  schema: TableSchema,
  grids: AnalysisGrids,
  colIndex: number,
): { member: RowAxisMember; value: number; percent: boolean; cell: string }[] {
  const out: { member: RowAxisMember; value: number; percent: boolean; cell: string }[] = [];
  const totalRows = new Set(schema.totals.map((t) => t.rowIndex));
  for (const m of schema.rowAxis) {
    if (totalRows.has(m.rowIndex)) continue;
    const raw = grids.values[m.rowIndex]?.[colIndex] ?? null;
    const tc = classifyCell(raw, grids.numberFormats[m.rowIndex]?.[colIndex] ?? null);
    if (tc.type === "number" || tc.type === "integer" || tc.type === "currency") {
      out.push({ member: m, value: raw as number, percent: false, cell: addr(schema.sourceRange, m.rowIndex, colIndex) });
    } else if (tc.type === "percentage") {
      out.push({ member: m, value: raw as number, percent: true, cell: addr(schema.sourceRange, m.rowIndex, colIndex) });
    }
  }
  return out;
}

const NO_AUDIT: PeriodAudit = { silentSubstitution: false };

export function executePlan(
  plan: AnalyticalPlan,
  schema: TableSchema,
  grids: AnalysisGrids,
  periodIndex: PeriodIndex,
  language: "ru" | "en" = "ru",
): AnalyticalExecution {
  const ru = language === "ru";
  const sections: AnalyticalSection[] = [];
  const sourceCells: string[] = [];
  const computed: string[] = [];
  const entityValues: string[] = [];
  let summaryLine: string | undefined;
  let audit: PeriodAudit = NO_AUDIT;
  let events: AnalysisEvent[] | undefined;
  const seriesSet = getTemporalSeriesSet(schema, grids, plan.subject, periodIndex);

  const pushCells = (cs: readonly string[]): void => {
    for (const c of cs) sourceCells.push(c);
  };

  switch (plan.operation) {
    case "argmax":
    case "argmin": {
      const kind = plan.operation === "argmax" ? "max" : "min";
      const wantPeriod = plan.output === "period" || plan.output === "period_and_value";
      const wantValue = plan.output === "value" || plan.output === "period_and_value";
      const cols = [ru ? "Показатель" : "Metric"];
      if (wantPeriod) cols.push(ru ? "Период" : "Period");
      if (wantValue) cols.push(ru ? "Значение" : "Value");
      const rows: (string | number)[][] = [];
      for (const s of seriesSet) {
        const ext = argExtreme(s, kind);
        if (!ext) continue;
        pushCells([ext.point.cell]);
        const r: (string | number)[] = [s.key];
        if (wantPeriod) r.push(ext.point.periodLabel);
        if (wantValue) r.push(fmt(ext.point.value, ext.point.percent));
        rows.push(r);
        entityValues.push(s.key);
      }
      sections.push({
        title: (plan.operation === "argmax" ? (ru ? "Период максимума" : "Period of maximum") : ru ? "Период минимума" : "Period of minimum"),
        columns: cols,
        rows,
      });
      computed.push(plan.operation);
      break;
    }

    case "time_series": {
      const s = seriesSet[0];
      if (s) {
        const rows = s.points.map((p) => {
          pushCells([p.cell]);
          return [p.periodLabel, fmt(p.value, p.percent)] as (string | number)[];
        });
        sections.push({
          title: (ru ? "Динамика: " : "Time series: ") + s.key,
          columns: [ru ? "Период" : "Period", ru ? "Значение" : "Value"],
          rows,
        });
        entityValues.push(s.key);
        const tr = computeTrend(s);
        if (tr) {
          const word = tr.direction === "increasing" ? (ru ? "рост" : "upward") : tr.direction === "decreasing" ? (ru ? "снижение" : "downward") : (ru ? "без явного тренда" : "flat");
          summaryLine = ru
            ? `Общая динамика — ${word} (${s.points.length} точек).`
            : `Overall ${word} trend (${s.points.length} points).`;
        }
        computed.push("time_series");
      }
      break;
    }

    case "compare": {
      if (plan.interval) {
        const startP = plan.interval.start;
        const endP = plan.interval.end;
        audit = {
          requestedStart: startP.canonical,
          requestedEnd: endP.canonical,
          executedStart: startP.canonical,
          executedEnd: endP.canonical,
          silentSubstitution: false,
        };
        const rows: (string | number)[][] = [];
        const pairs = compareMetricSetAtTwoPoints(schema, grids, plan.subject, startP, endP);
        for (const pr of pairs) {
          if (!pr.start || !pr.end) continue;
          pushCells([pr.start.cell, pr.end.cell]);
          const cmp = comparePoints(pr.start, pr.end);
          rows.push([
            pr.key,
            fmt(pr.start.value, pr.start.percent),
            fmt(pr.end.value, pr.end.percent),
            fmt(cmp.absoluteChange, pr.start.percent),
            cmp.percentChange === null ? "—" : fmt(cmp.percentChange, true),
          ]);
          entityValues.push(pr.key);
        }
        sections.push({
          title: ru
            ? `Сравнение: ${startP.headerPath} и ${endP.headerPath}`
            : `Comparison: ${startP.headerPath} vs ${endP.headerPath}`,
          columns: [
            ru ? "Показатель" : "Metric",
            startP.headerPath,
            endP.headerPath,
            ru ? "Δ абс." : "Δ abs",
            ru ? "Δ %" : "Δ %",
          ],
          rows,
        });
        const omitted = pairs.length - rows.length;
        if (omitted > 0) {
          summaryLine = ru
            ? `${omitted} показател${omitted === 1 ? "ь" : "я"} пропущен${omitted === 1 ? "" : "ы"} — нет значения на одну из дат.`
            : `${omitted} metric${omitted === 1 ? "" : "s"} omitted — missing a value at one of the dates.`;
        }
        computed.push("compare");
      }
      break;
    }

    case "change": {
      if (plan.interval) {
        const startP = plan.interval.start;
        const endP = plan.interval.end;
        audit = {
          requestedStart: startP.canonical,
          requestedEnd: endP.canonical,
          executedStart: startP.canonical,
          executedEnd: endP.canonical,
          silentSubstitution: false,
        };
        const pair = compareMetricSetAtTwoPoints(schema, grids, plan.subject, startP, endP)[0];
        const a = pair?.start ?? null;
        const b = pair?.end ?? null;
        if (a && b) {
          pushCells([a.cell, b.cell]);
          const cmp = comparePoints(a, b);
          const label = pair!.key;
          sections.push({
            title: ru ? `Изменение: ${label}` : `Change: ${label}`,
            columns: [startP.headerPath, endP.headerPath, ru ? "Δ абс." : "Δ abs", ru ? "Δ %" : "Δ %"],
            rows: [[
              fmt(a.value, a.percent),
              fmt(b.value, b.percent),
              fmt(cmp.absoluteChange, a.percent),
              cmp.percentChange === null ? "—" : fmt(cmp.percentChange, true),
            ]],
          });
          entityValues.push(label);
          summaryLine = ru
            ? `${label}: с ${fmt(a.value, a.percent)} до ${fmt(b.value, b.percent)} (${cmp.percentChange === null ? "—" : fmt(cmp.percentChange, true)}).`
            : `${label}: from ${fmt(a.value, a.percent)} to ${fmt(b.value, b.percent)} (${cmp.percentChange === null ? "—" : fmt(cmp.percentChange, true)}).`;
          computed.push("change");
        }
      }
      break;
    }

    case "filter": {
      // Stage 24.7.1 §14/§15/§21 — ONE shared change-row primitive either way:
      // an explicit interval reads two points per metric; a relative horizon
      // ("за последний месяц") reads the precomputed Δ column directly — the
      // filter predicate itself (threshold / sign) is identical in both modes.
      let rows0: ChangeRow[] = [];
      let periodColumns: readonly string[] = [];
      let horizonMode = false;
      if (plan.interval) {
        const startP = plan.interval.start;
        const endP = plan.interval.end;
        audit = {
          requestedStart: startP.canonical,
          requestedEnd: endP.canonical,
          executedStart: startP.canonical,
          executedEnd: endP.canonical,
          silentSubstitution: false,
        };
        rows0 = changeRowsFor(compareMetricSetAtTwoPoints(schema, grids, plan.subject, startP, endP));
        periodColumns = [startP.headerPath, endP.headerPath, ru ? "Δ абс." : "Δ abs", ru ? "Δ %" : "Δ %"];
      } else if (plan.period) {
        horizonMode = true;
        const wantPercent = plan.measureBasis !== "absolute_change";
        const useColIndex =
          wantPercent && plan.period.percentColIndex !== undefined ? plan.period.percentColIndex : plan.period.colIndex;
        if (useColIndex >= 0) {
          const col = readColumnByMember(schema, grids, useColIndex);
          rows0 = col.map((c) => ({
            key: c.member.display,
            startValue: 0,
            endValue: c.value,
            absoluteChange: c.value,
            percentChange: c.value,
            startCell: c.cell,
            endCell: c.cell,
          }));
        }
        periodColumns = [plan.period.headerPath];
      }
      if (plan.interval || plan.period) {
        const basis = plan.measureBasis === "absolute_change" ? "absolute_change" : "percentage_change";
        let matched: ChangeRow[];
        if (plan.thresholdValue !== undefined && plan.thresholdMode) {
          matched = filterByChange(rows0, { basis, mode: plan.thresholdMode, threshold: plan.thresholdValue });
        } else {
          const sign = plan.changeSign === "positive" ? "positive" : plan.changeSign === "negative" ? "negative" : "magnitude";
          matched = filterByChange(rows0, { basis, mode: sign, threshold: 0 });
        }
        const rows = matched.map((r) => {
          pushCells(horizonMode ? [r.endCell] : [r.startCell, r.endCell]);
          entityValues.push(r.key);
          return (
            horizonMode
              ? [r.key, fmt(r.endValue, basis === "percentage_change")]
              : [r.key, fmt(r.startValue, false), fmt(r.endValue, false), fmt(r.absoluteChange, false), r.percentChange === null ? "—" : fmt(r.percentChange, true)]
          ) as (string | number)[];
        });
        const title =
          plan.thresholdValue !== undefined
            ? ru
              ? `Показатели с изменением ${plan.thresholdMode === "magnitude" ? "> " : plan.thresholdMode === "positive" ? "рост > " : "снижение > "}${fmt(plan.thresholdValue, true)}`
              : `Metrics changed ${plan.thresholdMode === "magnitude" ? "by more than " : plan.thresholdMode === "positive" ? "up by more than " : "down by more than "}${fmt(plan.thresholdValue, true)}`
            : plan.changeSign === "negative"
              ? ru ? "Снизившиеся показатели" : "Metrics that declined"
              : ru ? "Выросшие показатели" : "Metrics that grew";
        sections.push({
          title,
          columns: [ru ? "Показатель" : "Metric", ...periodColumns],
          rows: rows.length > 0 ? rows : [[ru ? "Нет подходящих показателей" : "No matching metrics", ...periodColumns.map(() => "")]],
        });
        computed.push("filter_change");
      }
      break;
    }

    case "rank": {
      if (plan.period) {
        // Stage 24.7.1 §5/§24–§27 — deterministically pick the column that
        // matches the plan's measure basis (never "whichever column sorts
        // first"). Percentage preferred by default for cross-metric ranking of
        // heterogeneous monetary indicators; an explicit override wins.
        const wantPercent = plan.measureBasis !== "absolute_change";
        const useColIndex =
          wantPercent && plan.period.percentColIndex !== undefined
            ? plan.period.percentColIndex
            : plan.period.colIndex;
        const usedPercent = useColIndex === plan.period.percentColIndex;
        if (useColIndex >= 0) {
          const col = readColumnByMember(schema, grids, useColIndex);
          const asChange: ChangeRow[] = col.map((c) => ({
            key: c.member.display,
            startValue: 0,
            endValue: c.value,
            absoluteChange: c.value,
            percentChange: c.value,
            startCell: c.cell,
            endCell: c.cell,
          }));
          const ranked = rankByChange(asChange, {
            basis: usedPercent ? "percentage_change" : "absolute_change",
            direction: plan.direction ?? "desc",
            ...(plan.changeSign && plan.changeSign !== "any" ? { sign: plan.changeSign } : {}),
            ...(typeof plan.limit === "number" ? { limit: plan.limit } : {}),
          });
          const rows = ranked.map((r) => {
            pushCells([r.endCell]);
            entityValues.push(r.key);
            return [r.key, fmt(r.endValue, usedPercent)] as (string | number)[];
          });
          const basisLabel = usedPercent ? (ru ? "% изменение" : "% change") : ru ? "абс. изменение" : "absolute change";
          if (wantPercent && !usedPercent) {
            summaryLine = ru
              ? "Для этого периода процентное изменение недоступно; использовано абсолютное изменение."
              : "Percentage change is unavailable for this period; used absolute change instead.";
          }
          sections.push({
            title: ru
              ? `${plan.limit ?? rows.length} показателей — ${plan.direction === "asc" ? "наибольшее снижение" : "наибольший рост"} за период «${plan.period.headerPath}» (${basisLabel})`
              : `${plan.limit ?? rows.length} metrics — ${plan.direction === "asc" ? "largest decline" : "largest growth"} over "${plan.period.headerPath}" (${basisLabel})`,
            columns: [ru ? "Показатель" : "Metric", `${plan.period.headerPath} (${basisLabel})`],
            rows,
          });
          computed.push("rank_by_change");
        }
      } else if (plan.interval) {
        // Stage 24.8 §7/§31–§36 — an EXPLICIT interval, never a change-horizon
        // column. Uses the SAME shared primitive as compare/change/filter —
        // one deterministic computation, not a special case per phrase.
        const startP = plan.interval.start;
        const endP = plan.interval.end;
        audit = {
          requestedStart: startP.canonical,
          requestedEnd: endP.canonical,
          executedStart: startP.canonical,
          executedEnd: endP.canonical,
          silentSubstitution: false,
        };
        const field: RankingField = plan.rankingField ?? "abs_percentage_change";
        const rows0 = changeRowsFor(compareMetricSetAtTwoPoints(schema, grids, plan.subject, startP, endP));
        const ranked = rankByField(rows0, {
          field,
          direction: plan.direction ?? "desc",
          ...(plan.changeSign && plan.changeSign !== "any" ? { sign: plan.changeSign } : {}),
          ...(typeof plan.limit === "number" ? { limit: plan.limit } : {}),
        });
        const rows = ranked.map((r) => {
          pushCells([r.startCell, r.endCell]);
          entityValues.push(r.key);
          return [
            r.key,
            fmt(r.startValue, false),
            fmt(r.endValue, false),
            fmt(r.absoluteChange, false),
            r.percentChange === null ? "—" : fmt(r.percentChange, true),
          ] as (string | number)[];
        });
        const basisLabel = rankingFieldLabel(field, ru);
        // §28/§29 — a magnitude ranking mixes growth AND decline; never label
        // it "рост"/"growth" (a signed word) when it isn't signed.
        const isMagnitude = field === "abs_percentage_change" || field === "abs_absolute_change";
        const directionLabel = isMagnitude
          ? (ru ? "наибольшее изменение" : "largest change")
          : ru
            ? plan.direction === "asc" ? "наибольшее снижение" : "наибольший рост"
            : plan.direction === "asc" ? "largest decline" : "largest growth";
        sections.push({
          title: ru
            ? `${plan.limit ?? rows.length} показателей — ${directionLabel} между ${startP.headerPath} и ${endP.headerPath} (${basisLabel})`
            : `${plan.limit ?? rows.length} metrics — ${directionLabel} between ${startP.headerPath} and ${endP.headerPath} (${basisLabel})`,
          columns: [
            ru ? "Показатель" : "Metric",
            startP.headerPath,
            endP.headerPath,
            ru ? "Δ абс." : "Δ abs",
            ru ? "Δ %" : "Δ %",
          ],
          rows: rows.length > 0 ? rows : [[ru ? "Нет подходящих показателей" : "No matching metrics", "", "", "", ""]],
        });
        computed.push("rank_by_interval_change");
      }
      break;
    }

    case "argmax_event": {
      // Stage 24.8 §15–§19 — every metric × every adjacent point-period pair,
      // ranked globally by the requested field. Never a change-horizon /
      // "last month" shortcut (§46 — requested operation must equal executed).
      const field: RankingField = plan.rankingField ?? "abs_percentage_change";
      const allEvents = computeAdjacentPeriodEvents(schema, grids, plan.subject, periodIndex);
      const asChange: ChangeRow[] = allEvents.map((e) => ({
        key: `${e.metricKey}::${e.startPeriod.canonical}::${e.endPeriod.canonical}`,
        startValue: e.startValue,
        endValue: e.endValue,
        absoluteChange: e.absoluteChange,
        percentChange: e.percentageChange,
        startCell: e.startCell,
        endCell: e.endCell,
      }));
      const rankedChange = rankByField(asChange, {
        field,
        direction: plan.direction ?? "desc",
        ...(typeof plan.limit === "number" ? { limit: plan.limit } : {}),
      });
      const byKey = new Map(allEvents.map((e) => [`${e.metricKey}::${e.startPeriod.canonical}::${e.endPeriod.canonical}`, e]));
      const rankedEvents = rankedChange.map((r) => byKey.get(r.key)).filter((e): e is AnalysisEvent => Boolean(e));
      events = rankedEvents;
      const rows = rankedEvents.map((e) => {
        pushCells([e.startCell, e.endCell]);
        entityValues.push(e.metricKey);
        return [
          e.metricKey,
          e.startPeriod.headerPath,
          e.endPeriod.headerPath,
          fmt(e.startValue, false),
          fmt(e.endValue, false),
          fmt(e.absoluteChange, false),
          e.percentageChange === null ? "—" : fmt(e.percentageChange, true),
        ] as (string | number)[];
      });
      sections.push({
        title: ru ? "Наибольшее изменение между соседними периодами" : "Largest change between adjacent periods",
        columns: [
          ru ? "Показатель" : "Metric",
          ru ? "Период начала" : "Start period",
          ru ? "Период конца" : "End period",
          ru ? "Начало" : "Start",
          ru ? "Конец" : "End",
          ru ? "Δ абс." : "Δ abs",
          ru ? "Δ %" : "Δ %",
        ],
        rows: rows.length > 0 ? rows : [[ru ? "Недостаточно данных для сравнения соседних периодов" : "Not enough data for an adjacent-period comparison", "", "", "", "", "", ""]],
      });
      if (rows.length > 0) {
        const winner = rankedEvents[0]!;
        summaryLine = ru
          ? `${winner.metricKey}: с ${fmt(winner.startValue, false)} до ${fmt(winner.endValue, false)} между ${winner.startPeriod.headerPath} и ${winner.endPeriod.headerPath}.`
          : `${winner.metricKey}: from ${fmt(winner.startValue, false)} to ${fmt(winner.endValue, false)} between ${winner.startPeriod.headerPath} and ${winner.endPeriod.headerPath}.`;
      }
      computed.push("argmax_event");
      break;
    }

    case "two_interval_filter": {
      // Stage 24.8 §12–§14 — MetricSet → CHANGE(interval A) → FILTER(sign A) →
      // CHANGE(interval B) → FILTER(sign B). The SAME shared primitive is
      // called once per interval; never a divergent per-metric loop.
      const pis = plan.predicateIntervals ?? [];
      if (pis.length === 2) {
        const [pi1, pi2] = pis as [typeof pis[0], typeof pis[0]];
        audit = {
          requestedStart: pi1.interval.start.canonical,
          requestedEnd: pi1.interval.end.canonical,
          executedStart: pi1.interval.start.canonical,
          executedEnd: pi1.interval.end.canonical,
          silentSubstitution: false,
        };
        const rows1 = changeRowsFor(compareMetricSetAtTwoPoints(schema, grids, plan.subject, pi1.interval.start, pi1.interval.end));
        const rows2 = changeRowsFor(compareMetricSetAtTwoPoints(schema, grids, plan.subject, pi2.interval.start, pi2.interval.end));
        const byKey2 = new Map(rows2.map((r) => [r.key, r]));
        const field: RankingField = plan.rankingField === "absolute_change" || plan.rankingField === "abs_absolute_change" ? "absolute_change" : "percentage_change";
        const rows: (string | number)[][] = [];
        for (const r1 of rows1) {
          if (!signMatches(r1, field, pi1.predicate)) continue;
          const r2 = byKey2.get(r1.key);
          if (!r2 || !signMatches(r2, field, pi2.predicate)) continue;
          pushCells([r1.startCell, r1.endCell, r2.startCell, r2.endCell]);
          entityValues.push(r1.key);
          rows.push([
            r1.key,
            fmt(r1.absoluteChange, false),
            r1.percentChange === null ? "—" : fmt(r1.percentChange, true),
            fmt(r2.absoluteChange, false),
            r2.percentChange === null ? "—" : fmt(r2.percentChange, true),
          ]);
        }
        const predLabel = (p: "positive" | "negative"): string => (p === "positive" ? (ru ? "рост" : "up") : ru ? "снижение" : "down");
        sections.push({
          title: ru
            ? `Показатели: ${predLabel(pi1.predicate)} между ${pi1.interval.start.headerPath} и ${pi1.interval.end.headerPath}, ${predLabel(pi2.predicate)} между ${pi2.interval.start.headerPath} и ${pi2.interval.end.headerPath}`
            : `Metrics: ${predLabel(pi1.predicate)} between ${pi1.interval.start.headerPath} and ${pi1.interval.end.headerPath}, ${predLabel(pi2.predicate)} between ${pi2.interval.start.headerPath} and ${pi2.interval.end.headerPath}`,
          columns: [
            ru ? "Показатель" : "Metric",
            ru ? "Δ абс. (1)" : "Δ abs (1)",
            ru ? "Δ % (1)" : "Δ % (1)",
            ru ? "Δ абс. (2)" : "Δ abs (2)",
            ru ? "Δ % (2)" : "Δ % (2)",
          ],
          rows: rows.length > 0 ? rows : [[ru ? "Нет подходящих показателей" : "No matching metrics", "", "", "", ""]],
        });
        computed.push("two_interval_filter");
      }
      break;
    }

    case "volatility":
    case "stability": {
      const scored: { key: string; score: number; method: string; periods: number; cells: string[] }[] = [];
      for (const s of seriesSet) {
        const v = computeVolatility(s, { measureKind: s.measureKind });
        if ("unavailable" in v) continue;
        scored.push({ key: s.key, score: v.score, method: v.method, periods: v.periods, cells: s.points.map((p) => p.cell) });
      }
      scored.sort((a, b) => (plan.operation === "volatility" ? b.score - a.score : a.score - b.score));
      const rows = scored.map((r) => {
        pushCells(r.cells);
        entityValues.push(r.key);
        return [r.key, Number(r.score.toFixed(4)), r.method === "std_pct_change" ? (ru ? "σ % изменений" : "σ of % changes") : (ru ? "σ изменений уровня" : "σ of level changes"), r.periods] as (string | number)[];
      });
      sections.push({
        title: plan.operation === "volatility" ? (ru ? "Волатильность показателей" : "Metric volatility") : (ru ? "Стабильность показателей" : "Metric stability"),
        columns: [ru ? "Показатель" : "Metric", ru ? "Оценка" : "Score", ru ? "Метод" : "Method", ru ? "Точек" : "Points"],
        rows: rows.length > 0 ? rows : [[ru ? "Недостаточно временных точек" : "Not enough temporal points", "", "", ""]],
      });
      summaryLine = ru
        ? "Метрика: стандартное отклонение period-to-period изменений; стабильность — та же оценка по возрастанию."
        : "Score = standard deviation of period-to-period changes; stability is the same score, ascending.";
      computed.push(plan.operation);
      break;
    }

    case "trend": {
      const scored: { key: string; slope: number; norm: number; r2: number; periods: number; cells: string[] }[] = [];
      for (const s of seriesSet) {
        const tr = computeTrend(s);
        if (!tr) continue;
        scored.push({ key: s.key, slope: tr.slope, norm: tr.normalizedSlope, r2: tr.r2, periods: tr.periods, cells: s.points.map((p) => p.cell) });
      }
      const dir = plan.direction ?? "desc";
      let filtered = scored.filter((r) => (dir === "desc" ? r.norm > 0 : r.norm < 0));
      if (filtered.length === 0) filtered = scored;
      filtered.sort((a, b) => (dir === "desc" ? b.norm - a.norm : a.norm - b.norm));
      const rows = filtered.map((r) => {
        pushCells(r.cells);
        entityValues.push(r.key);
        return [r.key, Number(r.norm.toFixed(4)), Number(r.r2.toFixed(3)), r.periods] as (string | number)[];
      });
      sections.push({
        title: ru ? `Тренд (${dir === "desc" ? "восходящий" : "нисходящий"})` : `Trend (${dir === "desc" ? "upward" : "downward"})`,
        columns: [ru ? "Показатель" : "Metric", ru ? "Норм. наклон" : "Norm. slope", "R²", ru ? "Точек" : "Points"],
        rows,
      });
      summaryLine = ru ? "Наклон нормирован на средний уровень ряда." : "Slope normalised by the series mean level.";
      computed.push("trend");
      break;
    }

    case "monotonicity": {
      const want = plan.monotone ?? "strict_increasing";
      const rows: (string | number)[][] = [];
      for (const s of seriesSet) {
        const mono = testMonotonicity(s);
        if (!mono) continue;
        const ok =
          want === "strict_increasing" ? mono.strictIncreasing
            : want === "non_decreasing" ? mono.nonDecreasing
              : want === "strict_decreasing" ? mono.strictDecreasing
                : mono.nonIncreasing;
        if (!ok) continue;
        pushCells(s.points.map((p) => p.cell));
        entityValues.push(s.key);
        rows.push([s.key, s.points.map((p) => fmt(p.value, p.percent)).join(" → ")]);
      }
      const titleMap: Record<string, [string, string]> = {
        strict_increasing: ["Последовательно росли", "Consecutively increasing"],
        non_decreasing: ["Не снижались", "Non-decreasing"],
        strict_decreasing: ["Последовательно снижались", "Consecutively decreasing"],
        non_increasing: ["Не росли", "Non-increasing"],
      };
      sections.push({
        title: ru ? titleMap[want]![0] : titleMap[want]![1],
        columns: [ru ? "Показатель" : "Metric", ru ? "Ряд" : "Series"],
        rows: rows.length > 0 ? rows : [[ru ? "Нет подходящих показателей" : "No matching metrics", ""]],
      });
      computed.push("monotonicity");
      break;
    }

    case "direction_change": {
      const rows: (string | number)[][] = [];
      for (const s of seriesSet) {
        const dc = detectDirectionChanges(s);
        if (!dc || dc.changes === 0) continue;
        pushCells(s.points.map((p) => p.cell));
        entityValues.push(s.key);
        rows.push([s.key, dc.changes]);
      }
      sections.push({
        title: ru ? "Смена направления динамики" : "Direction changes",
        columns: [ru ? "Показатель" : "Metric", ru ? "Число разворотов" : "Reversals"],
        rows: rows.length > 0 ? rows : [[ru ? "Разворотов не найдено" : "No reversals found", ""]],
      });
      computed.push("direction_change");
      break;
    }

    default:
      break;
  }

  const entityColumn = ru ? "Показатель" : "Metric";
  return {
    sections,
    sourceCells: [...new Set(sourceCells)],
    ...(summaryLine ? { summaryLine } : {}),
    entityColumn,
    entityValues: [...new Set(entityValues)],
    output: plan.output,
    audit,
    computed,
    ...(events ? { events } : {}),
  };
}

/** exported for tests: coerce a cell to a number the same way the executor does. */
export function cellNumber(v: CellValue, fmt2: string | null): number | null {
  const tc = classifyCell(v, fmt2);
  if (tc.type === "number" || tc.type === "integer" || tc.type === "currency" || tc.type === "percentage") return v as number;
  return null;
}
