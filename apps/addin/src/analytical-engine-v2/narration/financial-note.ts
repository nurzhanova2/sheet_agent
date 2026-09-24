import type { NumberLocale } from "../../analysis/format-number.js";
import { valueOf, type FindingType, type VerifiedFinding } from "../insight/verified-finding.js";
import { statementFor } from "../insight/statement.js";

export interface AnalyticalNoteFact {
  readonly analysisType: FindingType;
  readonly subject: string;
  readonly period?: { readonly start: string; readonly end: string };
  readonly absoluteChange?: string;
  readonly relativeChange?: string;
  readonly score?: string;
  readonly method?: string;
  readonly groupMembers?: readonly string[];
}

export interface AnalyticalNoteStructure {
  readonly lead: AnalyticalNoteFact;
  readonly evidence: readonly AnalyticalNoteFact[];
}

function factOf(finding: VerifiedFinding): AnalyticalNoteFact {
  const start = valueOf(finding, "startValue")?.at;
  const end = valueOf(finding, "endValue")?.at;
  const members = finding.detail?.["members"];
  return {
    analysisType: finding.findingType,
    subject: finding.subject,
    ...(start && end ? { period: { start, end } } : {}),
    ...(valueOf(finding, "absoluteChange") ? { absoluteChange: valueOf(finding, "absoluteChange")!.text } : {}),
    ...(valueOf(finding, "percentageChange") ? { relativeChange: valueOf(finding, "percentageChange")!.text } : {}),
    ...(valueOf(finding, "score") ? { score: valueOf(finding, "score")!.text } : {}),
    ...(typeof finding.detail?.["method"] === "string" ? { method: finding.detail["method"] } : {}),
    ...(Array.isArray(members) && members.every((member) => typeof member === "string") ? { groupMembers: members as readonly string[] } : {}),
  };
}

export function buildAnalyticalNote(findings: readonly VerifiedFinding[]): AnalyticalNoteStructure | null {
  if (findings.length === 0) return null;
  return { lead: factOf(findings[0]!), evidence: findings.map(factOf) };
}

function quoted(subject: string, locale: NumberLocale): string {
  return locale === "ru" ? `«${subject}»` : `"${subject}"`;
}

function volatilityMethod(method: string | undefined, locale: NumberLocale): string {
  if (method === "std_pct_change") return locale === "ru" ? "стандартным отклонением процентных изменений между периодами" : "the standard deviation of percentage changes between periods";
  if (method === "std_level_change") return locale === "ru" ? "стандартным отклонением изменений уровня между периодами" : "the standard deviation of level changes between periods";
  return locale === "ru" ? "разбросом изменений между периодами" : "the dispersion of changes between periods";
}

export function composeFinancialNote(findings: readonly VerifiedFinding[], locale: NumberLocale): readonly string[] | null {
  const note = buildAnalyticalNote(findings);
  if (!note) return null;
  const lead = note.lead;

  if (lead.analysisType === "change" || lead.analysisType === "comparison" || lead.analysisType === "extremum") {
    if (findings.length !== 1 || !lead.period || (!lead.absoluteChange && !lead.relativeChange)) return null;
    const first = statementFor(findings[0]!, locale, { expand: true });
    return [first].filter((part) => part !== "");
  }

  if ((lead.analysisType === "volatility" || lead.analysisType === "stability") && findings.length === 1 && lead.method) {
    if (!lead.score) return null;
    const title = lead.analysisType === "volatility"
      ? (locale === "ru" ? `Наиболее волатильный показатель — ${quoted(lead.subject, locale)}.` : `The most volatile indicator is ${quoted(lead.subject, locale)}.`)
      : (locale === "ru" ? `Наиболее стабильный показатель — ${quoted(lead.subject, locale)}.` : `The steadiest indicator is ${quoted(lead.subject, locale)}.`);
    const evidence = locale === "ru"
      ? `Оценка ${lead.score} рассчитана ${volatilityMethod(lead.method, locale)}.`
      : `Its score of ${lead.score} is calculated using ${volatilityMethod(lead.method, locale)}.`;
    return [title, evidence];
  }

  return null;
}
