import { rememberAnalyticalResultSet, rememberEvent, rememberMetricFocus, rememberMetricSet, rememberPeriod, rememberResultSet } from "../app/conversation-memory.js";
import type { EventRef } from "../app/session-memory.js";
import type { SessionMemory } from "../app/session-memory.js";
import type { AgentObservation, AgentStep } from "../agent/types.js";
import { extractExecutedInterval } from "./semantic-audit.js";
import { determineSemanticWinnerMatch } from "./semantic-winner.js";
import { determineValidatedWinner } from "./primary-answer.js";
import { determineContinuationResult } from "./result-continuity.js";
import { hasSuperlativeAsk } from "./semantic-frame.js";

const RESULT_SET_TOOLS = new Set(["analysis.volatility", "analysis.stability"]);
const RESTRICTING_SET_TOOLS = new Set(["set.filter", "set.sort", "set.top", "set.bottom"]);
// Stage 25.1.3d §11 — a winner sourced from one of these carries a FULL
// adjacent-period event, not just a bare metric key.
const EVENT_WINNER_TOOLS = new Set(["event.max_adjacent_change", "event.min_adjacent_change"]);

export interface CommitContext {
  readonly turnId: string;
  readonly sourceRange: string;
  readonly sourceVersion: string;
  /** Stage 25.1.3 §3/§5 — the original request text, used ONLY to decide
   *  whether a superlative ask ("сильнее всего") makes a sorted multi-row
   *  result's row[0] a semantic winner. Optional for back-compat callers. */
  readonly requestText?: string;
}

function metricColumn(obs: AgentObservation): number {
  return obs.columns ? obs.columns.indexOf("metric") : -1;
}

/**
 * Stage 25.1.3d §11 — builds a full `EventRef` from an
 * `event.max_adjacent_change`/`event.min_adjacent_change` observation's own
 * winning row (the SAME row `determineSemanticWinnerMatch` already picked).
 * `null` when the observation is missing an expected column — never a
 * partially-populated EventRef.
 */
function buildEventRefInput(obs: AgentObservation, winner: string, ctx: CommitContext): Omit<EventRef, "id" | "order" | "createdAt"> | null {
  if (!obs.columns || !obs.rows) return null;
  const col = (name: string): number => obs.columns!.indexOf(name);
  const mCol = col("metric");
  const spCol = col("startPeriod");
  const epCol = col("endPeriod");
  const svCol = col("startValue");
  const evCol = col("endValue");
  const acCol = col("absoluteChange");
  const pcCol = col("percentageChange");
  const scCol = col("startCell");
  const ecCol = col("endCell");
  const spcCol = col("startPeriodCanonical");
  const epcCol = col("endPeriodCanonical");
  if ([mCol, spCol, epCol, svCol, evCol, acCol, pcCol, scCol, ecCol, spcCol, epcCol].some((i) => i < 0)) return null;
  const row = obs.rows.find((r) => String(r[mCol] ?? "") === winner);
  if (!row) return null;
  const pcRaw = row[pcCol];
  return {
    turnId: ctx.turnId,
    eventType: "adjacent_period_change",
    metricKey: winner,
    startCanonical: String(row[spcCol]),
    endCanonical: String(row[epcCol]),
    startHeaderPath: String(row[spCol]),
    endHeaderPath: String(row[epCol]),
    startValue: Number(row[svCol]),
    endValue: Number(row[evCol]),
    absoluteChange: Number(row[acCol]),
    percentageChange: typeof pcRaw === "number" ? pcRaw : null,
    sourceCells: [String(row[scCol]), String(row[ecCol])],
    sourceRange: ctx.sourceRange,
    sourceVersion: ctx.sourceVersion,
  };
}

/**
 * §5/§6 — scans every successful observation of a completed planner run (in
 * execution order) and commits every canonical ref shape it recognizes.
 * Multiple refs may commit from one turn (a focus AND a result set, say) —
 * each write goes through the existing typed `remember*` function unchanged.
 */
export function commitPlannerOutputs(memory: SessionMemory, ctx: CommitContext, observations: readonly AgentObservation[], steps: readonly AgentStep[] = []): SessionMemory {
  let next = memory;

  for (const obs of observations) {
    if (!obs.ok || !obs.columns || !obs.rows) continue;
    const mCol = metricColumn(obs);

    // §7 — "Активы и Обязательства" (an explicit user-named set).
    if (obs.tool === "metric.resolve_set" && mCol >= 0) {
      const keys = obs.rows.map((r) => String(r[mCol] ?? "")).filter(Boolean);
      if (keys.length >= 2) {
        next = rememberMetricSet(next, { turnId: ctx.turnId, metricKeys: keys, origin: "explicit_user_list", sourceRange: ctx.sourceRange, sourceVersion: ctx.sourceVersion });
      }
      continue;
    }

    // §5/§51 — an ordered ranking-shaped result ("какой из них самый
    // волатильный?" slices this WITHOUT recomputation).
    if (RESULT_SET_TOOLS.has(obs.tool) && mCol >= 0) {
      const scoreCol = obs.columns.indexOf("score");
      if (scoreCol >= 0) {
        const rows = obs.rows
          .map((r) => ({ key: String(r[mCol] ?? ""), score: Number(r[scoreCol]) }))
          .filter((r) => r.key && Number.isFinite(r.score))
          .sort((a, b) => b.score - a.score);
        if (rows.length > 0) {
          next = rememberResultSet(next, { turnId: ctx.turnId, operation: obs.tool, scoreField: "score", rows, sourceRange: ctx.sourceRange, sourceVersion: ctx.sourceVersion });
        }
      }
      continue;
    }

    // §18/§52 — a restricting filter/sort/slice over >1 rows becomes the new
    // candidate set for "из них" — never re-widened to the whole workbook.
    if (RESTRICTING_SET_TOOLS.has(obs.tool) && mCol >= 0 && obs.rows.length > 1) {
      const keys = [...new Set(obs.rows.map((r) => String(r[mCol] ?? "")).filter(Boolean))];
      if (keys.length >= 2) {
        next = rememberMetricSet(next, { turnId: ctx.turnId, metricKeys: keys, origin: "previous_filter", sourceRange: ctx.sourceRange, sourceVersion: ctx.sourceVersion });
      }
      continue;
    }
  }

  // Stage 25.1.3 §2/§3/§6/§7 — the semantic winner of the WHOLE run (never
  // inferred merely from "the tool returned one row" — a sorted 11-row
  // decline table still has exactly one winner in row 1 when the sentence
  // asked for a superlative). Committed regardless of how many supporting
  // rows also persisted as a MetricSetRef/ResultSetRef above (§6's exact
  // example: an 11-row decline set AND a "reverse repo" focus, both true).
  // Stage 25.1.3e §6/§9 — the SAME single source of truth `determinePrimaryAnswer`
  // uses: a "changed the most" style ask commits the DETERMINISTIC,
  // VALIDATED winner (never row[0] of an unverified sort), so
  // MetricFocusRef can never disagree with PrimaryAnswerRef. Falls back to
  // the legacy reduction for every other superlative, unchanged.
  const winnerMatch = determineValidatedWinner(observations, ctx.requestText ?? "") ?? determineSemanticWinnerMatch(observations, hasSuperlativeAsk(ctx.requestText ?? ""));
  if (winnerMatch) {
    const { metricKey: winner, observation: winnerObs } = winnerMatch;
    // Stage 25.1.3d §9–§12 — a winner sourced from an adjacent-event tool
    // commits the FULL EventRef ATOMICALLY: `rememberEvent` sets
    // `lastEventRef` AND `lastMetricFocusRef` in the SAME write, so the two
    // can never disagree after a successful compound turn (§11). Falls back
    // to a bare metric-focus commit for every other winner-producing tool,
    // exactly as before.
    const eventInput = EVENT_WINNER_TOOLS.has(winnerObs.tool) ? buildEventRefInput(winnerObs, winner, ctx) : null;
    next = eventInput ? rememberEvent(next, eventInput) : rememberMetricFocus(next, { metricKey: winner, sourceRange: ctx.sourceRange, sourceVersion: ctx.sourceVersion });
  }

  // Stage 25.1.2 §2/§3/§53 — the FINAL interval the run's calculation
  // actually used (never every period.select/period.list touched while
  // exploring the schema): the interval a later "за этот же период"
  // follow-up should reuse.
  const executedInterval = extractExecutedInterval(steps);

  // Stage 25.1.3f §3/§5/§6 — the run's CONTINUATION UNIVERSE: the full
  // structured result a compatible follow-up ("теперь покажи только те, что
  // снизились") consumes directly. Committed from the run's OWN observations,
  // never from `determinePrimaryAnswer` — a superlative turn narrows what the
  // user SEES to one row while the universe a later turn needs stays whole
  // (§6) — and never from the visible markdown table (§3).
  //
  // A turn that computed no analytical result of its own (schema reads, or a
  // bare echo of memory) leaves the previous universe standing rather than
  // erasing it.
  const continuation = determineContinuationResult(observations);
  if (continuation) {
    next = rememberAnalyticalResultSet(next, {
      turnId: ctx.turnId,
      operation: continuation.observation.tool,
      columns: continuation.columns,
      rows: continuation.rows,
      metricKeys: continuation.metricKeys,
      ...(executedInterval ? { startCanonical: executedInterval.startPeriod, endCanonical: executedInterval.endPeriod } : {}),
      sourceRange: ctx.sourceRange,
      sourceVersion: ctx.sourceVersion,
    });
    // §3 — the same universe as a plain metric set, so "из них" resolves
    // through the EXISTING `reference.previous_metric_set` too. Only when the
    // loop above committed none from this run (an explicit user list or a
    // restricting filter is a more specific statement of the same thing) and
    // only for a genuinely multi-metric result — a single-metric answer is a
    // focus, not a set.
    if (continuation.metricKeys.length >= 2 && next.lastMetricSetRef?.turnId !== ctx.turnId) {
      next = rememberMetricSet(next, {
        turnId: ctx.turnId,
        metricKeys: continuation.metricKeys,
        origin: "previous_result_set",
        sourceRange: ctx.sourceRange,
        sourceVersion: ctx.sourceVersion,
      });
    }
  }

  if (executedInterval) {
    const [a, b] = [executedInterval.startPeriod, executedInterval.endPeriod].sort();
    next = rememberPeriod(next, {
      turnId: ctx.turnId,
      kind: "interval",
      startCanonical: a!,
      endCanonical: b!,
      startHeaderPath: a!,
      endHeaderPath: b!,
      sourceRange: ctx.sourceRange,
      sourceVersion: ctx.sourceVersion,
    });
  }

  return next;
}
