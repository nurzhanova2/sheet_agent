// ---------------------------------------------------------------------------
// VerifiedFacts (Stage 21.2.2).
//
// The LLM MAY PLAN AND EXPLAIN. It MUST NOT CALCULATE. Every deterministic
// numeric or comparative statement it is allowed to make must already exist here
// as a VerifiedFact, produced by pure code from the frozen 21.2.1 engine output
// and traceable to a source operation and range.
//
// This layer NEVER re-reads the workbook and NEVER calls the engine. It only
// derives shares / ratios / rankings / extremes / closest-pair / combined
// comparisons from AnalysisResult values that the engine already computed.
// ---------------------------------------------------------------------------

import {
  formatCorrelation,
  formatCount,
  formatNumber,
  formatPercent,
  formatRatio,
} from "./format-number.js";
import {
  isAnalysisError,
  type AnalysisOutcome,
  type AnalysisRequest,
  type AnalysisResult,
  type Expression,
  type GroupMetric,
} from "./types.js";

export type VerifiedFactKind = "scalar" | "share" | "ratio" | "ranking" | "extreme" | "pair" | "comparison";

interface FactBase {
  readonly id: string;
  readonly kind: VerifiedFactKind;
  /** Human-readable statement of the fact. */
  readonly label: string;
  /** Deterministically formatted display string (what the model should quote). */
  readonly formatted: string;
  /** Which batch operation produced the source numbers. */
  readonly sourceOperationId: string;
  /** The workbook range the numbers came from. */
  readonly sourceRange: string;
}

export interface ScalarFact extends FactBase {
  readonly kind: "scalar";
  readonly value: number;
  readonly metric: string;
  readonly group?: string;
}
export interface ShareFact extends FactBase {
  readonly kind: "share";
  /** Fraction 0..1. */
  readonly value: number;
  readonly group: string;
  readonly ofWhat: string;
}
export interface RatioFact extends FactBase {
  readonly kind: "ratio";
  readonly value: number;
  readonly numerator: string;
  readonly denominator: string;
}
export interface RankingFact extends FactBase {
  readonly kind: "ranking";
  readonly metric: string;
  readonly direction: "desc" | "asc";
  readonly order: readonly string[];
  readonly values: readonly number[];
}
export interface ExtremeFact extends FactBase {
  readonly kind: "extreme";
  readonly which: "max" | "min";
  readonly group: string;
  readonly value: number;
  readonly metric: string;
}
export interface PairFact extends FactBase {
  readonly kind: "pair";
  readonly which: "closest" | "farthest";
  readonly groups: readonly [string, string];
  readonly delta: number;
  readonly metric: string;
}
export interface ComparisonFact extends FactBase {
  readonly kind: "comparison";
  readonly subject: string;
  readonly relation: "greater_than" | "less_than" | "equal";
  readonly object: string;
  readonly subjectValue: number;
  readonly objectValue: number;
}

export type VerifiedFact =
  | ScalarFact
  | ShareFact
  | RatioFact
  | RankingFact
  | ExtremeFact
  | PairFact
  | ComparisonFact;

const MAX_FACTS = 90;
const EQUAL_TOLERANCE = 1e-9;

function metricKey(metric: GroupMetric, position: number): string {
  return metric.name ?? `${metric.metric}${position === 0 ? "" : `_${position}`}`;
}

/** Extensive quantities where a part/whole share is meaningful. */
function isExtensive(metric: GroupMetric | undefined): boolean {
  return metric !== undefined && (metric.metric === "count" || metric.metric === "sum");
}

class FactBuilder {
  private readonly facts: VerifiedFact[] = [];
  private seq = 0;
  constructor(
    private readonly sourceOperationId: string,
    private readonly sourceRange: string,
  ) {}

  private next(): string {
    this.seq += 1;
    return `F${this.seq}`;
  }

  private push<T extends VerifiedFact>(fact: Omit<T, "id" | "sourceOperationId" | "sourceRange">): void {
    if (this.facts.length >= MAX_FACTS) return;
    this.facts.push({ id: this.next(), sourceOperationId: this.sourceOperationId, sourceRange: this.sourceRange, ...fact } as T);
  }

  scalar(metric: string, value: number, group?: string, formatted?: string): void {
    this.push<ScalarFact>({
      kind: "scalar",
      metric,
      value,
      ...(group !== undefined ? { group } : {}),
      label: group !== undefined ? `${metric} — ${group}` : metric,
      formatted: formatted ?? formatNumber(value),
    });
  }

  share(group: string, ofWhat: string, fraction: number): void {
    this.push<ShareFact>({
      kind: "share",
      group,
      ofWhat,
      value: fraction,
      label: `${ofWhat} share — ${group}`,
      formatted: formatPercent(fraction),
    });
  }

  ratio(numerator: string, denominator: string, value: number): void {
    this.push<RatioFact>({
      kind: "ratio",
      numerator,
      denominator,
      value,
      label: `${numerator} ÷ ${denominator}`,
      formatted: formatRatio(value),
    });
  }

  ranking(metric: string, direction: "desc" | "asc", order: readonly string[], values: readonly number[]): void {
    this.push<RankingFact>({
      kind: "ranking",
      metric,
      direction,
      order: [...order],
      values: [...values],
      label: `Ranking by ${metric} (${direction === "desc" ? "high→low" : "low→high"})`,
      formatted: order.join(direction === "desc" ? " > " : " < "),
    });
  }

  extreme(which: "max" | "min", metric: string, group: string, value: number, formatted?: string): void {
    this.push<ExtremeFact>({
      kind: "extreme",
      which,
      metric,
      group,
      value,
      label: `${which === "max" ? "Largest" : "Smallest"} by ${metric}`,
      formatted: `${group} (${formatted ?? formatNumber(value)})`,
    });
  }

  pair(which: "closest" | "farthest", metric: string, groups: readonly [string, string], delta: number): void {
    this.push<PairFact>({
      kind: "pair",
      which,
      metric,
      groups: [groups[0], groups[1]],
      delta,
      label: `${which === "closest" ? "Closest" : "Farthest"} pair by ${metric}`,
      formatted: `${groups[0]} & ${groups[1]} (Δ ${formatNumber(delta)})`,
    });
  }

  comparison(subject: string, relation: ComparisonFact["relation"], object: string, subjectValue: number, objectValue: number): void {
    const symbol = relation === "greater_than" ? ">" : relation === "less_than" ? "<" : "=";
    this.push<ComparisonFact>({
      kind: "comparison",
      subject,
      relation,
      object,
      subjectValue,
      objectValue,
      label: `${subject} vs ${object}`,
      formatted: `${subject} (${formatNumber(subjectValue)}) ${symbol} ${object} (${formatNumber(objectValue)})`,
    });
  }

  build(): readonly VerifiedFact[] {
    return this.facts;
  }
}

interface GroupSlice {
  readonly group: string;
  readonly value: number;
  readonly bucketCount: number;
}

/** True when a metric's target column is percentage-formatted (name ends with %). */
function metricIsPercent(metric: GroupMetric | undefined, metricLabel: string): boolean {
  if (/%/.test(metricLabel)) return true;
  const columnName = (expr: Expression | undefined): string | null => {
    if (!expr) return null;
    if (expr.kind === "column") return expr.name;
    if (expr.kind === "abs" || expr.kind === "neg") return columnName(expr.value);
    return null;
  };
  return /%/.test(columnName(metric?.target as Expression | undefined) ?? "");
}

/** Keep model aliases only when they retain the exact workbook identifier. */
export function factMetricLabel(metricLabel: string, metric: GroupMetric | undefined): string {
  if (!metric || metric.metric === "count" || !metric.target) return metricLabel;
  const target = metric.target.kind === "abs" || metric.target.kind === "neg" ? metric.target.value : metric.target;
  if (target.kind !== "column" || metricLabel.toLowerCase().includes(target.name.toLowerCase())) return metricLabel;
  const modifier = metric.target.kind === "abs" ? " absolute" : "";
  return `${metric.metric}${modifier} ${target.name}`;
}

function factsForNumericMetric(
  builder: FactBuilder,
  metricLabel: string,
  metric: GroupMetric | undefined,
  slices: readonly GroupSlice[],
): void {
  const usable = slices.filter((slice) => Number.isFinite(slice.value));
  if (usable.length === 0) return;

  const percent = metric?.metric !== "count" && metricIsPercent(metric, metricLabel);
  const fmt = (value: number) => (percent ? formatPercent(value) : formatNumber(value));

  // per-group scalar
  for (const slice of usable) builder.scalar(metricLabel, slice.value, slice.group, fmt(slice.value));

  // subset percentage: a filtered count within its own bucket
  if (metric?.metric === "count" && metric.where !== undefined) {
    for (const slice of usable) {
      // the bucket's own row total is a deterministic quantity the engine already
      // has (group.count) — expose it so "total, count, percentage" has its total
      // even when the plan carries no separate unfiltered count metric.
      builder.scalar(`${metricLabel} group total`, slice.bucketCount, slice.group, formatCount(slice.bucketCount));
      if (slice.bucketCount > 0) builder.share(slice.group, `${metricLabel} within its group`, slice.value / slice.bucketCount);
    }
    const matched = usable.reduce((sum, slice) => sum + slice.value, 0);
    const rows = usable.reduce((sum, slice) => sum + slice.bucketCount, 0);
    builder.scalar(`${metricLabel} overall`, matched, "Overall", formatCount(matched));
    builder.scalar("row count overall", rows, "Overall", formatCount(rows));
    if (rows > 0) builder.share("Overall", `${metricLabel} within all rows`, matched / rows);
  }

  const sorted = [...usable].sort((a, b) => b.value - a.value);
  const order = sorted.map((slice) => slice.group);
  const values = sorted.map((slice) => slice.value);

  if (usable.length >= 2) {
    builder.ranking(metricLabel, "desc", order, values);
    const top = sorted[0] as GroupSlice;
    const bottom = sorted[sorted.length - 1] as GroupSlice;
    builder.extreme("max", metricLabel, top.group, top.value, fmt(top.value));
    builder.extreme("min", metricLabel, bottom.group, bottom.value, fmt(bottom.value));

    // closest / farthest pair by absolute metric difference
    let closest: [GroupSlice, GroupSlice, number] | null = null;
    let farthest: [GroupSlice, GroupSlice, number] | null = null;
    for (let i = 0; i < usable.length; i += 1) {
      for (let j = i + 1; j < usable.length; j += 1) {
        const a = usable[i] as GroupSlice;
        const b = usable[j] as GroupSlice;
        const delta = Math.abs(a.value - b.value);
        if (!closest || delta < closest[2]) closest = [a, b, delta];
        if (!farthest || delta > farthest[2]) farthest = [a, b, delta];
      }
    }
    if (closest) builder.pair("closest", metricLabel, [closest[0].group, closest[1].group], closest[2]);
    if (farthest) builder.pair("farthest", metricLabel, [farthest[0].group, farthest[1].group], farthest[2]);
  }

  if (isExtensive(metric)) {
    const total = values.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total) > EQUAL_TOLERANCE) {
      for (const slice of sorted) builder.share(slice.group, metricLabel, slice.value / total);
    }
    if (usable.length >= 2) {
      const top = sorted[0] as GroupSlice;
      const second = sorted[1] as GroupSlice;
      const bottom = sorted[sorted.length - 1] as GroupSlice;
      if (Math.abs(bottom.value) > EQUAL_TOLERANCE) builder.ratio(`${metricLabel} (${top.group})`, `${metricLabel} (${bottom.group})`, top.value / bottom.value);
      if (second.group !== bottom.group && Math.abs(second.value) > EQUAL_TOLERANCE) {
        builder.ratio(`${metricLabel} (${top.group})`, `${metricLabel} (${second.group})`, top.value / second.value);
      }
      // §15 — leading group vs every other group combined
      const restSum = values.slice(1).reduce((sum, value) => sum + value, 0);
      const relation = top.value > restSum + EQUAL_TOLERANCE ? "greater_than" : top.value < restSum - EQUAL_TOLERANCE ? "less_than" : "equal";
      builder.comparison(top.group, relation, `all other ${metricLabel ? "groups" : "groups"} combined`, top.value, restSum);
    }
  }
}

function deriveForResult(result: AnalysisResult, request: AnalysisRequest | undefined, opId: string): readonly VerifiedFact[] {
  const builder = new FactBuilder(opId, result.source.address);

  switch (result.op) {
    case "count":
      if (typeof result.value === "number") builder.scalar("row count", result.value, undefined, formatCount(result.value));
      break;

    case "filter":
    case "sort":
      if (typeof result.rowsMatched === "number") builder.scalar("rows matched", result.rowsMatched, undefined, formatCount(result.rowsMatched));
      break;

    case "distinct":
      if (typeof result.parameters?.["distinctCount"] === "number") {
        builder.scalar("distinct values", result.parameters["distinctCount"] as number, undefined, formatCount(result.parameters["distinctCount"] as number));
      }
      break;

    case "aggregate":
      if (typeof result.value === "number") {
        const metric = String(result.parameters?.["metric"] ?? "value");
        builder.scalar(metric, result.value);
      }
      break;

    case "correlation":
      if (typeof result.value === "number") builder.scalar("Pearson r", result.value, undefined, formatCorrelation(result.value));
      break;

    case "outliers":
      if (typeof result.parameters?.["outlierCount"] === "number") {
        builder.scalar("outlier count", result.parameters["outlierCount"] as number, undefined, formatCount(result.parameters["outlierCount"] as number));
      }
      break;

    case "top_n":
    case "bottom_n": {
      const values = (result.parameters?.["values"] as number[] | undefined) ?? [];
      const labels = (result.rows ?? []).map((row, index) => String(row[0] ?? `row ${index + 1}`));
      values.forEach((value, index) => builder.scalar(`ranked value #${index + 1}`, value, labels[index]));
      if (values.length >= 2) {
        builder.ranking(`|${(result.parameters?.["by"] as string[] | undefined)?.join(", ") ?? "value"}|`, result.op === "top_n" ? "desc" : "asc", labels.slice(0, values.length), values);
      }
      break;
    }

    case "summary_statistics": {
      for (const [column, stats] of Object.entries(result.statistics ?? {})) {
        for (const key of ["min", "max", "mean", "median", "stddev", "count"] as const) {
          const value = stats[key];
          if (typeof value === "number" && Number.isFinite(value)) builder.scalar(`${key} ${column}`, value, undefined, key === "count" ? formatCount(value) : formatNumber(value));
        }
      }
      break;
    }

    case "group_correlation": {
      const dims = (result.parameters?.["dimensions"] as string[] | undefined)?.join(" × ") ?? "group";
      const slices: GroupSlice[] = [];
      for (const group of result.groups ?? []) {
        const key = Object.values(group.key)[0] ?? "";
        const r = group.metrics["r"];
        if (typeof r === "number" && Number.isFinite(r)) {
          builder.scalar(`Pearson r (${dims})`, r, key, formatCorrelation(r));
          slices.push({ group: key, value: Math.abs(r), bucketCount: group.count });
        }
      }
      if (slices.length >= 2) {
        const sorted = [...slices].sort((a, b) => b.value - a.value);
        builder.ranking("|Pearson r|", "desc", sorted.map((s) => s.group), sorted.map((s) => s.value));
        builder.extreme("max", "|Pearson r|", (sorted[0] as GroupSlice).group, (sorted[0] as GroupSlice).value, formatCorrelation((sorted[0] as GroupSlice).value));
      }
      break;
    }

    case "group_by": {
      const metrics = request?.op === "group_by" ? request.metrics : [];
      const metricLabels = new Map<string, GroupMetric>();
      metrics.forEach((metric, position) => metricLabels.set(metricKey(metric, position), metric));

      const groups = result.groups ?? [];
      const keys = groups.length > 0 ? Object.keys((groups[0] as { metrics: Record<string, unknown> }).metrics) : [];
      for (const metricLabel of keys) {
        const metric = metricLabels.get(metricLabel);
        const slices: GroupSlice[] = groups.map((group) => ({
          group: Object.values(group.key)[0] ?? "",
          value: Number(group.metrics[metricLabel] ?? Number.NaN),
          bucketCount: group.count,
        }));
        factsForNumericMetric(builder, factMetricLabel(metricLabel, metric), metric, slices);
      }
      break;
    }
  }

  return builder.build();
}

/**
 * Produces the deterministic fact set for a whole analysis batch. Facts are
 * numbered F1..Fn across the batch and each carries its source operation + range.
 */
export function deriveVerifiedFacts(
  outcomes: readonly AnalysisOutcome[],
  requests: readonly unknown[],
): readonly VerifiedFact[] {
  const all: VerifiedFact[] = [];
  outcomes.forEach((outcome, index) => {
    if (isAnalysisError(outcome)) return;
    const request = requests[index] as AnalysisRequest | undefined;
    for (const fact of deriveForResult(outcome, request, `op#${index + 1}`)) {
      if (all.length >= MAX_FACTS) break;
      all.push({ ...fact, id: `F${all.length + 1}` });
    }
  });
  return all;
}

/** The model-facing VERIFIED FACTS block. */
export function renderVerifiedFacts(facts: readonly VerifiedFact[]): string {
  if (facts.length === 0) return "";
  const lines = facts.map((fact) => `[${fact.id}] ${fact.label} = ${fact.formatted}  (${fact.sourceOperationId}, ${fact.sourceRange})`);
  return [
    "VERIFIED FACTS — the ONLY permitted source for any number, percentage, ratio, ranking, superlative or comparison in your answer.",
    "You may NOT add, subtract, multiply, divide or otherwise combine values — not even two facts. If a figure is not listed here, do not state it.",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic validation of final prose against the fact set.
// ---------------------------------------------------------------------------

const THOUSANDS_SEP = /(\d)[\u0020\u00a0\u202f'’](?=\d{3}(?:\D|$))/g;
const NUMBER_TOKEN = /-?\d[\d.,]*\d|-?\d/g;
const SEPARATORS = /['’]/g;

function normalizeNumberToken(token: string): string {
  let s = token.replace(SEPARATORS, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    const parts = s.split(",");
    s = parts.length === 2 && (parts[1] ?? "").length !== 3 ? `${parts[0]}.${parts[1]}` : parts.join("");
  }
  return s;
}

function proseNumbers(text: string): number[] {
  // Collapse a thousands separator (space / NBSP / NNBSP / apostrophe between a digit
  // and exactly three digits) so "9 058 444" is ONE number and a list
  // "9 058 444, 77 019 219, 29 594 633" tokenises as three numbers, not one 22-digit
  // garbage value (Stage 21.2.7 §4 — validator accuracy, no weakening).
  let collapsed = text;
  for (let i = 0; i < 6; i += 1) {
    THOUSANDS_SEP.lastIndex = 0;
    if (!THOUSANDS_SEP.test(collapsed)) break;
    THOUSANDS_SEP.lastIndex = 0;
    collapsed = collapsed.replace(THOUSANDS_SEP, "$1");
  }
  return (collapsed.match(NUMBER_TOKEN) ?? []).map((raw) => Number(normalizeNumberToken(raw))).filter((value) => Number.isFinite(value));
}

/** A fraction shown as a percentage is quotable either way; likewise a raw fraction as "N%". */
function withPercentScaling(value: number): number[] {
  return Math.abs(value) < 1 && value !== 0 ? [value, value * 100] : [value];
}

/** Every numeric value that a fact legitimises (raw value + fraction↔percent scaling). */
function acceptableNumbers(facts: readonly VerifiedFact[]): number[] {
  const out: number[] = [];
  for (const fact of facts) {
    switch (fact.kind) {
      case "scalar":
        out.push(...withPercentScaling(fact.value));
        break;
      case "ratio":
        out.push(fact.value);
        break;
      case "share":
        out.push(fact.value, fact.value * 100);
        break;
      case "extreme":
        out.push(...withPercentScaling(fact.value));
        break;
      case "pair":
        out.push(...withPercentScaling(fact.delta));
        break;
      case "comparison":
        out.push(...withPercentScaling(fact.subjectValue), ...withPercentScaling(fact.objectValue));
        break;
      case "ranking":
        for (const value of fact.values) out.push(...withPercentScaling(value));
        break;
    }
  }
  return out;
}

function approx(a: number, b: number): boolean {
  const tol = Math.max(0.05, Math.abs(b) * 0.01);
  return Math.abs(a - b) <= tol;
}

const HIGH_SUPERLATIVE = /(highest|largest|biggest|greatest|\btop\b|\bmost\b|maximum|наибольш[а-яё]*|наивысш[а-яё]*|сам[а-яё]*\s+больш[а-яё]*|максимальн[а-яё]*|доминиру[а-яё]*)/i;
const LOW_SUPERLATIVE = /(lowest|smallest|least|minimum|наименьш[а-яё]*|сам[а-яё]*\s+маленьк[а-яё]*|сам[а-яё]*\s+низк[а-яё]*|минимальн[а-яё]*)/i;
const CLOSEST = /(closest|nearest|smallest\s+(?:gap|difference)|минимальн\w*\s+разниц|ближе\s+всего|наименьш\w*\s+разниц|почти\s+одинаков)/i;
const FARTHEST = /(farthest|furthest|largest\s+(?:gap|difference)|наибольш\w*\s+разниц|максимальн\w*\s+разниц|дальше\s+всего)/i;
const COMBINED = /(вместе\s+взят[а-яё]*|взятые\s+вместе|combined|together|обе\s+вместе|остальны\w*\s+вместе|other\s+\w+\s+combined|rest\s+combined)/i;
const TIMES = /(\d[\d.,]*)\s*(?:x|×|раза?|times)\b/i;
const METRIC_WORD = /(plan|fact|revenue|variance|unit\s*price|units|deviation|отклонен|выручк|план|факт|количеств|records?|\bcount\b|correlation|корреляц|pearson|\br\b|доля|share|среднее|среднего|средн\w*)/i;

/**
 * Strict fact-grounded validation. Returns the list of failure reasons — empty
 * means every numeric / comparative claim in `text` is backed by a VerifiedFact.
 */
export function validateClaimsAgainstFacts(
  text: string,
  facts: readonly VerifiedFact[],
  structural: ReadonlySet<number>,
): readonly string[] {
  const reasons: string[] = [];
  const lower = text.toLowerCase();
  const accepted = acceptableNumbers(facts);

  // 1) every number must be a fact value (or structural: row counts, years, small ordinals)
  const ungrounded = [...new Set(proseNumbers(text))].filter((value) => {
    if (structural.has(value)) return false;
    if (Number.isInteger(value) && Math.abs(value) >= 1900 && Math.abs(value) <= 2099) return false;
    return !accepted.some((factValue) => approx(value, factValue));
  });
  if (ungrounded.length > 0) {
    reasons.push(
      `These figures are not VERIFIED FACTS: ${ungrounded.slice(0, 8).join(", ")}. Quote a fact's value verbatim or remove the figure — you may not compute shares, differences, ratios or percentages yourself.`,
    );
  }

  // 2) "X and Y combined" comparisons need a comparison fact — for the right group,
  //    in the right direction.
  if (COMBINED.test(text)) {
    const comparisons = facts.filter((fact): fact is ComparisonFact => fact.kind === "comparison");
    if (comparisons.length === 0) {
      reasons.push("A 'combined' / 'вместе взятые' comparison needs an engine comparison fact; none was produced. State each value separately.");
    } else {
      const claimsGreater = /(больше|более|greater|more\b|выше|exceeds|превыша|dominat)/i.test(text);
      const claimsLess = /(меньше|менее|\bless\b|lower|ниже|not\s+as\s+much)/i.test(text);
      // does the answer's combined claim line up with ANY comparison fact?
      const supported = comparisons.some((fact) => {
        const subjectNamed = lower.includes(fact.subject.toLowerCase());
        if (!subjectNamed) return false;
        if (claimsGreater) return fact.relation === "greater_than";
        if (claimsLess) return fact.relation === "less_than";
        return fact.relation === "equal";
      });
      if (!supported) {
        const known = comparisons.map((fact) => `${fact.id}: ${fact.formatted}`).join("; ");
        reasons.push(`The 'combined' comparison in the answer is not backed by an engine comparison fact (${known}). Restate it to match a fact or drop it.`);
      }
    }
  }

  // 3) superlatives must name the correct end of a ranking / extreme fact
  if (HIGH_SUPERLATIVE.test(text) || LOW_SUPERLATIVE.test(text)) {
    const extremes = facts.filter((fact): fact is ExtremeFact => fact.kind === "extreme");
    const rankings = facts.filter((fact): fact is RankingFact => fact.kind === "ranking");
    if (extremes.length > 0 || rankings.length > 0) {
      const topEnd = new Set<string>([
        ...extremes.filter((fact) => fact.which === "max").map((fact) => fact.group.toLowerCase()),
        ...rankings.map((fact) => (fact.direction === "desc" ? fact.order[0] : fact.order[fact.order.length - 1]) ?? ""),
      ].map((group) => group.toLowerCase()));
      const bottomEnd = new Set<string>([
        ...extremes.filter((fact) => fact.which === "min").map((fact) => fact.group.toLowerCase()),
        ...rankings.map((fact) => (fact.direction === "desc" ? fact.order[fact.order.length - 1] : fact.order[0]) ?? ""),
      ].map((group) => group.toLowerCase()));
      const allNamed = new Set<string>([
        ...topEnd,
        ...bottomEnd,
        ...rankings.flatMap((fact) => fact.order.map((group) => group.toLowerCase())),
        ...extremes.map((fact) => fact.group.toLowerCase()),
      ]);
      for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
        const high = HIGH_SUPERLATIVE.test(sentence);
        const low = LOW_SUPERLATIVE.test(sentence);
        if (!high && !low) continue;
        const s = sentence.toLowerCase();
        for (const group of allNamed) {
          if (group.length === 0 || !s.includes(group)) continue;
          if (high && !topEnd.has(group)) {
            reasons.push(`"${group}" is not the top of any VERIFIED ranking/extreme fact — do not call it the highest/largest.`);
            break;
          }
          if (low && !bottomEnd.has(group)) {
            reasons.push(`"${group}" is not the bottom of any VERIFIED ranking/extreme fact — do not call it the lowest/smallest.`);
            break;
          }
        }
      }
    } else if (facts.length > 0) {
      // §9 (21.2.3) — a superlative about a DETERMINISTIC workbook metric with NO
      // ranking/extreme fact at all. Reject when the sentence also names a group
      // that appears in the fact set and cites a metric or a number (i.e. it is
      // asserting a workbook ranking, not a purely qualitative remark).
      const knownGroups = new Set<string>();
      for (const fact of facts) {
        if ((fact.kind === "scalar" || fact.kind === "share") && "group" in fact && fact.group) knownGroups.add(fact.group.toLowerCase());
        if (fact.kind === "comparison") knownGroups.add(fact.subject.toLowerCase());
      }
      for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
        if (!HIGH_SUPERLATIVE.test(sentence) && !LOW_SUPERLATIVE.test(sentence)) continue;
        const s = sentence.toLowerCase();
        const namesGroup = [...knownGroups].some((group) => group.length > 0 && s.includes(group));
        const assertsMetric = METRIC_WORD.test(sentence) || /\d/.test(sentence);
        if (namesGroup && assertsMetric) {
          reasons.push(
            "A highest/lowest claim about a workbook metric needs a VERIFIED ranking or extreme fact; none was produced. Either request a ranking or state it only as unverified interpretation without naming a specific group as the extreme.",
          );
          break;
        }
      }
    }
  }

  // 4) closest / farthest claims must match a pair fact
  // every group name mentioned anywhere in the fact set — used to spot a wrongly-named pair
  const allGroupNames = new Set<string>();
  for (const fact of facts) {
    if (fact.kind === "ranking") for (const group of fact.order) allGroupNames.add(group.toLowerCase());
    if (fact.kind === "extreme") allGroupNames.add(fact.group.toLowerCase());
    if (fact.kind === "pair") for (const group of fact.groups) allGroupNames.add(group.toLowerCase());
    if (fact.kind === "comparison") allGroupNames.add(fact.subject.toLowerCase());
    if ((fact.kind === "scalar" || fact.kind === "share") && "group" in fact && fact.group) allGroupNames.add(fact.group.toLowerCase());
  }

  const pairCheck = (re: RegExp, which: "closest" | "farthest") => {
    if (!re.test(text)) return;
    const pairs = facts.filter((fact): fact is PairFact => fact.kind === "pair" && fact.which === which);
    if (pairs.length === 0) {
      reasons.push(`A '${which}' pair claim needs an engine ${which}-pair fact; none was produced.`);
      return;
    }
    const sentences = text.split(/(?<=[.!?…])\s+/).filter((sentence) => re.test(sentence));
    for (const sentence of sentences) {
      const s = sentence.toLowerCase();
      const groupsInSentence = [...allGroupNames].filter((group) => group.length > 0 && s.includes(group));
      if (groupsInSentence.length >= 2) {
        const ok = pairs.some((fact) => fact.groups.every((group) => s.includes(group.toLowerCase())));
        if (!ok) reasons.push(`The '${which}' pair named in the answer does not match the VERIFIED ${which}-pair fact.`);
      }
    }
  };
  pairCheck(CLOSEST, "closest");
  pairCheck(FARTHEST, "farthest");

  // 5) "X times / ×" needs a ratio fact with that value
  const timesMatch = text.match(TIMES);
  if (timesMatch) {
    const claimed = Number(normalizeNumberToken(timesMatch[1] ?? ""));
    const ratios = facts.filter((fact): fact is RatioFact => fact.kind === "ratio");
    if (!ratios.some((fact) => approx(claimed, fact.value))) {
      reasons.push(`"${timesMatch[0].trim()}" is not a VERIFIED ratio fact. Only state a multiple the engine produced.`);
    }
  }

  return reasons;
}
