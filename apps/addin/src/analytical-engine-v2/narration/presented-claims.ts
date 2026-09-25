import type { NumberLocale } from "../../analysis/format-number.js";
import { caveatProvenance, caveatText, type VerifiedFinding } from "../insight/verified-finding.js";
import { checkCausalLanguage } from "./narration-verifier.js";
import { evaluateAnswer } from "./answer-evaluator.js";

export interface PresentedViolations {
  readonly unnamedSubjectClaimsPresented: number;
  readonly unsupportedCausalClaimsPresented: number;
  readonly unsupportedRecommendationsPresented: number;
  readonly rawEvidenceDumpsPresented: number;
  readonly causalSpans: readonly string[];
}

export function engineCaveatSentences(findings: readonly VerifiedFinding[], locale: NumberLocale): readonly string[] {
  const out = new Set<string>();
  for (const finding of findings) {
    for (const caveat of finding.caveats) {
      if (caveatProvenance(caveat) !== "engine_verified") continue;
      out.add(caveatText(caveat, locale));
    }
  }
  return [...out];
}

export function withoutEngineCaveats(text: string, findings: readonly VerifiedFinding[], locale: NumberLocale): string {
  let stripped = text;
  for (const sentence of engineCaveatSentences(findings, locale)) {
    if (sentence.trim() === "") continue;
    stripped = stripped.split(sentence).join(" ");
  }
  return stripped;
}

export interface PresentedScanInput {
  readonly text: string;
  readonly findings: readonly VerifiedFinding[];
  readonly request: string;
  readonly locale: NumberLocale;
  readonly hasResults: boolean;
}

export function scanPresented(input: PresentedScanInput): PresentedViolations {
  const evaluation = evaluateAnswer({
    answer: input.text,
    findings: input.findings,
    request: input.request,
    locale: input.locale,
    hasResults: input.hasResults,
  });
  const causalText = withoutEngineCaveats(input.text, input.findings, input.locale);
  const causalSpans = checkCausalLanguage(causalText, input.locale);
  return {
    unnamedSubjectClaimsPresented: evaluation.unnamedSubjectClaims,
    unsupportedCausalClaimsPresented: causalSpans.length,
    unsupportedRecommendationsPresented: evaluation.details.filter((d) => d.issue === "UNSUPPORTED_RECOMMENDATION").length,
    rawEvidenceDumpsPresented: evaluation.details.filter((d) => d.issue === "RAW_RESULT_DUMP").length,
    causalSpans,
  };
}
