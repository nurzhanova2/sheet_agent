import type { Caveat, VerifiedFinding } from "../insight/verified-finding.js";
import type { MethodComparison } from "../sandbox/method-comparison.js";
import type { AnswerIntent, EngineAnalysis } from "../types.js";
import { isMetaFinding } from "./answer-shape.js";

export interface MethodNote {
  readonly name: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly preprocessing?: readonly string[];
  readonly comparison?: MethodComparison;
}

/** The one semantic selection handed to every answer writer. */
export interface PresentationPlan {
  readonly shape: AnswerIntent["shape"];
  readonly lead: VerifiedFinding | null;
  readonly support: readonly VerifiedFinding[];
  readonly caveats: readonly Caveat[];
  readonly showEvidenceTable: boolean;
  readonly method?: MethodNote;
}

function subjectOf(finding: VerifiedFinding): string {
  return (finding.subjectRef?.entityLabel ?? finding.subjectRef?.metric ?? finding.subject).trim().toLowerCase();
}

const SHAPE_TYPES: Readonly<Record<AnswerIntent["shape"], readonly VerifiedFinding["findingType"][]>> = {
  direct: ["extremum", "change", "value", "trend"], ranking: ["ranking", "extremum", "change"], comparison: ["comparison", "change", "trend"],
  exploratory: ["anomaly", "relationship", "data_quality", "event", "distribution"], grouping: ["cluster"], overview: ["table_overview"],
};
const SHAPE_LIMITS: Readonly<Record<AnswerIntent["shape"], number>> = { direct: 1, ranking: 3, comparison: 3, exploratory: 5, grouping: 4, overview: 2 };
function rankPosition(finding: VerifiedFinding): number | null {
  const rank = finding.materiality.find((signal) => signal.kind === "rank");
  return rank && rank.kind === "rank" ? rank.position : null;
}
function relevanceOf(finding: VerifiedFinding, analysis: EngineAnalysis, intent: AnswerIntent): number {
  let score = 0;
  if (finding.provenance.resultRef === analysis.primary.resultId) score += 100;
  if (SHAPE_TYPES[intent.shape].includes(finding.findingType)) score += 30;
  if (intent.direction !== null) {
    if (finding.direction === intent.direction) score += 40;
    else if (finding.direction === "up" || finding.direction === "down") score -= 60;
  }
  const position = rankPosition(finding);
  if (position !== null) score += Math.max(0, 20 - position * 4);
  if (isMetaFinding(finding)) score -= 1000;
  return score;
}

function sameSubject(a: VerifiedFinding, b: VerifiedFinding): boolean {
  const left = subjectOf(a);
  const right = subjectOf(b);
  return left !== "" && left === right;
}

function orderFindings(findings: readonly VerifiedFinding[], analysis: EngineAnalysis, intent: AnswerIntent): readonly VerifiedFinding[] {
  return findings
    .map((finding, index) => ({ finding, index, score: relevanceOf(finding, analysis, intent) }))
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .map(({ finding }) => finding);
}

function selectFindings(ordered: readonly VerifiedFinding[], intent: AnswerIntent): readonly VerifiedFinding[] {
  const lead = ordered[0];
  if (!lead) return [];
  if (intent.shape === "direct") {
    const second = ordered[1];
    return second && sameSubject(lead, second) ? [lead, second] : [lead];
  }
  const limit = intent.shape === "ranking" ? (intent.count ?? SHAPE_LIMITS.ranking) : SHAPE_LIMITS[intent.shape];
  return ordered.slice(0, Math.max(1, limit));
}

export function suppressRedundantSubjects(findings: readonly VerifiedFinding[]): readonly VerifiedFinding[] {
  const seen = new Map<string, boolean>();
  return findings.filter((finding) => {
    const subject = subjectOf(finding);
    const informative = /\d/u.test(finding.statement);
    if (subject === "") return true;
    const previousInformative = seen.get(subject);
    if (previousInformative === undefined) {
      seen.set(subject, informative);
      return true;
    }
    if (informative && !previousInformative) {
      seen.set(subject, true);
      return true;
    }
    return informative;
  });
}

function caveatsFor(findings: readonly VerifiedFinding[], shortfall: Caveat | null): readonly Caveat[] {
  const out: Caveat[] = shortfall ? [shortfall] : [];
  const seen = new Set<string>(shortfall ? [`${shortfall.code}:${shortfall.detail ?? ""}`] : []);
  for (const finding of findings) {
    for (const caveat of finding.caveats) {
      const key = `${caveat.code}:${caveat.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(caveat);
    }
  }
  return out.slice(0, 3);
}

function rankingShortfall(
  ordered: readonly VerifiedFinding[],
  selected: readonly VerifiedFinding[],
  intent: AnswerIntent,
): Caveat | null {
  if (intent.shape !== "ranking" || intent.count === null) return null;
  const candidates = ordered.filter((finding) => subjectOf(finding) !== "");
  if (selected.length >= intent.count || candidates.length >= intent.count) return null;
  return { code: "ranking_short_of_requested", detail: `${candidates.length} / ${intent.count}` };
}

function evidenceTableFor(analysis: EngineAnalysis, intent: AnswerIntent, selectedCount: number): boolean {
  if (intent.shape === "direct" || intent.shape === "overview") return false;
  if (intent.wantsTable) return true;
  if (intent.shape !== "ranking") return false;
  const numericColumns = analysis.primary.fields.filter((field) => field.kind === "number").length;
  return selectedCount >= 3 && numericColumns >= 2 && analysis.primary.rows.length >= selectedCount;
}

/**
 * Selects the complete presentation once. Writers must only render this plan.
 * The request text is intentionally absent from this API.
 */
export function planPresentation(
  analysis: EngineAnalysis,
  findings: readonly VerifiedFinding[],
  answerIntent: AnswerIntent,
  method?: MethodNote,
): PresentationPlan {
  const candidates = findings.filter((finding) => !isMetaFinding(finding));
  const ordered = orderFindings(suppressRedundantSubjects(candidates.length > 0 ? candidates : findings), analysis, answerIntent);
  const selected = selectFindings(ordered, answerIntent);
  const [lead, ...support] = selected;
  return {
    shape: answerIntent.shape,
    lead: lead ?? null,
    support,
    caveats: caveatsFor(selected, rankingShortfall(ordered, selected, answerIntent)),
    showEvidenceTable: evidenceTableFor(analysis, answerIntent, selected.length),
    ...(method ? { method } : {}),
  };
}
