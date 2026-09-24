import type { Caveat, VerifiedFinding } from "../insight/verified-finding.js";
import type { EngineAnalysis } from "../types.js";

export type AnswerShape = "direct" | "structured";

export interface AnswerPlan {
  readonly shape: AnswerShape;
  /** §35 of Stage 26 — the answer, taken from the PRIMARY result. Never re-guessed. */
  readonly lead: VerifiedFinding | null;
  /** §44 — the two-to-five findings that earn a place in the answer. */
  readonly support: readonly VerifiedFinding[];
  /** §40 — limitations the wording must respect, deduplicated by code. */
  readonly caveats: readonly Caveat[];
  /** §54 — a table only where a comparison genuinely reads better as one. */
  readonly showEvidenceTable: boolean;
}

/** §44 — "2–5 important findings"; beyond five an answer stops being an answer. */
const MAX_SUPPORT = 4;

/**
 * §54 — is a table worth showing?
 *
 * Only when the primary result is genuinely tabular: several subjects compared
 * across several numeric columns. A one-row result rendered as a table is the
 * raw-dump failure §43 names, wearing a border.
 */
function tableEarnsItsPlace(analysis: EngineAnalysis): boolean {
  const primary = analysis.primary;
  const numericColumns = primary.fields.filter((f) => f.kind === "number").length;
  return primary.rows.length >= 3 && numericColumns >= 2;
}

/**
 * §44/§45 — plan the answer.
 *
 * `findings` arrive in the order `buildFindings` produced them: the primary
 * result's observations first, most material first. The lead is therefore the
 * first one, and that is not a heuristic — it is the planner's own declared
 * primary result, carried through unchanged.
 */
export function planAnswer(analysis: EngineAnalysis, findings: readonly VerifiedFinding[]): AnswerPlan {
  const lead = findings[0] ?? null;
  const support = findings.slice(1, 1 + MAX_SUPPORT);

  const caveats: Caveat[] = [];
  const seen = new Set<string>();
  for (const finding of [lead, ...support]) {
    if (!finding) continue;
    for (const caveat of finding.caveats) {
      const key = `${caveat.code}:${caveat.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      caveats.push(caveat);
    }
  }

  // §45 — one observation is one sentence. The evidence is what decides:
  // a single-row primary with nothing supporting it has nothing to structure.
  const trivial = support.length === 0 && analysis.primary.rows.length <= 1;
  const shape: AnswerShape = trivial ? "direct" : "structured";

  return {
    shape,
    lead,
    support,
    caveats: caveats.slice(0, 3),
    showEvidenceTable: shape === "structured" && tableEarnsItsPlace(analysis),
  };
}
