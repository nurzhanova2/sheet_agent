import type { EngineAnalysis } from "../types.js";

// A word that opens an analytical ask, in either language. Counting these is a
// structural signal ("do X and also Y"), not a catalogue of supported
// sentences: any verb in the list opens a clause wherever it appears.
const ASK_TRIGGER_RE =
  /(?<![\p{L}])(?:покажи|найди|скажи|назови|объясни|поясни|расскажи|укажи|сравни|определи|выведи|посчитай|when|where|which|what|how|explain|show|tell|find|compare|identify|determine|list)(?![\p{L}])/giu;

const MAX_CLAUSES = 4;

/** §23 — 1–4 distinct analytical asks in the sentence. */
export function countAsks(text: string): number {
  const matches = text.match(ASK_TRIGGER_RE) ?? [];
  return Math.max(1, Math.min(MAX_CLAUSES, matches.length || 1));
}

export interface CoverageResult {
  readonly ok: boolean;
  readonly asks: number;
  readonly named: number;
  readonly detail?: string;
}

/**
 * §23 — a completion covers the request when it names at least as many
 * distinct results as the sentence has asks. An answer whose parts genuinely
 * come from ONE result (a single event row that carries both "which period"
 * and "how much") is accepted: only a demonstrably thinner completion fails.
 */
export function verifyCoverage(request: string, analysis: EngineAnalysis): CoverageResult {
  const asks = countAsks(request);
  if (asks < 2) return { ok: true, asks, named: 1 + analysis.supporting.length };
  const named = 1 + analysis.supporting.length;
  if (named >= asks) return { ok: true, asks, named };
  // A compound ask answered from a single EVENT still covers "what" and
  // "when" — the event row carries both, so it is not a thin completion.
  if (analysis.primary.type === "event" && asks === 2) return { ok: true, asks, named };
  return { ok: false, asks, named, detail: `the request has ${asks} parts but the completion names ${named} result(s)` };
}
