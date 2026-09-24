import { dimensionFindingType, readDimension } from "../sandbox/exploration.js";
import type { CellValue } from "@sheet-agent/application";
import type { NumberLocale } from "../../analysis/format-number.js";
import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import { isPercentageLike } from "../../app/schema/measure-compatibility.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import { metricFieldIndex } from "../results/result-store.js";
import type { EngineResult } from "../types.js";
import { humanizeValue } from "./humanize.js";
import { displayUnit, metricSemanticClass, type DisplayUnit, type UnitContext } from "./measure-semantics.js";
import { buildFindingSubject, entityAxisOf, type EntityAxis, type FindingSubject, type PeriodRange } from "./finding-subject.js";
import { statementFor } from "./statement.js";
import {
  findingValue,
  type Caveat,
  type ConfidenceSignal,
  type FindingDirection,
  type FindingType,
  type FindingValue,
  type MaterialitySignal,
  type VerifiedFinding,
} from "./verified-finding.js";

/**
 * The schema and grids are OPTIONAL on purpose.
 *
 * With them, a number's unit is resolved from the table it came from (§52) and
 * "доля ликвидных активов" is known to move in percentage points. Without them
 * — a caller holding only results, a test constructing a store by hand — every
 * number still renders, plainly, and nothing claims a unit it cannot show. A
 * missing schema degrades the prose; it never invents a percentage.
 */
export interface ExtractContext {
  readonly schema?: TableSchema;
  readonly grids?: AnalysisGrids;
  readonly locale: NumberLocale;
  readonly axis?: EntityAxis;
}

function unitContext(ctx: ExtractContext): UnitContext | null {
  return ctx.schema && ctx.grids ? { schema: ctx.schema, grids: ctx.grids } : null;
}

function axisOf(ctx: ExtractContext): EntityAxis {
  return ctx.axis ?? entityAxisOf(ctx.schema, ctx.grids);
}

interface SubjectTiming {
  readonly period?: string;
  readonly periodRange?: PeriodRange;
}

function entitySubject(label: string, axis: EntityAxis, timing: SubjectTiming = {}): FindingSubject | null {
  return buildFindingSubject({ scope: "entity", label, axis, ...timing });
}

function withAxis(ctx: ExtractContext): ExtractContext {
  return ctx.axis ? ctx : { ...ctx, axis: entityAxisOf(ctx.schema, ctx.grids) };
}

/** How many observations one result may contribute before it is summarised. */
const MAX_ROW_FINDINGS = 3;

// --- small numeric helpers --------------------------------------------------

function median(values: readonly number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function numberAt(row: readonly CellValue[], index: number): number | null {
  if (index < 0) return null;
  const v = row[index];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function textAt(row: readonly CellValue[], index: number): string {
  if (index < 0) return "";
  const v = row[index];
  return v === null || v === undefined ? "" : String(v);
}

function directionOf(delta: number | null): FindingDirection {
  if (delta === null || !Number.isFinite(delta)) return "none";
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

/** Column index by field name. */
function idx(result: EngineResult, name: string): number {
  return result.fields.findIndex((f) => f.name === name);
}

// --- caveat detection -------------------------------------------------------

/**
 * §39 — is this percentage big because the MOVE is big, or because the BASE is
 * small? The obratnoye-REPO row of a bank balance sheet grows 608% purely
 * because it started at 38.6 against a table whose typical level is in the
 * thousands. Reporting that as the headline growth is technically true and
 * analytically useless, so the fact is kept and the caveat rides with it.
 *
 * "Small" is measured against the median level of the SAME result, so no
 * absolute threshold is invented.
 */
function lowBaseCaveat(startValue: number | null, medianLevel: number, relative: number | null): Caveat | null {
  if (startValue === null || relative === null) return null;
  if (medianLevel <= 0) return null;
  const tiny = Math.abs(startValue) < medianLevel * 0.1;
  const dramatic = Math.abs(relative) >= 1;
  return tiny && dramatic ? { code: "low_base_percentage" } : null;
}

/** §40 — the subject is a detected total row, so it double-counts its parts. */
function totalCaveat(ctx: ExtractContext, metricKey: string): Caveat | null {
  const isTotal = (ctx.schema?.totals ?? []).some((t) => t.label === metricKey);
  return isTotal ? { code: "total_row_overlap" } : null;
}

/**
 * §73 — a ranking whose basis is an ABSOLUTE magnitude is only meaningful when
 * the ranked metrics share a unit. A balance sheet that ranks an amount in
 * billions against a percentage share produces a confident, meaningless order.
 */
function mixedUnitsCaveat(ctx: ExtractContext, metricKeys: readonly string[]): Caveat | null {
  if (metricKeys.length < 2) return null;
  const unit = unitContext(ctx);
  if (!unit) return null;
  const classes = new Set(metricKeys.map((k) => metricSemanticClass(unit.schema, unit.grids, k)));
  const hasPercentLike = [...classes].some((c) => isPercentageLike(c));
  const hasMagnitude = [...classes].some((c) => c === "amount" || c === "count");
  return hasPercentLike && hasMagnitude ? { code: "mixed_units" } : null;
}

// --- per-result extraction --------------------------------------------------

interface RowFinding {
  readonly subject: string;
  readonly values: readonly FindingValue[];
  readonly direction: FindingDirection;
  readonly materiality: readonly MaterialitySignal[];
  readonly confidence: readonly ConfidenceSignal[];
  readonly caveats: readonly Caveat[];
  /** Magnitude used to decide which rows are worth stating. */
  readonly weight: number;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly subjectRef?: FindingSubject | null;
}

/**
 * A `comparison` / `event` result: start, end, absolute and relative change per
 * metric. The richest and most common shape, and the one §41's example is.
 */
export function periodLabelOf(result: EngineResult, which: 0 | 1): string {
  const canonicals = result.periodCanonicals ?? [];
  if (canonicals.length !== 2) return "";
  const labelled = result.metadata[which === 0 ? "startLabel" : "endLabel"];
  if (typeof labelled === "string" && labelled.trim() !== "") return labelled.trim();
  return canonicals[which] ?? "";
}

function changeRows(result: EngineResult, ctx: ExtractContext): readonly RowFinding[] {
  const mi = metricFieldIndex(result);
  const iStart = idx(result, "startValue");
  const iEnd = idx(result, "endValue");
  const iAbs = idx(result, "absoluteChange");
  const iPct = idx(result, "percentageChange");
  const iStartLabel = idx(result, "startPeriodLabel");
  const iEndLabel = idx(result, "endPeriodLabel");
  // A change is stateable from its DELTAS alone. `set.argmax` — the single
  // most common primary result in the engine — returns the winner's absolute
  // and relative change without repeating the endpoints, and requiring them
  // here is what would leave the most common answer with no observation at all.
  if (iAbs < 0 && iPct < 0 && (iStart < 0 || iEnd < 0)) return [];

  const levels = result.rows.flatMap((r) => {
    const a = numberAt(r, iStart);
    const b = numberAt(r, iEnd);
    return [a, b].filter((v): v is number => v !== null).map(Math.abs);
  });
  const medianLevel = median(levels);
  const relatives = result.rows.map((r) => Math.abs(numberAt(r, iPct) ?? 0));
  const order = relatives.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const rankOf = new Map<number, number>(order.map(([, i], pos) => [i, pos + 1]));

  const axis = axisOf(ctx);

  const spanStart = periodLabelOf(result, 0);
  const spanEnd = periodLabelOf(result, 1);

  return result.rows.map((row, rowIndex) => {
    const subject = textAt(row, mi);
    const start = numberAt(row, iStart);
    const end = numberAt(row, iEnd);
    const abs = numberAt(row, iAbs);
    const pct = numberAt(row, iPct);
    const levelUnit = displayUnit(unitContext(ctx), "startValue", subject);
    const deltaUnit = displayUnit(unitContext(ctx), "absoluteChange", subject);

    const values: FindingValue[] = [];
    if (start !== null) values.push(findingValue("startValue", start, levelUnit, ctx.locale, { at: textAt(row, iStartLabel) || spanStart }));
    if (end !== null) values.push(findingValue("endValue", end, levelUnit, ctx.locale, { at: textAt(row, iEndLabel) || spanEnd }));
    if (abs !== null) values.push(findingValue("absoluteChange", abs, deltaUnit, ctx.locale, { signed: true }));
    if (pct !== null) values.push(findingValue("percentageChange", pct, { kind: "percent_fraction" }, ctx.locale, { signed: true }));

    const materiality: MaterialitySignal[] = [];
    if (abs !== null) materiality.push({ kind: "magnitude", value: abs, unit: deltaUnit });
    if (pct !== null) materiality.push({ kind: "relative_magnitude", fraction: pct });
    if (result.rows.length > 1) {
      materiality.push({ kind: "rank", position: rankOf.get(rowIndex) ?? result.rows.length, outOf: result.rows.length, basis: "abs_percentage_change" });
    }

    const caveats: Caveat[] = [];
    // §23/§25 — a relative change that does not exist is stated as not
    // existing. It never silently becomes 0%, and it never becomes "no change".
    if (pct === null && start !== null && Math.abs(start) < 1e-12) caveats.push({ code: "relative_undefined_zero_base" });
    const lowBase = lowBaseCaveat(start, medianLevel, pct);
    if (lowBase) {
      caveats.push(lowBase);
      if (start !== null) {
        caveats[caveats.length - 1] = { code: "low_base_percentage", detail: humanizeValue(start, levelUnit, ctx.locale) };
      }
    }
    const total = totalCaveat(ctx, subject);
    if (total) caveats.push(total);

    return {
      subject,
      subjectRef: entitySubject(subject, axis, { periodRange: { start: textAt(row, iStartLabel), end: textAt(row, iEndLabel) } }),
      values,
      direction: directionOf(abs),
      materiality,
      confidence: [],
      caveats,
      weight: Math.abs(pct ?? 0),
    };
  });
}

/** A `series` result: one row per period for one metric. */
function seriesFindings(result: EngineResult, ctx: ExtractContext): readonly RowFinding[] {
  const mi = metricFieldIndex(result);
  const iValue = idx(result, "value");
  const iLabel = idx(result, "periodLabel");
  if (iValue < 0 || result.rows.length === 0) return [];
  const subject = textAt(result.rows[0] ?? [], mi);
  const axis = axisOf(ctx);
  const unit = displayUnit(unitContext(ctx), "value", subject);
  const points = result.rows
    .map((r) => ({ label: textAt(r, iLabel), value: numberAt(r, iValue) }))
    .filter((p): p is { label: string; value: number } => p.value !== null);
  if (points.length < 2) return [];

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const lo = points.reduce((m, p) => (p.value < m.value ? p : m), first);
  const hi = points.reduce((m, p) => (p.value > m.value ? p : m), first);
  const delta = last.value - first.value;
  const relative = Math.abs(first.value) < 1e-12 ? null : delta / Math.abs(first.value);

  const values: FindingValue[] = [
    findingValue("startValue", first.value, unit, ctx.locale, { at: first.label }),
    findingValue("endValue", last.value, unit, ctx.locale, { at: last.label }),
    // §31/§56 — the SIZE of the move, stated by the engine rather than left for
    // the narrator to derive. Without it the narrator can see 100 and 131 and
    // cannot say "+31" without subtracting, which the fact gate correctly
    // refuses; the live run lost two otherwise-good answers to exactly that,
    // and the fix is to supply the figure, not to loosen the gate.
    findingValue("absoluteChange", delta, unit, ctx.locale, { signed: true }),
    findingValue("min", lo.value, unit, ctx.locale, { at: lo.label }),
    findingValue("max", hi.value, unit, ctx.locale, { at: hi.label }),
  ];
  if (relative !== null) values.push(findingValue("percentageChange", relative, { kind: "percent_fraction" }, ctx.locale, { signed: true }));

  const caveats: Caveat[] = [];
  if (points.length < 3) caveats.push({ code: "few_observations", detail: String(points.length) });
  // §39 — the same low-base test `changeRows` applies, measured here against
  // the series' own typical level: a rise from 2 to 40 is a different claim
  // from a rise of the same percentage from 2000 to 40000.
  const lowBase = lowBaseCaveat(first.value, median(points.map((p) => Math.abs(p.value))), relative);
  if (lowBase) caveats.push({ code: "low_base_percentage", detail: humanizeValue(first.value, unit, ctx.locale) });

  // §23/§25 — the distinction the whole pipeline preserves, finally said out
  // loud. `zero_not_absence` and `missing_excluded` were in the caveat
  // vocabulary from the start and nothing emitted either of them, so a series
  // holding a recorded 0 and a series holding an empty cell narrated
  // identically — which is the one outcome §25 exists to prevent. A reader
  // asking "были месяцы без продаж?" is asking precisely which of the two it
  // is, and now the answer carries it.
  //
  // Tied to whether the zero is part of what the sentence SAYS, not merely to
  // whether the series contains one. A zero that is the low point or an
  // endpoint gets quoted — «Минимум — 0 (Фев)» — and that figure is the one a
  // reader will take as "не продавали"; a zero sitting unremarked in the
  // middle of a signed series is not worth a caveat, and attaching one to
  // every series that happens to contain a zero would make the qualification
  // ordinary, which is the same as making it invisible.
  const recordedZeros = points.filter((p) => p.value === 0);
  const zeroIsQuoted = lo.value === 0 || first.value === 0 || last.value === 0;
  if (recordedZeros.length > 0 && zeroIsQuoted) {
    caveats.push({ code: "zero_not_absence", detail: recordedZeros.map((p) => p.label).filter((l) => l !== "").join(", ") || String(recordedZeros.length) });
  }
  const skipped = result.rows.length - points.length;
  if (skipped > 0) caveats.push({ code: "missing_excluded", detail: String(skipped) });

  return [
    {
      subject,
      subjectRef: entitySubject(subject, axis, { periodRange: { start: first.label, end: last.label } }),
      values,
      direction: directionOf(delta),
      materiality: [{ kind: "persistence", periods: points.length, outOf: points.length }],
      confidence: [{ kind: "observations", count: points.length }],
      caveats,
      weight: Math.abs(relative ?? 0),
      detail: { periods: points.map((p) => p.label) },
    },
  ];
}

/** A scored per-metric result — volatility, stability, any single `score`. */
function scoreRows(result: EngineResult, ctx: ExtractContext, scoreField: string): readonly RowFinding[] {
  const mi = metricFieldIndex(result);
  const iScore = idx(result, scoreField);
  if (iScore < 0) return [];
  const scores = result.rows.map((r) => numberAt(r, iScore) ?? 0);
  const med = median(scores.map(Math.abs));
  const order = scores.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const rankOf = new Map<number, number>(order.map(([, i], pos) => [i, pos + 1]));

  const axis = axisOf(ctx);
  const volatilityDetails = result.metadata["volatilityDetails"] as Readonly<Record<string, unknown>> | undefined;

  return result.rows.map((row, rowIndex) => {
    const subject = textAt(row, mi);
    const score = numberAt(row, iScore);
    const materiality: MaterialitySignal[] = [];
    if (score !== null) {
      materiality.push({ kind: "dispersion", score, basis: scoreField });
      if (result.rows.length > 1) materiality.push({ kind: "rank", position: rankOf.get(rowIndex) ?? result.rows.length, outOf: result.rows.length, basis: scoreField });
    }
    return {
      subject,
      subjectRef: entitySubject(subject, axis),
      values: score === null ? [] : [findingValue(scoreField, score, { kind: "score" }, ctx.locale)],
      direction: "none",
      materiality,
      confidence: [],
      caveats: [],
      // §51 — a score is only worth stating when it stands out from its peers.
      weight: score === null || med <= 0 ? 0 : Math.abs(score) / med,
      ...(volatilityDetails?.[subject] && typeof volatilityDetails[subject] === "object" ? { detail: volatilityDetails[subject] as Readonly<Record<string, unknown>> } : {}),
    };
  });
}

/** A `trend` result: slope, direction and fit per metric. */
function trendRows(result: EngineResult, ctx: ExtractContext): readonly RowFinding[] {
  const mi = metricFieldIndex(result);
  const iSlope = idx(result, "slope");
  const iNorm = idx(result, "normalizedSlope");
  const iDir = idx(result, "direction");
  const iR2 = idx(result, "r2");
  const iPeriods = idx(result, "periods");
  if (iDir < 0) return [];

  const axis = axisOf(ctx);

  return result.rows.map((row) => {
    const subject = textAt(row, mi);
    const dirText = textAt(row, iDir);
    const slope = numberAt(row, iSlope);
    const norm = numberAt(row, iNorm);
    const r2 = numberAt(row, iR2);
    const periods = numberAt(row, iPeriods);
    const values: FindingValue[] = [];
    if (slope !== null) values.push(findingValue("slope", slope, { kind: "score" }, ctx.locale, { signed: true }));
    if (r2 !== null) values.push(findingValue("r2", r2, { kind: "score" }, ctx.locale));
    if (periods !== null) values.push(findingValue("periods", periods, { kind: "count" }, ctx.locale));

    const caveats: Caveat[] = [];
    if (periods !== null && periods < 3) caveats.push({ code: "few_observations", detail: String(periods) });

    return {
      subject,
      subjectRef: entitySubject(subject, axis),
      values,
      direction: dirText === "increasing" ? "up" : dirText === "decreasing" ? "down" : "flat",
      materiality: r2 === null ? [] : [{ kind: "dispersion", score: r2, basis: "r2" }],
      confidence: periods === null ? [] : [{ kind: "observations", count: periods }],
      caveats,
      weight: Math.abs(norm ?? slope ?? 0),
      detail: { direction: dirText },
    };
  });
}

/** A `monotonicity` result: how long a run held, in each direction. */
function monotonicityRows(result: EngineResult, ctx: ExtractContext): readonly RowFinding[] {
  const mi = metricFieldIndex(result);
  const iUp = idx(result, "strictIncreasing");
  const iDown = idx(result, "strictDecreasing");
  const iPeriods = idx(result, "periods");
  if (iUp < 0 && iDown < 0) return [];

  const axis = axisOf(ctx);

  return result.rows.map((row) => {
    const subject = textAt(row, mi);
    const up = numberAt(row, iUp) ?? 0;
    const down = numberAt(row, iDown) ?? 0;
    const periods = numberAt(row, iPeriods) ?? 0;
    const run = Math.max(up, down);
    return {
      subject,
      subjectRef: entitySubject(subject, axis),
      values: [
        findingValue("runLength", run, { kind: "count" }, ctx.locale),
        ...(periods > 0 ? [findingValue("periods", periods, { kind: "count" }, ctx.locale)] : []),
      ],
      direction: up > down ? "up" : down > up ? "down" : "flat",
      materiality: periods > 0 ? [{ kind: "persistence", periods: run, outOf: periods }] : [],
      confidence: [{ kind: "observations", count: periods }],
      caveats: [],
      weight: periods > 0 ? run / periods : 0,
    };
  });
}

/** A `direction_changes` result: how many times a series reversed. */
function reversalRows(result: EngineResult, ctx: ExtractContext): readonly RowFinding[] {
  const mi = metricFieldIndex(result);
  const iCount = idx(result, "directionChangeCount");
  if (iCount < 0) return [];
  const axis = axisOf(ctx);
  return result.rows.map((row) => {
    const subject = textAt(row, mi);
    const count = numberAt(row, iCount) ?? 0;
    return {
      subject,
      subjectRef: entitySubject(subject, axis),
      values: [findingValue("directionChangeCount", count, { kind: "count" }, ctx.locale)],
      direction: count > 0 ? "mixed" : "flat",
      materiality: [{ kind: "dispersion", score: count, basis: "direction_changes" }],
      confidence: [],
      caveats: [],
      weight: count,
    };
  });
}

/**
 * §77 — a `schema` result describes the TABLE. It has no metric column and no
 * measured value, so every other extractor here declines it, and without this
 * one "расскажи про эти данные" falls through to printing the schema row as a
 * table — which is the one answer §43 rules out.
 */
function overviewRows(result: EngineResult, ctx: ExtractContext): readonly RowFinding[] {
  const row = result.rows[0];
  if (!row) return [];
  const read = (name: string): string => textAt(row, idx(result, name));
  const count = (name: string): number | null => {
    const raw = read(name);
    const n = Number(raw);
    return raw !== "" && Number.isFinite(n) ? n : null;
  };
  const metrics = count("metricCount");
  const periods = count("periodCount");
  const values: FindingValue[] = [];
  if (metrics !== null) values.push(findingValue("metricCount", metrics, { kind: "count" }, ctx.locale));
  if (periods !== null) values.push(findingValue("periodCount", periods, { kind: "count" }, ctx.locale));
  return [
    {
      subject: read("sheet"),
      subjectRef: { scope: "table" as const },
      values,
      direction: "none",
      materiality: [],
      confidence: [],
      caveats: [],
      weight: 1,
      detail: { range: read("range"), orientation: read("orientation"), metricNames: result.metricKeys.slice(0, 8) },
    },
  ];
}

/**
 * Stage 27 §31/§40 — observations from a SANDBOX result.
 *
 * Without this, a clustering answer reaches the narrator as a table of member
 * and label and leaves as a table of member and label — the raw dump §43 rules
 * out. The structure is already there; what is missing is the reading of it,
 * and the reading is mechanical: a group is a subject, its size is a
 * materiality signal, its profile is the numbers it is entitled to quote.
 *
 * Recognised by the METADATA the adapter attached, never by column names a
 * generated script happened to choose.
 */
function sandboxRows(result: EngineResult, ctx: ExtractContext): readonly RowFinding[] {
  const mi = metricFieldIndex(result);
  const iGroup = idx(result, "group");
  const axis = axisOf(ctx);

  if (iGroup >= 0) {
    // One finding per GROUP, not per member: "there are two segments" is the
    // observation; "Queue depth is in segment A" is a row of evidence.
    const byGroup = new Map<string, string[]>();
    const profiles = new Map<string, Map<string, number>>();
    const profileFields = result.fields
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => f.kind === "number" && i !== iGroup && i !== mi);

    for (const row of result.rows) {
      const label = textAt(row, iGroup);
      const member = textAt(row, mi);
      const members = byGroup.get(label) ?? [];
      members.push(member);
      byGroup.set(label, members);
      if (!profiles.has(label)) {
        const values = new Map<string, number>();
        for (const { f, i } of profileFields) {
          const v = numberAt(row, i);
          if (v !== null) values.set(f.name, v);
        }
        profiles.set(label, values);
      }
    }

    const total = result.rows.length;
    return [...byGroup.entries()].map(([label, members]) => {
      const profile = profiles.get(label) ?? new Map<string, number>();
      const values: FindingValue[] = [
        findingValue("clusterSize", members.length, { kind: "count" }, ctx.locale),
        ...[...profile.entries()].map(([name, value]) => findingValue(name, value, { kind: "score" }, ctx.locale)),
      ];
      return {
        subject: label,
        subjectRef: buildFindingSubject({ scope: "group", label, members, axis }),
        values,
        direction: "none" as const,
        materiality: [{ kind: "share_of_movement", fraction: total > 0 ? members.length / total : 0, of: "the analysed set" }],
        confidence: [{ kind: "observations", count: members.length }],
        caveats: [],
        // §39 — an unusually SMALL group is the interesting one: it is where an
        // outlier ends up. A group holding half the set says little.
        weight: total > 0 ? 1 - members.length / total : 0,
        detail: { members },
      };
    });
  }

  // Any other sandbox table: the first numeric column is the measurement, and
  // the rows are ranked by it so the narrator leads with what stands out.
  const iValue = result.fields.findIndex((f) => f.kind === "number");
  if (iValue < 0 || mi < 0) return [];
  const values = result.rows.map((r) => Math.abs(numberAt(r, iValue) ?? 0));
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const rankOf = new Map<number, number>(order.map(([, i], pos) => [i, pos + 1]));
  const field = result.fields[iValue]?.name ?? "value";

  return result.rows.map((row, rowIndex) => {
    const value = numberAt(row, iValue);
    const subject = textAt(row, mi);
    return {
      subject,
      subjectRef: entitySubject(subject, axis),
      values: value === null ? [] : [findingValue(field, value, { kind: "score" }, ctx.locale)],
      direction: "none" as const,
      materiality:
        value === null
          ? []
          : [
              { kind: "dispersion", score: value, basis: field },
              ...(result.rows.length > 1 ? ([{ kind: "rank", position: rankOf.get(rowIndex) ?? result.rows.length, outOf: result.rows.length, basis: field }] as const) : []),
            ],
      confidence: [],
      caveats: [],
      weight: Math.abs(value ?? 0),
    };
  });
}

/** A `value` result: one level, at one period. */
function valueRows(result: EngineResult, ctx: ExtractContext): readonly RowFinding[] {
  const mi = metricFieldIndex(result);
  const iValue = idx(result, "value");
  const iLabel = idx(result, "periodLabel");
  if (iValue < 0) return [];
  const axis = axisOf(ctx);
  return result.rows.map((row) => {
    const subject = textAt(row, mi);
    const value = numberAt(row, iValue);
    const subjectRef = entitySubject(subject, axis, { period: textAt(row, iLabel) });
    if (value === null) return { subject, subjectRef, values: [], direction: "none" as const, materiality: [], confidence: [], caveats: [], weight: 0 };
    const unit = displayUnit(unitContext(ctx), "value", subject);
    return {
      subject,
      subjectRef,
      values: [findingValue("value", value, unit, ctx.locale, { at: textAt(row, iLabel) })],
      direction: "none" as const,
      materiality: [{ kind: "magnitude", value, unit }],
      confidence: [],
      caveats: totalCaveat(ctx, subject) ? [totalCaveat(ctx, subject)!] : [],
      weight: 1,
    };
  });
}

// --- result → findings ------------------------------------------------------

/** Which extraction a result type gets, and what the observation is CALLED. */
function findingTypeOf(result: EngineResult): FindingType {
  if (result.metadata["sandbox"] === true) {
    // §37 — an exploration result knows which dimension it answers, and each
    // dimension already corresponds to a kind of observation the insight layer
    // can state. Checked first: it is the most specific thing known about the
    // result, and guessing from its columns would get `changes` wrong.
    const dimension = readDimension(result.metadata["explorationDimension"]);
    if (dimension) return dimensionFindingType(dimension);
    if (result.metadata["outputName"] === "groups") return "cluster";
    if (result.type === "series") return "trend";
    // A distribution needs something to be distributed. One row is a single
    // measurement, and the live run narrated one as «Значения «…» распределены
    // довольно ровно» — a sentence about the shape of a set of size one. The
    // sandbox's generic fallback stays `distribution`, but only once there is
    // a spread to describe.
    if (result.rows.length < 3) return "value";
    return "distribution";
  }
  switch (result.type) {
    case "comparison":
      return "change";
    case "event":
    case "event_set":
      return "event";
    case "series":
      return "trend";
    case "trend":
      return "trend";
    case "volatility":
      return "volatility";
    case "stability":
      return "stability";
    case "monotonicity":
      return "monotonicity";
    case "direction_changes":
      return "direction_change";
    case "ranked_set":
      return "ranking";
    case "metric_winner":
      return "extremum";
    case "schema":
      return "table_overview";
    case "value":
    case "aggregate":
      return "value";
    case "filtered_set":
      return result.rows.length === 0 ? "empty_set" : "ranking";
    default:
      return "value";
  }
}

function rowsFor(result: EngineResult, ctx: ExtractContext): readonly RowFinding[] {
  const has = (name: string) => idx(result, name) >= 0;
  // Stage 27 — a sandbox result is read from its structure, not from field
  // names a generated script chose, so it is dispatched before everything else.
  if (result.metadata["sandbox"] === true) {
    // §37 — a `changes` or `trends` dimension returns the canonical field
    // names, so it is read by the readers that already understand them rather
    // than flattened into a generic score. Everything else is generic, which
    // is what `sandboxRows` is for.
    if (readDimension(result.metadata["explorationDimension"])) {
      if (has("absoluteChange") || has("percentageChange")) return changeRows(result, ctx);
      if (has("slope")) return trendRows(result, ctx);
    }
    return sandboxRows(result, ctx);
  }
  if (result.type === "schema" || (has("sheet") && has("range"))) return overviewRows(result, ctx);
  if (has("absoluteChange") || has("percentageChange")) return changeRows(result, ctx);
  if (result.type === "series" || (has("periodLabel") && has("value") && result.rows.length > 2)) return seriesFindings(result, ctx);
  if (has("slope") || has("direction")) return trendRows(result, ctx);
  if (has("strictIncreasing") || has("strictDecreasing")) return monotonicityRows(result, ctx);
  if (has("directionChangeCount")) return reversalRows(result, ctx);
  if (has("score")) return scoreRows(result, ctx, "score");
  if (has("value")) return valueRows(result, ctx);
  // The LAST RESORT, and it must not be silence.
  //
  // Returning [] here means the narrator is handed a result and nothing to say
  // about it, which the live run turned into a confident falsehood: `set.top`
  // over a sandbox correlation table has columns nothing above recognises, so
  // no finding was drawn, and the answer declared the table empty. A result
  // with a subject column and a number in it always supports the plainest
  // observation there is — this subject, this measurement — and `sandboxRows`
  // already knows how to state exactly that.
  return sandboxRows(result, ctx);
}

export interface ExtractOptions {
  /** Answers a "most/least" question, so the top row is the point. */
  readonly role?: "primary" | "supporting";
  readonly maxFindings?: number;
}

let findingSeq = 0;

/** Test seam: ids are only required to be unique within an answer. */
export function resetFindingIds(): void {
  findingSeq = 0;
}

/**
 * §40 — the observations one result supports, most material first.
 *
 * A result with a handful of rows yields one finding per row. A wide one is
 * summarised: the rows that stand out become findings and the set itself
 * becomes a ranking, because twenty change findings is twenty raw rows wearing
 * a different coat (§43).
 */
export function extractFindings(result: EngineResult, rawContext: ExtractContext, opts: ExtractOptions = {}): readonly VerifiedFinding[] {
  const ctx = withAxis(rawContext);
  const axis = axisOf(ctx);
  const type = findingTypeOf(result);
  const provenance = {
    resultRef: result.resultId,
    tool: result.tool,
    sourceRange: result.sourceRange,
    sourceVersion: result.sourceVersion,
    periods: result.periodCanonicals,
  };

  if (type === "empty_set") {
    const predicate = result.metadata["predicate"];
    return [
      finalize({
        findingType: "empty_set",
        subject: "",
        subjectRef: { scope: "table" },
        direction: "none",
        values: [],
        materiality: [],
        confidence: [],
        caveats: [],
        provenance,
        ...(predicate !== undefined ? { detail: { predicate } } : {}),
      }, ctx),
    ];
  }

  const rows = rowsFor(result, ctx);
  if (rows.length === 0) return [];

  const limit = opts.maxFindings ?? MAX_ROW_FINDINGS;
  const ordered = rows.slice().sort((a, b) => b.weight - a.weight);
  // A ranked or winner result has already declared its own order; the planner
  // chose it, so the engine must not re-sort it by its own idea of importance.
  const selected = type === "ranking" || type === "extremum" ? rows.slice(0, limit) : ordered.slice(0, limit);

  const findings = selected.map((row) =>
    finalize(
      {
        findingType: type,
        subject: row.subject,
        ...(row.subjectRef ? { subjectRef: row.subjectRef } : {}),
        direction: row.direction,
        values: row.values,
        materiality: row.materiality,
        confidence: row.confidence,
        caveats: row.caveats,
        provenance,
        ...(row.detail !== undefined ? { detail: row.detail } : {}),
      },
      ctx,
    ),
  );

  // §39/§54 — when a result held more rows than were stated, the SET itself is
  // a finding, so the answer can say "of six indicators, four fell" instead of
  // silently dropping the rest.
  if (rows.length > selected.length) {
    const ranking = result.metadata["ranking"];
    const caveats: Caveat[] = [];
    const mixed = mixedUnitsCaveat(ctx, rows.map((r) => r.subject));
    if (mixed && typeof ranking === "object" && ranking !== null && (ranking as { magnitude?: string }).magnitude === "absolute") {
      caveats.push(mixed);
    }
    findings.push(
      finalize(
        {
          findingType: "ranking",
          subject: "",
          ...(() => {
            const set = buildFindingSubject({ scope: "group", members: rows.map((r) => r.subject), axis });
            return set ? { subjectRef: set } : {};
          })(),
          counterparts: rows.map((r) => r.subject),
          direction: "mixed",
          values: [],
          materiality: [{ kind: "rank", position: 1, outOf: rows.length, basis: String((ranking as { field?: string } | undefined)?.field ?? "magnitude") }],
          confidence: [],
          caveats,
          provenance,
          detail: { setSize: rows.length, stated: selected.length, named: selected.map((r) => r.subject) },
        },
        ctx,
      ),
    );
  }

  return findings;
}

function finalize(
  draft: Omit<VerifiedFinding, "id" | "statement">,
  ctx: ExtractContext,
): VerifiedFinding {
  findingSeq += 1;
  const withId = { ...draft, id: `finding_${findingSeq}` };
  return { ...withId, statement: statementFor(withId as VerifiedFinding, ctx.locale) };
}

/**
 * §55 — the findings an ANSWER is built from: the primary result's
 * observations first, then each supporting result's, deduplicated by subject
 * and finding type so a metric restated by three tools is one observation.
 */
export function buildFindings(
  primary: EngineResult,
  supporting: readonly EngineResult[],
  rawContext: ExtractContext,
  maxTotal = 8,
): readonly VerifiedFinding[] {
  const ctx = withAxis(rawContext);
  const out: VerifiedFinding[] = [...extractFindings(primary, ctx, { role: "primary" })];
  const seen = new Set(out.map((f) => `${f.findingType}:${f.subject}`));
  for (const result of supporting) {
    for (const finding of extractFindings(result, ctx, { role: "supporting", maxFindings: 2 })) {
      const key = `${finding.findingType}:${finding.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finding);
      if (out.length >= maxTotal) return out;
    }
  }
  return out;
}

/** Every number the answer may quote, across all findings (§56). */
export function allowedNumbers(findings: readonly VerifiedFinding[]): readonly number[] {
  const out: number[] = [];
  for (const finding of findings) {
    for (const value of finding.values) out.push(value.value);
    for (const signal of finding.materiality) {
      if (signal.kind === "magnitude") out.push(signal.value);
      else if (signal.kind === "relative_magnitude") out.push(signal.fraction);
      else if (signal.kind === "rank") out.push(signal.position, signal.outOf);
      else if (signal.kind === "persistence") out.push(signal.periods, signal.outOf);
      else if (signal.kind === "dispersion") out.push(signal.score);
      else if (signal.kind === "share_of_movement") out.push(signal.fraction);
    }
  }
  return out;
}

/** Display units in play, so the verifier knows a p.p. claim is legitimate (§53). */
export function unitsInPlay(findings: readonly VerifiedFinding[]): readonly DisplayUnit[] {
  return findings.flatMap((f) => f.values.map((v) => v.unit));
}
