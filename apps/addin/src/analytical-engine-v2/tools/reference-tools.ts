import type { CellValue } from "@sheet-agent/application";
import type { ToolOutcome } from "../types.js";
import { METRIC_FIELD, cell, num, period, text, type ToolEnv, type ToolSpec } from "./contracts.js";
import { provenanceOf, requireReference, type RefProvenance } from "../state/state-refs.js";
import type { ReferenceKind, RefLineage } from "../state/conversation-state.js";

/** §13/§17/§19 — the shared gate, so no tool can forget one of the checks. */
function gate<T>(value: T | undefined, kind: ReferenceKind, lineage: RefLineage | undefined, env: ToolEnv, provenance?: RefProvenance): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ToolOutcome } {
  // §25 of Stage 26.4 — an absent reference still lists THIS turn's results, so
  // the planner continues from what it has rather than treating it as a crash.
  return requireReference(value, kind, provenance ?? provenanceOf(lineage, env.state), env.state, env.schema, env.store.ids());
}

const referenceLastResult: ToolSpec = {
  name: "reference.last_result",
  capability: "references",
  usable: (facts) => facts.references.result,
  description:
    "The full structured result the PREVIOUS turn produced, restored with all of its rows and fields. Returns it under a new resultId you can filter, rank or extend. Use it whenever the request continues the last answer rather than starting a new analysis — it is both faster and more faithful than rebuilding the previous work from scratch.",
  args: {},
  returns: "table",
  reads: false,
  run: (_args, env) => {
    const stored = env.state.lastResult;
    const g = gate(stored, "result", undefined, env, stored ? { sourceRange: stored.sourceRange, sourceVersion: stored.sourceVersion } : undefined);
    if (!g.ok) return g.error;
    const prev = g.value;
    return {
      ok: true,
      result: env.store.put({
        tool: "reference.last_result",
        type: prev.type,
        fields: prev.fields,
        rows: prev.rows,
        metricKeys: prev.metricKeys,
        periodCanonicals: prev.periodCanonicals,
        metadata: { restoredFrom: prev.tool, restoredResultId: prev.resultId, role: prev.role ?? "primary" },
      }),
    };
  },
};

/**
 * Stage 26.7 §27 — the previous turn's ANSWER specifically, as opposed to the
 * evidence behind it. `reference.last_result` already restores the primary, so
 * this exists for the case the audit found unreachable: naming a SUPPORTING
 * result deliberately, when the request asks for one.
 */
const referenceRecent: ToolSpec = {
  name: "reference.recent",
  capability: "references",
  usable: (facts) => facts.references.recent,
  description:
    'The recent results of this conversation in order, most recent first, each labelled as the answer it was ("primary") or the evidence behind it ("supporting"). Use it when a request points at something other than the immediately previous answer — an earlier step, or a supporting table the last answer rested on. Returns the chosen result restored under a new resultId. Pass n to choose which one; n=1 is the most recent. When you also pass role, n counts only within the results of that role. Pass metricCount when the request names how many metrics the referenced set had ("these three", "тот пятёрка показателей") — n then counts only within results whose metric set has exactly that many metrics, most recent first, so an intervening result of a different size is skipped rather than matched.',
  args: {
    n: { type: "number", describe: "which recent result to restore, 1 = most recent (default 1)" },
    role: { type: "string", describe: 'restrict to "primary" answers or "supporting" evidence; omit for both' },
    metricCount: { type: "number", describe: "restrict to results whose metric set has exactly this many metrics" },
  },
  returns: "table",
  reads: false,
  run: (args, env) => {
    const all = env.state.recentResults ?? [];
    const role = args["role"];
    if (role !== undefined && role !== "primary" && role !== "supporting") {
      return { ok: false, error: { code: "INVALID_ARGUMENT", message: '"role" must be "primary" or "supporting"', candidates: ["primary", "supporting"] } };
    }
    const metricCountRaw = args["metricCount"];
    if (metricCountRaw !== undefined && (typeof metricCountRaw !== "number" || !Number.isInteger(metricCountRaw) || metricCountRaw < 1)) {
      return { ok: false, error: { code: "INVALID_ARGUMENT", message: '"metricCount" must be a positive whole number' } };
    }
    const roleFiltered = role === undefined ? all : all.filter((r) => (r.role ?? "primary") === role);
    const pool = metricCountRaw === undefined ? roleFiltered : roleFiltered.filter((r) => r.metricKeys.length === metricCountRaw);
    const nRaw = args["n"];
    const n = nRaw === undefined ? 1 : nRaw;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      return { ok: false, error: { code: "INVALID_ARGUMENT", message: '"n" must be a positive whole number, 1 = most recent' } };
    }
    const pick = pool[n - 1];
    // Asking past the end is NOT "there is no history" — saying so sent a live
    // planner into retrying the identical call until the turn died. Say how
    // many there are, and of which kind, so the next call can be right.
    if (!pick && all.length > 0) {
      const roles = all.map((r, i) => `${i + 1}) ${r.tool} (${r.role ?? "primary"}, ${r.metricKeys.length} metric(s))`).join("; ");
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message:
            `n=${n} is past the end: ${pool.length} result(s)${role ? ` with role "${role}"` : ""}${metricCountRaw !== undefined ? ` with exactly ${metricCountRaw} metric(s)` : ""} are available. ` +
            `The conversation holds ${all.length}: ${roles}. Note that n counts within the results matching "role"/"metricCount" when you pass them.`,
        },
      };
    }
    const g = gate(pick, "result", undefined, env, pick ? { sourceRange: pick.sourceRange, sourceVersion: pick.sourceVersion } : undefined);
    if (!g.ok) return g.error;
    const prev = g.value;
    return {
      ok: true,
      result: env.store.put({
        tool: "reference.recent",
        type: prev.type,
        fields: prev.fields,
        rows: prev.rows,
        metricKeys: prev.metricKeys,
        periodCanonicals: prev.periodCanonicals,
        metadata: { restoredFrom: prev.tool, restoredResultId: prev.resultId, role: prev.role ?? "primary", position: n },
      }),
    };
  },
};

const referenceLastMetric: ToolSpec = {
  name: "reference.last_metric",
  capability: "references",
  usable: (facts) => facts.references.metric,
  description:
    'The single metric currently under discussion — what a pronoun or a phrase like "that metric" refers to. Returns a one-row metric_set; pass its label straight into series.get, event.* or change.*. Use it instead of trying to work out the reference yourself.',
  args: {},
  returns: "metric_set",
  reads: false,
  run: (_args, env) => {
    const g = gate(env.state.lastMetric, "metric", env.state.lastMetric?.lineage, env);
    if (!g.ok) return g.error;
    const m = g.value;
    return { ok: true, result: env.store.put({ tool: "reference.last_metric", type: "metric_set", fields: [METRIC_FIELD], rows: [[m.metricKey]], metricKeys: [m.metricKey] }) };
  },
};

const referenceLastMetricSet: ToolSpec = {
  name: "reference.last_metric_set",
  capability: "references",
  usable: (facts) => facts.references.metricSet,
  description:
    'The set of metrics under discussion — what a partitive reference such as "among them" or "of those" refers to. Returns a metric_set you can pass as inputRef so a new analysis stays confined to exactly those metrics and never widens back to the whole table.',
  args: {},
  returns: "metric_set",
  reads: false,
  run: (_args, env) => {
    const set = env.state.lastMetricSet;
    const g = gate(set && set.metricKeys.length > 0 ? set : undefined, "metricSet", set?.lineage, env);
    if (!g.ok) return g.error;
    const s = g.value;
    return {
      ok: true,
      result: env.store.put({ tool: "reference.last_metric_set", type: "metric_set", fields: [METRIC_FIELD], rows: s.metricKeys.map((k) => [k] as readonly CellValue[]), metricKeys: s.metricKeys }),
    };
  },
};

const referenceLastPeriod: ToolSpec = {
  name: "reference.last_period",
  capability: "references",
  usable: (facts) => facts.references.period,
  description:
    'The period or interval the previous turn used — what a phrase like "the same period" refers to. Returns a period result whose canonical strings you pass to a change or value tool, so a follow-up is measured over the same window as the answer it follows.',
  args: {},
  returns: "period",
  reads: false,
  run: (_args, env) => {
    const g = gate(env.state.lastPeriod, "period", env.state.lastPeriod?.lineage, env);
    if (!g.ok) return g.error;
    const p = g.value;
    const canonicals = [p.startCanonical, ...(p.endCanonical ? [p.endCanonical] : [])];
    return {
      ok: true,
      result: env.store.put({
        tool: "reference.last_period",
        type: "period",
        fields: [period("period")],
        rows: canonicals.map((c) => [c] as readonly CellValue[]),
        metricKeys: [],
        periodCanonicals: canonicals,
      }),
    };
  },
};

/** Stage 26.7 §6/§21 — a SPAN, kept apart from a point. */
const referenceLastPeriodRange: ToolSpec = {
  name: "reference.last_period_range",
  capability: "references",
  usable: (facts) => facts.references.periodRange,
  description:
    'The two-ended interval the previous turn measured over — what "over the same interval" refers to, as opposed to a single date. Returns a period_range you can pass to a change or aggregate tool.',
  args: {},
  returns: "period_range",
  reads: false,
  run: (_args, env) => {
    const g = gate(env.state.lastPeriodRange, "periodRange", env.state.lastPeriodRange?.lineage, env);
    if (!g.ok) return g.error;
    const r = g.value;
    return {
      ok: true,
      result: env.store.put({
        tool: "reference.last_period_range",
        type: "period_range",
        fields: [period("startPeriod"), period("endPeriod")],
        rows: [[r.startCanonical, r.endCanonical]],
        metricKeys: [],
        periodCanonicals: [r.startCanonical, r.endCanonical],
      }),
    };
  },
};

/** Stage 26.7 §6/§25 — the history a previous turn already produced. */
const referenceLastSeries: ToolSpec = {
  name: "reference.last_series",
  capability: "references",
  usable: (facts) => facts.references.series,
  description:
    "The per-period history the previous turn showed — what a follow-up about \"that chart\" or \"those values\" refers to. Returns the metric and the periods it covered; it names one metric, so it can also stand in wherever a single metric is required.",
  args: {},
  returns: "series",
  reads: false,
  run: (_args, env) => {
    const g = gate(env.state.lastSeries, "series", env.state.lastSeries?.lineage, env);
    if (!g.ok) return g.error;
    const s = g.value;
    return {
      ok: true,
      result: env.store.put({
        tool: "reference.last_series",
        type: "series",
        fields: [METRIC_FIELD, period("period")],
        rows: s.periodCanonicals.map((c) => [s.metricKey, c] as readonly CellValue[]),
        metricKeys: [s.metricKey],
        periodCanonicals: s.periodCanonicals,
      }),
    };
  },
};

const referenceLastEvent: ToolSpec = {
  name: "reference.last_event",
  capability: "references",
  usable: (facts) => facts.references.event,
  description:
    'The specific period-to-period move the previous turn identified — what a phrase like "that jump" or "when exactly" refers to. Returns a one-row event result with its metric, both periods, both values and the size of the move. It names one metric and two periods, so it can also stand in wherever a single metric or that interval is required.',
  args: {},
  returns: "event",
  reads: false,
  run: (_args, env) => {
    const g = gate(env.state.lastEvent, "event", env.state.lastEvent?.lineage, env);
    if (!g.ok) return g.error;
    const e = g.value;
    return {
      ok: true,
      result: env.store.put({
        tool: "reference.last_event",
        type: "event",
        fields: [METRIC_FIELD, text("startPeriodLabel"), text("endPeriodLabel"), num("startValue"), num("endValue"), num("absoluteChange"), num("percentageChange"), cell("startCell"), cell("endCell")],
        rows: [[e.metricKey, e.startCanonical, e.endCanonical, e.startValue, e.endValue, e.absoluteChange, e.percentageChange, "", ""]],
        metricKeys: [e.metricKey],
        periodCanonicals: [e.startCanonical, e.endCanonical],
      }),
    };
  },
};

/**
 * Stage 26.7 §26 — the SHAPE of the last analysis, so "and on the same basis?"
 * continues it instead of silently re-choosing one. Structured facts only.
 */
const referenceLastAnalysis: ToolSpec = {
  name: "reference.last_analysis",
  capability: "references",
  usable: (facts) => facts.references.analysis,
  description:
    "What the previous analysis actually DID: which operation, over which metrics, on which ranking field or basis. Returns a one-row table naming that operation, its result type, its ranking field and its basis. Use it when a follow-up should continue on the same footing — the same ranking basis, the same kind of comparison — instead of choosing one again.",
  args: {},
  returns: "table",
  reads: false,
  run: (_args, env) => {
    const g = gate(env.state.lastAnalysis, "analysis", env.state.lastAnalysis?.lineage, env);
    if (!g.ok) return g.error;
    const a = g.value;
    return {
      ok: true,
      result: env.store.put({
        tool: "reference.last_analysis",
        type: "table",
        fields: [text("operation"), text("resultType"), text("rankingField"), text("basis")],
        rows: [[a.tool, a.kind, a.rankingField ?? "", a.basis ?? ""]],
        metricKeys: a.metricKeys,
        metadata: { ...(a.rankingMagnitude !== undefined ? { rankingMagnitude: a.rankingMagnitude } : {}) },
      }),
    };
  },
};

export const REFERENCE_TOOLS: readonly ToolSpec[] = [
  referenceLastResult,
  referenceRecent,
  referenceLastMetric,
  referenceLastMetricSet,
  referenceLastPeriod,
  referenceLastPeriodRange,
  referenceLastSeries,
  referenceLastEvent,
  referenceLastAnalysis,
];
