import type { AgentObservation } from "../agent/types.js";

// §4 — operations that can produce a singular semantic winner when they
// return exactly one row (unambiguous — no need to consult the sentence).
export const SINGLE_WINNER_TOOLS: ReadonlySet<string> = new Set([
  "set.argmax",
  "set.argmin",
  "set.top",
  "set.bottom",
  "event.max_adjacent_change",
  "event.min_adjacent_change",
  "aggregate.max",
  "aggregate.min",
]);

// §3/§5 — a MULTI-row result can still have exactly one semantic winner: a
// sorted ranking / volatility-style ranking's row[0], but ONLY when the
// sentence actually asked for a single superlative winner (never assumed for
// a plain "show me the comparison" ask).
export const RANKED_WINNER_TOOLS: ReadonlySet<string> = new Set(["set.sort", "analysis.volatility", "analysis.stability"]);

export interface SemanticWinnerMatch {
  readonly metricKey: string;
  /** The observation the winner was read from — Stage 25.1.3d §11, so a
   *  caller can tell whether the winner came from an event.*_adjacent_change
   *  tool (and so can commit the FULL EventRef atomically) vs. any other
   *  winner-producing tool. */
  readonly observation: AgentObservation;
}

/**
 * §3/§5/§8 — walks observations from MOST RECENT to oldest and returns the
 * first (i.e. most recent) qualifying winner, together with the observation
 * it came from. A fresh winner always outranks an older one, matching §8's
 * pronoun-resolution priority.
 */
export function determineSemanticWinnerMatch(observations: readonly AgentObservation[], superlativeAsk: boolean): SemanticWinnerMatch | null {
  for (let i = observations.length - 1; i >= 0; i -= 1) {
    const obs = observations[i]!;
    if (!obs.ok || !obs.columns || !obs.rows || obs.rows.length === 0) continue;
    const mCol = obs.columns.indexOf("metric");
    if (mCol < 0) continue;
    if (SINGLE_WINNER_TOOLS.has(obs.tool) && obs.rows.length === 1) {
      const key = String(obs.rows[0]![mCol] ?? "");
      if (key) return { metricKey: key, observation: obs };
    }
    if (superlativeAsk && RANKED_WINNER_TOOLS.has(obs.tool)) {
      const key = String(obs.rows[0]![mCol] ?? "");
      if (key) return { metricKey: key, observation: obs };
    }
  }
  return null;
}

/**
 * §3/§5/§8 — the bare winner metric key, for every existing caller that
 * never needed the source observation. Delegates to `determineSemanticWinnerMatch`
 * — same selection, unchanged (Stage 25.1.3d does not modify SemanticWinner
 * extraction).
 */
export function determineSemanticWinner(observations: readonly AgentObservation[], superlativeAsk: boolean): string | null {
  return determineSemanticWinnerMatch(observations, superlativeAsk)?.metricKey ?? null;
}
