// ---------------------------------------------------------------------------
// Goal-relevant VerifiedFact projection (Stage 21.2.7).
//
// The deterministic engine internally derives MANY facts per metric (per-group
// scalars, rankings, extremes, closest/farthest pairs, ratios, shares, "vs all
// other combined"). The user-visible answer / fallback must show only the facts
// attributable to a REQUESTED goal, a dependency it needs, or a requested chart —
// never the full VerifiedFacts collection.
//
// This is a pure projection: it never re-reads the workbook, never calls the
// engine, and NEVER weakens the numeric claim validator (which still runs against
// the complete fact set). It also never renders a goal `description` — every
// label is derived from the typed request.
// ---------------------------------------------------------------------------

import type { AnalysisGoal, CompoundGoalOutcome, RequirementSet } from "./compound.js";
import {
  factMetricLabel,
  type ExtremeFact,
  type PairFact,
  type RankingFact,
  type ScalarFact,
  type ShareFact,
  type VerifiedFact,
} from "./facts.js";
import type { Expression, GroupMetric } from "./types.js";
import type { ChartData } from "../visualization/types.js";
import { CHART_VALUE_OP_ID } from "../visualization/facts.js";

type Lang = "ru" | "en";

/** One requested metric, pivoted per group (or a single row for a whole-selection metric). */
export interface ProjectedMetric {
  readonly key: string; // stable identity (fact metric label, lower-cased)
  readonly label: string; // localized; workbook identifiers verbatim
  readonly by: string | null;
  readonly rows: readonly { readonly group: string; readonly formatted: string }[];
}

export interface ProjectedConclusion {
  readonly label: string; // "Наибольшее среднее абсолютное Variance % по Category"
  readonly answer: string; // "Electronics (17.17%)"
}

export interface ProjectedFailure {
  readonly label: string;
  readonly detail: string; // localized user gloss, no raw codes
}

export interface FactProjection {
  readonly metrics: readonly ProjectedMetric[];
  readonly conclusions: readonly ProjectedConclusion[];
  readonly chartBuilt: boolean;
  readonly chartFailed: boolean;
  readonly interpretationRequested: boolean;
  readonly done: readonly string[]; // ✓ labels
  readonly failures: readonly ProjectedFailure[]; // ⚠ labels
  /**
   * The VerifiedFact subset that is actually relevant to the request — the
   * per-group / whole-selection scalars of requested metrics plus the extreme /
   * ranking / comparison fact that answers a requested ranking / comparison goal.
   * The final-answer validator uses THIS on a compound turn, so a claim that only
   * matches an auto-derived pair-delta / ratio / share the user never asked about
   * is (correctly) rejected — a tightening, never a weakening.
   */
  readonly facts: readonly VerifiedFact[];
}

const ANALYTICAL = new Set<AnalysisGoal["type"]>(["metric", "group_metric", "filter_count", "correlation"]);

const AGG_WORD: Record<Lang, Record<string, string>> = {
  ru: { mean: "среднее", sum: "сумма", median: "медиана", min: "минимум", max: "максимум", count: "количество записей" },
  en: { mean: "mean", sum: "sum", median: "median", min: "min", max: "max", count: "record count" },
};

function cap(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function columnOf(expr: Expression | undefined): { name: string; absolute: boolean } | null {
  if (!expr) return null;
  if (expr.kind === "column") return { name: expr.name, absolute: false };
  if (expr.kind === "abs") {
    const inner = columnOf(expr.value);
    return inner ? { name: inner.name, absolute: true } : null;
  }
  if (expr.kind === "neg") return columnOf(expr.value);
  return null;
}

function exprName(expr: Expression | undefined): string {
  const c = columnOf(expr);
  return c ? (c.absolute ? `|${c.name}|` : c.name) : "";
}

function singleMetric(goal: AnalysisGoal): GroupMetric | undefined {
  if (goal.request?.op === "group_by" && goal.request.metrics.length === 1) return goal.request.metrics[0];
  if (goal.request?.op === "aggregate") return { metric: goal.request.metric, target: goal.request.target };
  return undefined;
}

function groupingOf(goal: AnalysisGoal | undefined): string | null {
  return goal?.request?.op === "group_by" ? goal.request.by[0] ?? null : null;
}

interface FilterCondition {
  readonly column: string;
  readonly op: string;
  readonly absolute: boolean;
  readonly rhs: { readonly kind: "number"; readonly value: number } | { readonly kind: "percent"; readonly value: number } | { readonly kind: "column"; readonly name: string };
}

/** Pull the row-filter predicate from a compiled filter_count goal's request. */
function filterConditionOf(goal: AnalysisGoal): FilterCondition | null {
  const request = goal.request;
  let where: unknown;
  if (request?.op === "count") where = request.where;
  else if (request?.op === "group_by") where = request.metrics.find((m) => m.metric === "count" && m.where)?.where;
  // canonicalization wraps a bare condition as { all: [condition] } / { any: [...] }
  while (where && typeof where === "object" && !("left" in (where as Record<string, unknown>))) {
    const g = where as Record<string, unknown>;
    const list = (Array.isArray(g["all"]) ? g["all"] : Array.isArray(g["any"]) ? g["any"] : null) as unknown[] | null;
    if (!list || list.length === 0) break;
    where = list[0];
  }
  if (!where || typeof where !== "object") return null;
  const w = where as Record<string, unknown>;
  const left = w["left"];
  let column: string | null = null;
  let absolute = false;
  if (left && typeof left === "object") {
    const l = left as Record<string, unknown>;
    if (l["kind"] === "abs" && l["value"] && typeof l["value"] === "object") {
      absolute = true;
      const inner = l["value"] as Record<string, unknown>;
      if (inner["kind"] === "column" && typeof inner["name"] === "string") column = inner["name"] as string;
    } else if (l["kind"] === "column" && typeof l["name"] === "string") column = l["name"] as string;
    else if (typeof l["column"] === "string") column = l["column"] as string;
  }
  if (!column) return null;
  const op = typeof w["operator"] === "string" ? (w["operator"] as string) : "=";
  const value = w["value"];
  let rhs: FilterCondition["rhs"] = { kind: "number", value: Number(value) };
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v["kind"] === "percent" && typeof v["value"] === "number") rhs = { kind: "percent", value: v["value"] as number };
    else if (typeof v["column"] === "string") rhs = { kind: "column", name: v["column"] as string };
  }
  return { column, op, absolute, rhs };
}

/** "|Variance %| > 20%" / "Fact < Plan" — workbook identifiers verbatim. */
function conditionText(cond: FilterCondition): string {
  const lhs = cond.absolute ? `|${cond.column}|` : cond.column;
  const rhs =
    cond.rhs.kind === "percent" ? `${cond.rhs.value}%` : cond.rhs.kind === "column" ? cond.rhs.name : String(cond.rhs.value);
  return `${lhs} ${cond.op} ${rhs}`;
}

/** "среднее |Variance %|" — the metric body only, no grouping suffix. */
function metricBody(metric: GroupMetric, language: Lang): string {
  if (metric.metric === "count") return AGG_WORD[language]["count"] as string;
  const col = columnOf(metric.target as Expression | undefined);
  const agg = AGG_WORD[language][metric.metric] ?? metric.metric;
  const body = col ? (col.absolute ? `абсолютное ${col.name}` : col.name) : (metric.name ?? metric.metric);
  return language === "ru"
    ? `${agg} ${body}`
    : `${agg} ${col ? (col.absolute ? `absolute ${col.name}` : col.name) : body}`;
}

function withBy(text: string, by: string | null, language: Lang): string {
  return by ? `${text}${language === "ru" ? " по " : " by "}${by}` : text;
}

/** RU superlative that agrees in gender with the metric noun ("Наибольшая сумма", "Наибольшее среднее"). */
function rankHeadRu(direction: "max" | "min", body: string): string {
  const first = body.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (/^(сумма|медиана|доля|выручка|корреляц)/.test(first)) return direction === "max" ? "Наибольшая" : "Наименьшая";
  if (/^(минимум|максимум|показатель)/.test(first)) return direction === "max" ? "Наибольший" : "Наименьший";
  return direction === "max" ? "Наибольшее" : "Наименьшее";
}

function failureDetail(reason: string | undefined, language: Lang): string {
  const missing = reason ? /^COLUMN_NOT_AVAILABLE:\s*(.+)$/.exec(reason) : null;
  if (missing) {
    const col = missing[1]?.trim() ?? "";
    return language === "ru" ? `столбец ${col} отсутствует в выбранном диапазоне` : `column ${col} is not in the selected range`;
  }
  if (reason && /^VISUALIZATION_UNSUPPORTED:/.test(reason)) {
    return language === "ru" ? "график не удалось построить" : "the chart could not be produced";
  }
  return language === "ru" ? "не удалось рассчитать" : "could not be calculated";
}

/**
 * Projects executed compound goals + their VerifiedFacts onto only what the user
 * asked for. The deterministic-floor `count` goal is dropped unless the request
 * actually asked for a row count.
 */
/** Localise a chart-value metric identity ("mean Plan" → "Среднее Plan" / "Mean Plan"). */
function localizeChartMetric(metric: string, language: Lang): string {
  const parts = metric.split(" ");
  const head = parts[0] ?? "";
  const agg = AGG_WORD[language][head];
  if (!agg) return metric; // unknown shape — keep as a verbatim identifier
  const cols = parts.slice(1).join(" ");
  return cols ? `${agg} ${cols}` : agg;
}

export function projectCompoundFacts(
  goals: readonly AnalysisGoal[],
  outcomes: readonly CompoundGoalOutcome[],
  facts: readonly VerifiedFact[],
  requirements: RequirementSet,
  language: Lang,
  prompt = "",
  chart: ChartData | null = null,
): FactProjection {
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const scalars = facts.filter((f): f is ScalarFact => f.kind === "scalar");
  const shareFacts = facts.filter((f): f is ShareFact => f.kind === "share");
  const metricBodyByGoalId = new Map<string, string>();
  const ru = language === "ru";

  const metrics: ProjectedMetric[] = [];
  const conclusions: ProjectedConclusion[] = [];
  const done: string[] = [];
  const failures: ProjectedFailure[] = [];
  const keptFactIds = new Set<string>();
  let chartBuilt = false;
  let chartFailed = false;

  // grouping columns that carry an executed grouped filter_count goal — the base
  // "count by <dim>" goal's per-group values are folded into that goal's table as
  // the "Total" column, so it must not also render on its own (Stage 21.2.8 §1/§2).
  const filterCountGroupings = new Set<string>();
  for (const g of goals) {
    if (g.type !== "filter_count") continue;
    const by = groupingOf(g);
    if (by && byId.get(g.id)?.status === "executed") filterCountGroupings.add(by);
  }
  // show the per-group total (the share's denominator) whenever the user asked for a
  // count or a share; otherwise only the conditional count is relevant.
  const wantsTotal = requirements.countRequirement || requirements.groupShare;
  // the grand-total line ("45 of 120 — 37.50%") is only added when the request
  // asks for it explicitly — a per-category share question does not (§1/§2).
  const wantsOverall = /(overall|в\s+целом|в\s+общем|\bитого\b|общий\s+итог|общего?\s+итог|всего\s+по\s+вы?борке|across\s+all|grand\s+total|в\s+сумме\s+по\s+всем|по\s+всей\s+вы?борке)/i.test(prompt);

  for (const goal of goals) {
    const outcome = byId.get(goal.id);
    if (!outcome) continue;

    // ---- filtered row count per group: total / conditional count / share (§1/§2) ----
    if (goal.type === "filter_count") {
      const by = groupingOf(goal);
      const cond = filterConditionOf(goal);
      const condText = cond ? conditionText(cond) : (ru ? "условие" : "condition");
      const countLabel = ru ? `Строк, где ${condText}` : `Rows where ${condText}`;
      const label = cap(withBy(countLabel, by, language));
      metricBodyByGoalId.set(goal.id, ru ? `число строк, где ${condText}` : `count where ${condText}`);
      if (outcome.status !== "executed") {
        failures.push({ label, detail: failureDetail(outcome.failureReason, language) });
        continue;
      }
      const opId = outcome.sourceOperationId;
      const name = (singleMetric(goal)?.name ?? "matched").toLowerCase();

      if (by === null) {
        const scalar = scalars.find((f) => f.sourceOperationId === opId && (f.metric ?? "").toLowerCase() === "row count" && f.group === undefined);
        if (scalar) {
          keptFactIds.add(scalar.id);
          metrics.push({ key: `fc:${goal.id}`, label, by: null, rows: [{ group: "", formatted: scalar.formatted }] });
        }
        done.push(label);
        continue;
      }

      const condRows = scalars
        .filter((f) => f.sourceOperationId === opId && (f.metric ?? "").toLowerCase() === name && f.group !== undefined)
        .map((f) => { keptFactIds.add(f.id); return { group: f.group ?? "", formatted: f.formatted }; });
      const shareRows = shareFacts
        .filter((f) => f.sourceOperationId === opId && f.ofWhat.toLowerCase() === `${name} within its group`)
        .map((f) => { keptFactIds.add(f.id); return { group: f.group, formatted: f.formatted }; });
      // prefer a sibling unfiltered "count by <dim>" metric; else the engine's
      // per-bucket "<name> group total" scalar (always present for a filtered count).
      const totalScalars = wantsTotal
        ? (() => {
            const base = scalars.filter((f) => f.sourceOperationId === opId && (f.metric ?? "").toLowerCase() === "count" && f.group !== undefined);
            if (base.length > 0) return base;
            return scalars.filter((f) => f.sourceOperationId === opId && (f.metric ?? "").toLowerCase() === `${name} group total` && f.group !== undefined);
          })()
        : [];
      const totalRows = totalScalars.map((f) => { keptFactIds.add(f.id); return { group: f.group ?? "", formatted: f.formatted }; });

      if (totalRows.length > 0) metrics.push({ key: `fc-total:${goal.id}`, label: ru ? "Всего" : "Total", by, rows: totalRows });
      if (condRows.length > 0) metrics.push({ key: `fc-count:${goal.id}`, label: countLabel, by, rows: condRows });
      if (shareRows.length > 0) metrics.push({ key: `fc-share:${goal.id}`, label: ru ? "Доля" : "Share", by, rows: shareRows });

      const overallMatched = scalars.find((f) => f.sourceOperationId === opId && (f.metric ?? "").toLowerCase() === `${name} overall`);
      const overallRows = scalars.find((f) => f.sourceOperationId === opId && (f.metric ?? "").toLowerCase() === "row count overall");
      const overallShare = shareFacts.find((f) => f.sourceOperationId === opId && f.ofWhat.toLowerCase() === `${name} within all rows`);
      if (wantsOverall && overallMatched && overallRows && overallShare) {
        keptFactIds.add(overallMatched.id);
        keptFactIds.add(overallRows.id);
        keptFactIds.add(overallShare.id);
        conclusions.push({
          label: ru ? `Всего строк, где ${condText}` : `Total rows where ${condText}`,
          answer: `${overallMatched.formatted} ${ru ? "из" : "of"} ${overallRows.formatted} (${overallShare.formatted})`,
        });
      }
      done.push(label);
      continue;
    }

    // ---- correlation goal: per-group (or whole-selection) Pearson r ----
    if (goal.type === "correlation") {
      const req = goal.request;
      const xy =
        req?.op === "correlation" || req?.op === "group_correlation"
          ? [exprName(req.x), exprName(req.y)].filter(Boolean).join(" ↔ ")
          : "";
      const grouped = req?.op === "group_correlation";
      const by = grouped ? (req.by[0] ?? null) : null;
      const label = cap(withBy(ru ? `Корреляция Пирсона${xy ? ` ${xy}` : ""}` : `Pearson r${xy ? ` ${xy}` : ""}`, by, language));
      metricBodyByGoalId.set(goal.id, ru ? "корреляция Пирсона" : "Pearson r");
      if (outcome.status !== "executed") {
        failures.push({ label, detail: failureDetail(outcome.failureReason, language) });
        continue;
      }
      const rRows = scalars
        .filter((f) => f.sourceOperationId === outcome.sourceOperationId && /pearson\s*r/i.test(f.metric ?? ""))
        .filter((f) => (by === null ? f.group === undefined : f.group !== undefined))
        .map((f) => { keptFactIds.add(f.id); return { group: f.group ?? "", formatted: f.formatted }; });
      if (rRows.length > 0) metrics.push({ key: `corr:${goal.id}`, label, by, rows: rRows });
      done.push(label);
      continue;
    }

    if (ANALYTICAL.has(goal.type)) {
      const metric = singleMetric(goal);
      if (!metric) continue;
      const by = groupingOf(goal);
      const body = metricBody(metric, language);
      metricBodyByGoalId.set(goal.id, body);
      const label = cap(withBy(body, by, language));

      // deterministic-floor count goal the user never asked for → hide it
      if (metric.metric === "count" && !requirements.countRequirement && outcome.status === "executed") continue;
      // base "count by <dim>" whose totals are shown inside a filtered-count table
      if (metric.metric === "count" && by !== null && filterCountGroupings.has(by) && outcome.status === "executed") continue;

      if (outcome.status !== "executed") {
        failures.push({ label, detail: failureDetail(outcome.failureReason, language) });
        continue;
      }
      const raw = metric.name ?? metric.metric;
      const key = factMetricLabel(raw, metric).toLowerCase();
      const wanted = new Set<string>([key, raw.toLowerCase(), metric.metric.toLowerCase()]);
      const matched = scalars
        .filter((f) => f.sourceOperationId === outcome.sourceOperationId)
        .filter((f) => wanted.has((f.metric ?? "").toLowerCase()))
        .filter((f) => (by === null ? f.group === undefined : f.group !== undefined));
      for (const f of matched) keptFactIds.add(f.id);
      const rows = matched.map((f) => ({ group: f.group ?? "", formatted: f.formatted }));
      if (rows.length > 0) metrics.push({ key, label, by, rows });

      // "count / sum by group AND its share of the total" — the per-group
      // share-of-total is an engine ShareFact; surface it as its own column (§5).
      if (requirements.groupShare && by !== null && (metric.metric === "count" || metric.metric === "sum")) {
        const shareRows = shareFacts
          .filter((f) => f.sourceOperationId === outcome.sourceOperationId && f.ofWhat.toLowerCase() === key)
          .map((f) => { keptFactIds.add(f.id); return { group: f.group, formatted: f.formatted }; });
        if (shareRows.length > 0) metrics.push({ key: `share:${goal.id}`, label: ru ? "Доля" : "Share", by, rows: shareRows });
      }
      done.push(label);
      continue;
    }

    if (goal.type === "ranking") {
      const depId = goal.dependsOn[0];
      const body = (depId && metricBodyByGoalId.get(depId)) || (language === "ru" ? "показатель" : "metric");
      const depBy = groupingOf(depId ? goalById.get(depId) : undefined);
      const direction = goal.select ?? "max";
      const head = language === "ru" ? rankHeadRu(direction, body) : direction === "max" ? "Largest" : "Smallest";
      const label = cap(withBy(`${head} ${body}`, depBy, language));
      if (outcome.status !== "executed") {
        failures.push({ label, detail: failureDetail(outcome.failureReason, language) });
        continue;
      }
      const extreme = facts.find((f): f is ExtremeFact => f.kind === "extreme" && outcome.factIds.includes(f.id) && f.which === direction);
      const ranking = facts.find((f): f is RankingFact => f.kind === "ranking" && outcome.factIds.includes(f.id));
      if (extreme) keptFactIds.add(extreme.id);
      if (ranking) keptFactIds.add(ranking.id);
      const winner = extreme
        ? extreme.group
        : ranking
          ? (direction === "max" ? ranking.order[0] : ranking.order[ranking.order.length - 1])
          : undefined;
      const answer = extreme
        ? extreme.formatted
        : winner ?? (outcome.answerText ?? "").replace(/^[^:]*:\s*/, "");
      conclusions.push({ label, answer });
      done.push(label);

      // "most common category and what SHARE of all records" (§5) — the winner's
      // share of the grand total is an engine ShareFact on the count metric.
      const depGoal = depId ? goalById.get(depId) : undefined;
      const depMetric = depGoal ? singleMetric(depGoal) : undefined;
      const depOutcome = depId ? byId.get(depId) : undefined;
      if (requirements.groupShare && depMetric?.metric === "count" && winner) {
        const share = shareFacts.find(
          (f) =>
            f.sourceOperationId === depOutcome?.sourceOperationId &&
            f.group.toLowerCase() === winner.toLowerCase() &&
            /^count\b/.test(f.ofWhat.toLowerCase()),
        );
        if (share) {
          keptFactIds.add(share.id);
          conclusions.push({
            label: ru ? `Доля ${winner} от всех записей` : `${winner} share of all records`,
            answer: share.formatted,
          });
        }
      }
      continue;
    }

    if (goal.type === "comparison") {
      const label = language === "ru" ? "Сравнение" : "Comparison";
      if (outcome.status === "executed" && outcome.answerText) {
        for (const id of outcome.factIds) keptFactIds.add(id);
        conclusions.push({ label, answer: outcome.answerText });
        done.push(label);
      } else if (outcome.status !== "executed") {
        failures.push({ label, detail: failureDetail(outcome.failureReason, language) });
      }
      continue;
    }

    if (goal.type === "visualization") {
      if (outcome.status !== "executed") {
        chartFailed = true;
        continue;
      }
      chartBuilt = true;
      // Stage 21.2.8.1 — the per-category aggregates that BUILT the chart are
      // real scalar facts (deriveChartValueFacts). Project them as a table so a
      // grouped-bar answer / fallback shows the numbers without a second request.
      // Skipped when an analytical goal already covers a grouping (no dup columns).
      const cv = facts.filter(
        (f): f is ScalarFact =>
          f.kind === "scalar" && f.sourceOperationId === CHART_VALUE_OP_ID && f.group !== undefined,
      );
      const dim = chart?.result?.x ?? null;
      const alreadyGrouped = metrics.some((m) => m.by !== null);
      if (cv.length > 0 && !alreadyGrouped) {
        const order: string[] = [];
        for (const f of cv) if (f.group && !order.includes(f.group)) order.push(f.group);
        const seenMetric = new Set<string>();
        for (const f of cv) {
          if (seenMetric.has(f.metric)) continue;
          seenMetric.add(f.metric);
          const rows = order.map((g) => {
            const hit = cv.find((x) => x.metric === f.metric && x.group === g);
            if (hit) keptFactIds.add(hit.id);
            return { group: g, formatted: hit?.formatted ?? "—" };
          });
          metrics.push({
            key: `chart:${f.metric.toLowerCase()}`,
            label: cap(withBy(localizeChartMetric(f.metric, language), dim, language)),
            by: dim,
            rows,
          });
        }
      }
      continue;
    }
    // interpretation contributes no numeric projection
  }

  // "which two groups are closest / farthest apart on <metric>, show the difference"
  // — the engine derives exactly that PairFact; project it (and only it) when the
  // request asks for a pair (Stage 21.2.8 completeness — 21.2.7 §7 only bans the
  // AUTO pair the user never asked about).
  if (requirements.pairSelection) {
    const wanted = requirements.pairSelection;
    const pairs = facts.filter((f): f is PairFact => f.kind === "pair" && f.which === wanted);
    const reqMetric = requirements.metrics.find((m) => pairs.some((p) => p.metric.toLowerCase().includes(m.column.toLowerCase())));
    const pair =
      (reqMetric && pairs.find((p) => p.metric.toLowerCase().includes(reqMetric.column.toLowerCase()))) ?? pairs[0];
    if (pair) {
      keptFactIds.add(pair.id);
      const [a, b] = pair.groups;
      // a friendly metric phrase ("среднее Fact"), never the internal slug "mean_Fact"
      const metricPhrase = reqMetric
        ? `${AGG_WORD[language][reqMetric.aggregate ?? "mean"] ?? reqMetric.aggregate ?? ""} ${reqMetric.absolute ? (ru ? "абсолютное " : "absolute ") : ""}${reqMetric.column}`.trim()
        : pair.metric.replace(/_/g, " ");
      const delta = /\(([^)]*)\)\s*$/.exec(pair.formatted)?.[1] ?? ""; // "Δ 2.31"
      conclusions.push({
        label: ru
          ? `${wanted === "closest" ? "Ближайшая" : "Самая далёкая"} пара по ${metricPhrase}`
          : `${wanted === "closest" ? "Closest" : "Farthest"} pair by ${metricPhrase}`,
        answer: `${a} & ${b}${delta ? ` (${delta})` : ""}`,
      });
    }
  }

  return {
    metrics,
    conclusions,
    chartBuilt,
    chartFailed,
    interpretationRequested: requirements.interpretation,
    done,
    failures,
    facts: facts.filter((f) => keptFactIds.has(f.id)),
  };
}

/**
 * The model-facing figures block for a compound turn — ONLY the request-relevant
 * values. The numeric claim validator still runs against the full VerifiedFacts
 * set, so restricting what the model SEES here never weakens safety.
 */
export function renderProjectedFactsForModel(projection: FactProjection, language: Lang): string {
  if (projection.metrics.length === 0 && projection.conclusions.length === 0 && projection.failures.length === 0) return "";
  const ru = language === "ru";
  const lines: string[] = [
    ru
      ? "ФАКТЫ (только относящиеся к запросу — цитируй дословно. Каждую долю/процент, которую можно назвать, движок уже вычислил и привёл ниже; сам ничего не складывай, не вычитай, не дели):"
      : "FACTS (only what this request needs — quote verbatim. Every share / percentage you may state is already computed and listed below; do not add, subtract or divide anything yourself):",
  ];
  for (const metric of projection.metrics) {
    const values = metric.rows.map((r) => (r.group ? `${r.group} ${r.formatted}` : r.formatted)).join("; ");
    lines.push(`- ${metric.label}: ${values}`);
  }
  for (const conclusion of projection.conclusions) {
    lines.push(`- ${conclusion.label}: ${conclusion.answer}`);
  }
  if (projection.chartBuilt) lines.push(ru ? "- График: построен" : "- Chart: built");
  for (const failure of projection.failures) {
    lines.push(`- ${failure.label}: ${ru ? "не выполнено" : "not done"} — ${failure.detail}`);
  }
  return lines.join("\n");
}
