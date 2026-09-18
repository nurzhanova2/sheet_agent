// ---------------------------------------------------------------------------
// Stage 27 §44/§45/§54/§55 — the SHAPE of an answer, decided before wording.
//
// §44 gives a default structure for a non-trivial analytical answer — direct
// answer, two to five findings, context, compact evidence only if useful,
// caveats — and then immediately warns: "Do not force headings for trivial
// questions." §45 shows what forcing looks like. "На сколько выросли активы с
// начала года?" deserves one sentence, and answering it with a heading, a
// bullet list and a table is a worse answer even though every part is correct.
//
// So shape is chosen from the EVIDENCE, not from the question's wording. One
// observation is one sentence. Several related observations get structure. The
// user's phrasing is never inspected here: that would be a phrase handler, and
// Stage 26 exists because phrase handlers do not survive contact with real
// questions.
//
// This module also performs §55's narrowing: the narrator receives the lead
// finding, a bounded set of supporting ones and the caveats — not every entry
// in the ResultStore. A narrator shown everything writes about everything.
// ---------------------------------------------------------------------------

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
