import type { NumberLocale } from "../../analysis/format-number.js";
import type { VerifiedFinding } from "../insight/verified-finding.js";
import { isReadableLabel, normalizeLabel, subjectLabel, subjectNames } from "../insight/finding-subject.js";
import { RECOMMENDATION_REQUESTED } from "./answer-shape.js";

export type AnswerIssue =
  | "TASK_NOT_FULFILLED"
  | "NO_DIRECT_ANSWER"
  | "SUBJECT_UNGROUNDED"
  | "NOT_HUMAN_READABLE"
  | "RAW_RESULT_DUMP"
  | "EMPTY_ANALYST_SPEAK"
  | "UNSUPPORTED_RECOMMENDATION";

export interface AnswerIssueDetail {
  readonly issue: AnswerIssue;
  readonly evidence?: string;
}

export interface AnswerEvaluation {
  readonly accept: boolean;
  readonly issues: readonly AnswerIssue[];
  readonly details: readonly AnswerIssueDetail[];
  readonly rewriteGuidance: string;
  readonly unnamedSubjectClaims: number;
}

export interface EvaluationInput {
  readonly answer: string;
  readonly findings: readonly VerifiedFinding[];
  readonly request: string;
  readonly locale: NumberLocale;
  readonly hasResults: boolean;
}

const NEWLINE = String.fromCharCode(10);
const LEAD_CHARS = 48;

const FIGURE = new RegExp(String.raw`-?\d[\d\u00a0\u202f ]*(?:[.,]\d+)?\s*%?`, "gu");

const GENERIC_HEAD = new RegExp(
  String.raw`(?:^|[.!?;:,(]|\s)(?:показател[ьия]|продукт[аы]?|позици[яи]|значени[ея]|метрик[аи]|строк[аи]|элемент[аы]?|объект[аы]?|item|value|metric|product|row|entity|record)(?![\p{L}])[^.!?;,]{0,32}$`,
  "iu",
);

const IDENTITY_QUESTION = new RegExp(
  String.raw`(?:^|[^\p{L}])(?:кто|котор\p{L}*|как[аоиуе]\p{L}*|чей|чья|у\s+кого|где\s+больше|what\s+(?:entity|product|metric)|which|who)(?![\p{L}])`,
  "iu",
);

const PREAMBLE =
  /^(?:я\s+)?(?:проанализирова\p{L}*|рассмотре\p{L}*|изучи\p{L}*|посмотре\p{L}*|провё?л\p{L}*|выполни\p{L}*|рассчита\p{L}*|для\s+анализа|в\s+ходе\s+анализа|итак|давайте)|^(?:i\s+)?(?:analy[sz]ed|reviewed|examined|looked\s+at|performed|ran)\b/iu;

const SUGGESTION_MODAL =
  /(?:рекомендуетс\p{L}*|рекомендую|советую|предлагаю|стоит|следует|имеет\s+смысл|полезно|осмысленно|не\s+помешает|было\s+бы\s+полезно|можно\s+(?:было\s+бы\s+)?(?:дополнительно\s+)?|нужно|warrants|we\s+recommend|it\s+is\s+recommended|you\s+(?:should|could|may\s+want\s+to)|consider|worth|it\s+would\s+be\s+useful)/iu;

const INVESTIGATION_VERB =
  /(?:провер\p{L}*|посмотр\p{L}*|взглян\p{L}*|изуч\p{L}*|рассмотр\p{L}*|проанализир\p{L}*|исследов\p{L}*|уточн\p{L}*|сверит\p{L}*|сверь\p{L}*|сверя\p{L}*|сопостав\p{L}*|обратить\s+внимание|копн\p{L}*|углуб\p{L}*|детальн\p{L}*|дальше|далее|check\p{L}*|review\p{L}*|examin\p{L}*|investigat\p{L}*|look\s+(?:at|into)|explor\p{L}*|analy[sz]\p{L}*|further|next)/iu;

function isRecommendation(sentence: string): boolean {
  return SUGGESTION_MODAL.test(sentence) && INVESTIGATION_VERB.test(sentence);
}

const FILLER =
  /(?:демонстрир\p{L}*\s+(?:интересн\p{L}*|определё?нн\p{L}*)|наблюда\p{L}*\s+(?:определё?нн\p{L}*|некотор\p{L}*)|заслуживает\s+внимания|интересн\p{L}*\s+динамик\p{L}*|определё?нн\p{L}*\s+различия|есть\s+некоторые\s+различия|interesting\s+dynamics|certain\s+differences|worth\s+(?:attention|noting)|notable\s+patterns)/iu;

const INTERNAL_HANDLE = /(?:\bresult_\d+\b|\bfinding_\d+\b|\bout\d+\b|\bdf\[|NameError|TypeError|ValueError|KeyError|SyntaxError|Traceback|IndexError|AttributeError)/u;

const JSON_SHAPE = /[{[]\s*"/u;

const FULL_PRECISION = /\d[.,]\d{6,}/u;

const VALIDATOR_CODE = /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/u;

const DELIMITED = /[|\t]|\s{4,}/u;

const BARE_FIGURE_LIST = new RegExp(String.raw`(?:-?\d[\d\u00a0\u202f ]*(?:[.,]\d+)?\s*%?\s*[,;]\s*){2,}-?\d`, "u");

function sentencesOf(answer: string): readonly string[] {
  return answer.split(/(?<=[.!?])\s+|\n+/u).filter((s) => s.trim() !== "");
}

function knownSubjects(findings: readonly VerifiedFinding[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const finding of findings) {
    const candidates = [...subjectNames(finding.subjectRef), finding.subject, ...(finding.counterparts ?? [])];
    for (const candidate of candidates) {
      if (isReadableLabel(candidate)) out.add(normalizeLabel(candidate));
    }
  }
  return out;
}

function mentionsKnown(text: string, known: ReadonlySet<string>): boolean {
  const haystack = normalizeLabel(text);
  for (const name of known) {
    if (name.length >= 2 && haystack.includes(name)) return true;
  }
  return false;
}

function lastClause(lead: string): string {
  const parts = lead.split(/[.!?;,]/u);
  return parts[parts.length - 1] ?? lead;
}

function countFigures(text: string): number {
  return (text.match(/-?\d[\d\u00a0\u202f ]*(?:[.,]\d+)?/gu) ?? []).length;
}

function countWords(text: string): number {
  return (text.match(/\p{L}{3,}/gu) ?? []).length;
}

function unnamedSubjectSpans(answer: string, known: ReadonlySet<string>): readonly string[] {
  if (known.size < 2) return [];
  const spans: string[] = [];
  for (const match of answer.matchAll(FIGURE)) {
    const at = match.index ?? 0;
    const lead = answer.slice(Math.max(0, at - LEAD_CHARS), at);
    if (!GENERIC_HEAD.test(lead)) continue;
    if (mentionsKnown(lastClause(lead), known)) continue;
    spans.push(`${lastClause(lead).trim()} ${match[0].trim()}`.trim());
  }
  return spans;
}

export function evaluateAnswer(input: EvaluationInput): AnswerEvaluation {
  const details: AnswerIssueDetail[] = [];
  const answer = input.answer.trim();
  const sentences = sentencesOf(answer);
  const known = knownSubjects(input.findings);

  if (answer === "") {
    details.push({ issue: "TASK_NOT_FULFILLED" });
  } else if (input.hasResults && input.findings.length === 0) {
    details.push({ issue: "TASK_NOT_FULFILLED", evidence: "no verified observation backs this answer" });
  } else if (IDENTITY_QUESTION.test(input.request) && known.size > 0 && !mentionsKnown(answer, known)) {
    details.push({ issue: "TASK_NOT_FULFILLED", evidence: "the question asks which entity, and no entity from the evidence is named" });
  }

  const opening = sentences[0] ?? "";
  if (sentences.length > 1 && PREAMBLE.test(opening.trim()) && countFigures(opening) === 0 && !mentionsKnown(opening, known)) {
    details.push({ issue: "NO_DIRECT_ANSWER", evidence: opening.trim().slice(0, 120) });
  }

  const unnamed = unnamedSubjectSpans(answer, known);
  for (const span of unnamed) details.push({ issue: "SUBJECT_UNGROUNDED", evidence: span });

  const leak = INTERNAL_HANDLE.exec(answer) ?? JSON_SHAPE.exec(answer) ?? FULL_PRECISION.exec(answer) ?? VALIDATOR_CODE.exec(answer);
  if (leak) details.push({ issue: "NOT_HUMAN_READABLE", evidence: leak[0] });

  const readout = BARE_FIGURE_LIST.exec(answer);
  if (readout) details.push({ issue: "NOT_HUMAN_READABLE", evidence: readout[0].slice(0, 80) });

  const recordLines = answer.split(NEWLINE).filter((line) => DELIMITED.test(line) && countFigures(line) >= 2);
  if (recordLines.length >= 2) {
    const prose = answer
      .split(NEWLINE)
      .filter((line) => !recordLines.includes(line))
      .join(" ");
    if (!mentionsKnown(prose, known) && countWords(prose) < 8) {
      details.push({ issue: "RAW_RESULT_DUMP", evidence: recordLines[0]!.slice(0, 120) });
    }
  }

  const filler = sentences.find((s) => FILLER.test(s) && countFigures(s) === 0 && !mentionsKnown(s, known));
  if (filler) details.push({ issue: "EMPTY_ANALYST_SPEAK", evidence: filler.trim().slice(0, 160) });

  if (!RECOMMENDATION_REQUESTED.test(input.request)) {
    const advice = sentences.find((s) => isRecommendation(s));
    if (advice) details.push({ issue: "UNSUPPORTED_RECOMMENDATION", evidence: advice.trim().slice(0, 160) });
  }

  const issues = [...new Set(details.map((d) => d.issue))];
  return {
    accept: details.length === 0,
    issues,
    details,
    rewriteGuidance: buildRewriteGuidance(details, input.findings, input.locale),
    unnamedSubjectClaims: unnamed.length,
  };
}

const ISSUE_RU: Record<AnswerIssue, string> = {
  TASK_NOT_FULFILLED: "ответ не решает поставленную задачу",
  NO_DIRECT_ANSWER: "ответ начинается с описания процесса, а не с вывода",
  SUBJECT_UNGROUNDED: "число названо без объекта: поставь название из таблицы вместо общего слова",
  NOT_HUMAN_READABLE: "в ответе техническая запись, которую читатель не должен видеть",
  RAW_RESULT_DUMP: "это выгрузка таблицы, а не ответ",
  EMPTY_ANALYST_SPEAK: "общие слова без конкретного наблюдения",
  UNSUPPORTED_RECOMMENDATION: "рекомендация ничем не подтверждена и её не просили — убери её",
};

const ISSUE_EN: Record<AnswerIssue, string> = {
  TASK_NOT_FULFILLED: "the answer does not perform the task that was asked",
  NO_DIRECT_ANSWER: "the answer opens with process description instead of the conclusion",
  SUBJECT_UNGROUNDED: "a figure is given with no subject: name the entity from the table, not a common noun",
  NOT_HUMAN_READABLE: "the answer contains internal notation a reader should never see",
  RAW_RESULT_DUMP: "this is the table read aloud, not an answer",
  EMPTY_ANALYST_SPEAK: "generic phrasing with no concrete observation behind it",
  UNSUPPORTED_RECOMMENDATION: "the recommendation is unsupported and was not asked for — remove it",
};

export function availableNames(findings: readonly VerifiedFinding[]): readonly string[] {
  const names = findings.map((f) => subjectLabel(f.subjectRef, f.subject)).filter((n) => isReadableLabel(n));
  return [...new Set(names)].slice(0, 20);
}

export function buildRewriteGuidance(
  details: readonly AnswerIssueDetail[],
  findings: readonly VerifiedFinding[],
  locale: NumberLocale,
): string {
  if (details.length === 0) return "";
  const ru = locale === "ru";
  const lines: string[] = [
    ru ? "Перепиши ТОЛЬКО текст ответа. Расчёты не меняй и не пересчитывай." : "Rewrite ONLY the text of the answer. Do not change or recompute the analysis.",
  ];
  const seen = new Set<AnswerIssue>();
  for (const detail of details) {
    if (seen.has(detail.issue)) continue;
    seen.add(detail.issue);
    const text = ru ? ISSUE_RU[detail.issue] : ISSUE_EN[detail.issue];
    lines.push(detail.evidence ? `- ${text} — «${detail.evidence}»` : `- ${text}`);
  }
  const names = availableNames(findings);
  if (names.length > 0) {
    lines.push("", ru ? "Названия, которыми можно пользоваться:" : "The names you may use:", names.join(", "));
  }
  lines.push("", ru ? "Не добавляй новых чисел и не делай выводов о причинах." : "Do not introduce new numbers and do not claim causes.");
  return lines.join(NEWLINE);
}
