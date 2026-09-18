// ---------------------------------------------------------------------------
// Stage 25.1.3d §3–§8/§15/§26 — the PRIMARY ANSWER of a completed run.
//
// A completed run's observations are NOT interchangeable: an upstream
// compare-periods table, the filter that ran over it, and a possible
// winner-rank on top of THAT are three different refinements of the SAME
// answer — only the LAST one is what the user actually asked for. The
// supporting-evidence pipeline (every intermediate observation) must never
// be allowed to decide what the primary answer is merely by being the
// biggest table, or the last table full stop — this module is the ONE place
// that decides "which single observation IS the answer", reused identically
// by `runtime.ts` (`outcome.primary`, session-memory commit) and by
// `narrator.ts` (the deterministic fallback render AND the FACTS a
// single-clause request's narrator is even shown) so the two can never
// disagree (§15).
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import type { AgentObservation } from "../agent/types.js";
import { ANSWER_SHAPED_TOOLS } from "./semantic-audit.js";
import { detectRequestedRankingBasis, hasSuperlativeAsk } from "./semantic-frame.js";
import { determineSemanticWinnerMatch, type SemanticWinnerMatch } from "./semantic-winner.js";

// §4 — a restricting/ranking/winner-producing step is JUST as much a
// clause's own primary answer as the tools already recognized as
// "answer-shaped": `set.filter` producing "only the declining metrics" for
// the whole request IS the answer, not upstream plumbing to be discarded.
const RESTRICTING_OR_WINNER_TOOLS: ReadonlySet<string> = new Set(["set.filter", "set.sort", "set.top", "set.bottom", "set.argmax", "set.argmin"]);

export const PRIMARY_ANSWER_TOOLS: ReadonlySet<string> = new Set([...ANSWER_SHAPED_TOOLS, ...RESTRICTING_OR_WINNER_TOOLS]);

export interface PrimaryAnswer {
  readonly observation: AgentObservation;
  /** true when selected via a recognized primary-answer-shaped tool, or the
   *  §7 superlative reduction — false when nothing recognized matched and
   *  this merely fell back to "the last table at all" (preserves prior
   *  behavior for an operation not yet in `PRIMARY_ANSWER_TOOLS`, e.g. a
   *  `derive.compute`-terminated exploratory plan). Callers that need to be
   *  CONSERVATIVE (e.g. narrowing narrator FACTS) should require this. */
  readonly confident: boolean;
}

function isTable(o: AgentObservation): boolean {
  return o.ok && o.kind === "table" && Boolean(o.columns) && o.columns!.length > 0 && Boolean(o.rows) && o.rows!.length > 0;
}

/**
 * Stage 25.1.3e §3/§4/§10 — the CANDIDATE observation a winner should be
 * reduced from: the last recognized primary-answer-shaped observation, in
 * execution order — the SAME restriction `determinePrimaryAnswer` itself
 * applies. A prior turn's filtered ResultSet (11 declining rows, say) is
 * never re-widened: whichever tool ran LAST still only carries those same
 * candidate rows, just possibly reordered.
 */
export function findCandidateObservation(observations: readonly AgentObservation[]): AgentObservation | null {
  return [...observations].reverse().find((o) => isTable(o) && PRIMARY_ANSWER_TOOLS.has(o.tool)) ?? null;
}

// Stage 25.1.3e §4 — the validated reduction contract: WHICH field, whether
// to compare by magnitude (|value|) or signed value, and which end wins.
// `field` is deliberately a plain string (not the narrower
// `RankingBasisField`) so a future ranking basis never needs a signature
// change here.
export interface WinnerReductionSpec {
  readonly field: string;
  readonly magnitude: boolean;
  readonly direction: "max" | "min";
}

/**
 * Stage 25.1.3e §3/§4/§7/§11 — scans EVERY row of `candidate` and returns
 * the one satisfying `spec` — NEVER trusts row ORDER (a tool's own
 * set.sort/set.argmax choice, which is LLM-controlled and may have used the
 * wrong field or direction), only the raw field VALUES read directly from
 * the observation. `null` when the metric/field column is missing, or no
 * row carries a finite value for it (never a false "found a winner").
 */
function computeDeterministicWinner(candidate: AgentObservation, spec: WinnerReductionSpec): SemanticWinnerMatch | null {
  if (!candidate.columns || !candidate.rows || candidate.rows.length === 0) return null;
  const mCol = candidate.columns.indexOf("metric");
  const fCol = candidate.columns.indexOf(spec.field);
  if (mCol < 0 || fCol < 0) return null;
  let bestRow: readonly CellValue[] | null = null;
  let bestScore = spec.direction === "max" ? -Infinity : Infinity;
  for (const row of candidate.rows) {
    const raw = row[fCol];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const score = spec.magnitude ? Math.abs(raw) : raw;
    const better = spec.direction === "max" ? score > bestScore : score < bestScore;
    if (better) {
      bestScore = score;
      bestRow = row;
    }
  }
  if (!bestRow) return null;
  const metricKey = String(bestRow[mCol] ?? "");
  if (!metricKey) return null;
  return { metricKey, observation: { ...candidate, rows: [bestRow], rowCount: 1 } };
}

/**
 * Stage 25.1.3e §3–§9/§25 — the deterministic, VALIDATED winner of a
 * "changed the most" style request. Never assumes row[0] of whatever the
 * planner's own `set.sort`/`set.argmax` call produced is meaningful — even
 * a genuine `set.sort` is re-verified by recomputing the reduction directly
 * from the candidate observation's own row data. Reuses
 * `detectRequestedRankingBasis` verbatim (Stage 25.1.3b's single source of
 * truth for "what does 'сильнее всего' mean here" — §6, never a second
 * independent interpretation). `null` when the request is not a
 * ranking-basis ask at all, or no candidate/field is available — callers
 * fall back to the legacy `determineSemanticWinnerMatch` reduction for
 * every OTHER superlative (volatility, direction-change, historical
 * extreme, …), unaffected by this stage.
 */
export function determineValidatedWinner(observations: readonly AgentObservation[], requestText: string): SemanticWinnerMatch | null {
  const basis = detectRequestedRankingBasis(requestText);
  if (!basis) return null;
  const candidate = findCandidateObservation(observations);
  if (!candidate) return null;
  return computeDeterministicWinner(candidate, { field: basis, magnitude: true, direction: "max" });
}

/**
 * §5/§7 — a singular superlative ask NOT covered by a validated ranking
 * basis ("самый нестабильный", "самый большой скачок для этого показателя")
 * reduces the primary answer to JUST the winning row, reusing the SAME
 * winner selection already proven for SemanticWinner (`semantic-winner.ts`,
 * unmodified by this stage) — never the whole ranked/candidate table the
 * winner was read from.
 */
function reduceToWinnerRow(observations: readonly AgentObservation[], requestText: string): AgentObservation | null {
  const match = determineSemanticWinnerMatch(observations, hasSuperlativeAsk(requestText));
  if (!match || !match.observation.columns || !match.observation.rows) return null;
  const mCol = match.observation.columns.indexOf("metric");
  if (mCol < 0) return null;
  const row = match.observation.rows.find((r) => String(r[mCol] ?? "") === match.metricKey);
  if (!row) return null;
  return { ...match.observation, rows: [row], rowCount: 1 };
}

/**
 * §3–§9/§26 — the ONE observation that answers what the request actually
 * asked for: for a "changed the most" style ask, the DETERMINISTIC,
 * VALIDATED winner (§3/§4 — never row[0] of an unverified sort); for any
 * other singular superlative ask, the legacy winner-tool reduction (§7 —
 * cardinality 1); otherwise the LAST observation from a recognized
 * primary-answer tool, in EXECUTION ORDER — "compare -> filter" surfaces
 * the filter's output, "compare -> filter -> rank" surfaces the rank's
 * output, matching how the plan itself progressively refined the answer
 * (§4). Falls back to "the last table at all" (`confident: false`) only
 * when nothing recognized ran.
 */
export function determinePrimaryAnswer(observations: readonly AgentObservation[], requestText: string): PrimaryAnswer | null {
  const validated = determineValidatedWinner(observations, requestText);
  if (validated) return { observation: validated.observation, confident: true };
  if (hasSuperlativeAsk(requestText)) {
    const reduced = reduceToWinnerRow(observations, requestText);
    if (reduced) return { observation: reduced, confident: true };
  }
  const matched = [...observations].reverse().find((o) => isTable(o) && PRIMARY_ANSWER_TOOLS.has(o.tool));
  if (matched) return { observation: matched, confident: true };
  const anyTable = [...observations].reverse().find(isTable);
  return anyTable ? { observation: anyTable, confident: false } : null;
}
