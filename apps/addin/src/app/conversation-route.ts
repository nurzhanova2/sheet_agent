// ---------------------------------------------------------------------------
// Stage 24.3 — the conversational router.
//
// Decides, for a NON-slash turn, whether SheetAgent should answer as ordinary
// chat or reach for the workbook — and, when it does, whether the current
// selection is enough or the bounded workbook map is needed.
//
// Rules-first (this module): deterministic lexical rules + the existing
// `classifyIntent` lexicon + conversational memory. A model classification
// call is only a documented fallback for genuinely ambiguous turns and is NOT
// made here — the caller may add one later without changing these rules.
//
// `\b` / `\w` are ASCII-only in JS regex — every Russian alternative below is
// written with explicit Cyrillic character classes and no `\b`.
// ---------------------------------------------------------------------------

import { classifyIntent } from "./intent.js";
import type { ConversationRoute } from "./session-memory.js";

export interface RouteContext {
  /** A workbook range is (or was last) selected. */
  readonly hasSelection: boolean;
  /** Column / sheet names SheetAgent has already resolved this conversation. */
  readonly knownEntities: readonly string[];
  /** At least one structured result is remembered (a follow-up may target it). */
  readonly hasPriorResult: boolean;
}

export interface TurnRoute {
  readonly route: ConversationRoute;
  /** Serialize the workbook selection into the model context for this turn. */
  readonly needsSelection: boolean;
  /** Build the bounded workbook map (cross-sheet reasoning) for this turn. */
  readonly needsWorkbookMap: boolean;
  /** Machine-readable reasons — for the transcript / tests, never shown verbatim. */
  readonly reasons: readonly string[];
}

// A concept / definition / meta question — "what is PD", "explain variance",
// "how does PD differ from LGD", "give me a simple example".
const FILLER = "(?:actually|also|ok(?:ay)?|hmm+|wait|well|but|and|so|hey|please|by the way|btw)[,:\\s]+";
const CONCEPT_RE = new RegExp(
  `^\\s*(?:${FILLER})?(?:what(?:'?s| is| are| do| does| did)|whats|define|explain|describe (?:the concept|what)|how (?:do(?:es)?|is|are|would|can)|why (?:do(?:es)?|is|are)|when (?:do(?:es)?|is|should)|tell me about|give (?:me )?(?:an?|some) (?:example|examples|simple example)|can you explain|difference between)\\b`,
  "i",
);
const CONCEPT_RE_RU =
  /^\s*(?:кстати[,:\s]+|а\s+|и\s+)?(?:что такое|что значит|что означает|объясни|поясни|расскажи (?:о|про|мне о)|чем отлич|в ч[её]м (?:разниц|отлич)|как работает|как считается|зачем|почему|приведи пример|дай пример)/i;

// Deixis that forces a workbook turn even when the sentence opens like a concept
// question ("what is this table about").
const WORKBOOK_DEIXIS_RE =
  /\b(?:this|these|those|that|here|the (?:table|sheet|selection|data|dataset|column|columns|row|rows|range|workbook|file|chart)|my (?:data|table|sheet|workbook|selection|numbers)|selected|current (?:sheet|selection|table))\b/i;
const WORKBOOK_DEIXIS_RE_RU =
  /(?:эт(?:а|у|и|от|о|ой|их)\s+(?:таблиц|лист|данн|столб|колонк|строк|диапазон|книг|файл|график|диаграмм)|здесь|в этой таблице|в этом листе|выделен|текущ(?:ий|ем|ая)\s+(?:лист|выдел|таблиц)|мо(?:и|я|й)\s+(?:данные|таблиц|лист|книг|числ))/i;

// A structural / understanding question about the workbook itself.
const STRUCTURAL_RE =
  /\b(?:what (?:is|are|kind of|type of)|which|what's) (?:this|these|the)?\s*(?:table|sheet|data|dataset|columns?|fields?|rows?)\b|what columns|which columns|what fields|what.s in (?:this|the) (?:sheet|table)|what does (?:this|the) (?:sheet|table|column) (?:contain|hold|have|show)|describe (?:this|the) (?:table|sheet|data|column)|what is this (?:about|for)|what are the (?:important|key|main) columns/i;
const STRUCTURAL_RE_RU =
  /(?:что (?:это |этот |эта |)(?:за )?(?:таблиц|данн|лист|набор данн)|о ч[её]м эт(?:а|от) (?:таблиц|лист)|как(?:ие|ой)\s+(?:здесь |в таблице |)(?:столбц|колонк|поля|данные)|что содержит|что (?:за |)данные (?:здесь|в этой)|опиши (?:эт|таблиц|лист|данные)|какие столбцы (?:важн|ключев|основн))/i;

// An interpretation ask riding alongside a computed request → MIXED.
const INTERPRET_RE =
  /\bwhat (?:does (?:that|this|it) mean|does (?:that|this) imply|are the implications)\b|\bwhy (?:does (?:that|this) matter|would that|might that|is that)\b|\bso what\b|\bis that (?:good|bad|normal|expected|a concern|concerning|healthy)\b|\bwhat should i (?:make of|take from) (?:that|this)\b|\bhow should i read (?:that|this)\b/i;
const INTERPRET_RE_RU =
  /(?:что это (?:значит|означает)|что (?:это |)(?:нам |)говорит|почему это (?:важно|значимо|плохо|хорошо)|это (?:хорошо|плохо|нормально|ожидаемо|тревожн)|как это (?:понимать|трактовать|читать)|о ч[её]м это говорит)/i;

// Workbook mutation phrasing (Increment 2 identifies the route only).
const MUTATION_RE =
  /^\s*(?:please\s+)?(?:add|insert|create|make|write|put|fill|set|enter|append|highlight|colou?r|shade|mark|rename|delete|remove|clear|paste|round|format)\b.{0,48}\b(?:column|columns|row|rows|sheet|tab|cell|cells|range|value|values|formula|formulas|header|headers|total|totals|label)\b|\b(?:add|insert|create|write|fill|set|put) (?:an?|the|a new|another)?\s*(?:column|sheet|row|formula|header|total)\b|\bcreate (?:a )?(?:new )?sheet\b|\bhighlight (?:the )?(?:rows?|cells?|values?)\b|\bsort the (?:table|column|data|range)\b/i;
const MUTATION_RE_RU =
  /(?:^|\s)(?:добав|встав|созда(?:й|ть)|сдела(?:й|ть)|запиш|впиш|введ|зале(?:й|ть)|выдел|подсвет|закрас|отмет|переименуй|удали|очист|округли|отформатируй)[а-яё]*\s+.{0,48}(?:столб|колонк|строк|лист|вкладк|ячейк|диапазон|значени|формул|заголов|итог|метк)|отсортируй\s+(?:столбец|таблицу|данные|диапазон)/i;

// "which is worst / best / highest / lowest" — a transform over a prior result.
const EXTREME_RE =
  /\bwhich (?:one|row|category|group|item|value|month|year)?\s*(?:is|are|has|had|shows?|comes? out|would be)?\s*(?:the )?(?:worst|best|highest|lowest|largest|smallest|biggest|weakest|strongest|top|bottom|max(?:imum)?|min(?:imum)?)\b|\bwhat(?:'?s| is| was) the (?:worst|best|highest|lowest|largest|smallest|biggest|weakest|strongest)\b/i;
const EXTREME_RE_RU =
  /(?:как(?:ой|ая|ое|ие)|что|кто)\s+(?:из них\s+)?(?:самый|самая|самое|наиболее|наименее|хуже всех|лучше всех|больше всех|меньше всех|худш|лучш|максимальн|минимальн|наибольш|наименьш)/i;
// Stage 24.5.1 — "какой менеджер не выполнил план" is an extreme question over
// the prior grouped result (the manager whose metric is worst / below plan).
const EXTREME_RE_RU_PLAN =
  /(?:как(?:ой|ая|ое|ие)|кто)\s+[а-яё]+\s+(?:не выполнил|недовыполнил|провалил|сработал хуже|ниже план|отста(?:л|ёт|ет)|хуже всех сработал)/i;

// Result-transform verbs ("show only the top 2", "sort by Fact", "keep the first 3").
const TRANSFORM_RE =
  /\b(?:top|bottom|first|last)\s+\d{1,3}\b|\bshow (?:only |just )?(?:the )?(?:top|bottom|first|last)\b|\bsort (?:it |them |that |these |by )|\bre-?sort\b|\border by\b|\bkeep (?:only )?(?:the )?(?:top|first|last)\b|\bnarrow (?:that|it|this) to\b|\bjust the (?:top|first|last)\b/i;
const TRANSFORM_RE_RU =
  /(?:топ|последн[а-яё]*|перв[а-яё]*)[-\s]?\d{1,3}|покажи (?:только |лишь )?(?:топ|перв|последн)|оставь (?:только )?(?:топ|перв|последн)|отсортируй (?:это|их|по)|пересортируй|сначала (?:самые|по)/i;
// Stage 24.5.3 — "show / give me 3 managers with the worst Variance" /
// "покажи 3 менеджеров с худшим Variance": a bare count + a superlative, no
// "top"/"топ" keyword. This is a transform over the last compatible result and
// MUST route through the deterministic transform-persistence seam (so a follow-up
// "выдели их" resolves to it) — never depend on the model returning a structured
// grid. Mirrors BOTTOM_BY_WORST_RE / TOP_BY_BEST_RE in result-transforms.ts.
const NRANK_RE =
  /\b\d{1,3}\s+\p{L}+\s+(?:with|by|having)\s+(?:the\s+)?(?:worst|best|lowest|highest|smallest|largest|weakest|strongest|top|bottom)\b/iu;
const NRANK_RE_RU =
  /\d{1,3}\s+[а-яё]+\s+с\s+(?:худшим|лучшим|наименьшим|наибольшим|наихудшим|наилучшим|минимальным|максимальным|самым низким|самым высоким)/i;

function mentionsKnownEntity(lower: string, entities: readonly string[]): boolean {
  for (const raw of entities) {
    const name = raw.trim().toLowerCase();
    if (name.length >= 3 && lower.includes(name)) return true;
  }
  return false;
}

/** True when the message opens like a definition / concept question. */
export function isConceptQuestion(text: string): boolean {
  return CONCEPT_RE.test(text) || CONCEPT_RE_RU.test(text);
}

/** True when the message points at the workbook ("this table", "здесь", …). */
export function hasWorkbookDeixis(text: string): boolean {
  return WORKBOOK_DEIXIS_RE.test(text) || WORKBOOK_DEIXIS_RE_RU.test(text);
}

/** True when the message asks what the current table / sheet / columns are. */
export function isStructuralQuestion(text: string): boolean {
  return STRUCTURAL_RE.test(text) || STRUCTURAL_RE_RU.test(text);
}

/** True when the message asks for interpretation of a computed result. */
export function isInterpretationAsk(text: string): boolean {
  return INTERPRET_RE.test(text) || INTERPRET_RE_RU.test(text);
}

/** True when the message asks SheetAgent to change the workbook. */
export function isMutationRequest(text: string): boolean {
  return MUTATION_RE.test(text) || MUTATION_RE_RU.test(text);
}

/** True when the message is a "which is worst/best" style ask over a prior result. */
export function isExtremeQuestion(text: string): boolean {
  return EXTREME_RE.test(text) || EXTREME_RE_RU.test(text) || EXTREME_RE_RU_PLAN.test(text);
}

/** True when the message asks to reshape a prior result (top N / sort / subset). */
export function isTransformRequest(text: string): boolean {
  return TRANSFORM_RE.test(text) || TRANSFORM_RE_RU.test(text) || NRANK_RE.test(text) || NRANK_RE_RU.test(text);
}

/**
 * Routes a non-slash turn. Deterministic: the same text + context always yields
 * the same route. Never reads the workbook — the caller acts on `needsSelection`
 * / `needsWorkbookMap`.
 */
export function routeTurn(text: string, ctx: RouteContext): TurnRoute {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const intent = classifyIntent(trimmed);
  const deixis = hasWorkbookDeixis(trimmed);
  const knownEntity = mentionsKnownEntity(lower, ctx.knownEntities);
  const reasons: string[] = [];

  // The lexicon term "mean" also fires on the verb "means / meaning" ("what does
  // LGD mean") — that is not a request for the statistic.
  const meansVerb =
    /\bmean(?:s|ing|t)?\b/i.test(trimmed) &&
    !/\b(?:the|a|arithmetic|average|sample|population|group|overall)\s+mean\b/i.test(trimmed) &&
    !/\bmean\s+(?:of|value|for|per|by)\b/i.test(trimmed);
  const strongAnalytical = intent.analytical && !(meansVerb && intent.matched.every((m) => m === "mean"));

  // 1. GENERAL_CHAT — a concept question with no workbook pull at all.
  if (
    isConceptQuestion(trimmed) &&
    !deixis &&
    !knownEntity &&
    !strongAnalytical &&
    !intent.visualization &&
    !isStructuralQuestion(trimmed) &&
    !isMutationRequest(trimmed)
  ) {
    return {
      route: "general_chat",
      needsSelection: false,
      needsWorkbookMap: false,
      reasons: ["concept-question", "no-workbook-deixis", "no-analytical-lexicon"],
    };
  }

  // 2. WORKBOOK_QA — "what is this table about", "what columns are here".
  if (isStructuralQuestion(trimmed) && !intent.analytical && !intent.visualization) {
    const wantsSheetScope = /\bsheet|worksheet|workbook|tab\b/i.test(lower) || /лист|книг|вкладк/i.test(lower);
    return {
      route: "workbook_qa",
      needsSelection: true,
      needsWorkbookMap: wantsSheetScope && !ctx.hasSelection,
      reasons: ["structural-question"],
    };
  }

  // 3. WORKBOOK_MUTATION — identify only in this increment; the existing safe
  //    mutation path (model → actions → Preview/Approve) is unchanged.
  if (isMutationRequest(trimmed)) {
    return {
      route: "workbook_mutation",
      needsSelection: true,
      needsWorkbookMap: false,
      reasons: ["mutation-verb"],
    };
  }

  // 4. MIXED — a computed request that also asks what it means / why it matters.
  if ((intent.analytical || intent.visualization || knownEntity) && isInterpretationAsk(trimmed)) {
    return {
      route: "mixed",
      needsSelection: true,
      needsWorkbookMap: false,
      reasons: ["analytical-plus-interpretation"],
    };
  }

  // 5. WORKBOOK_ANALYSIS — analytical / visualization lexicon, a transform ask, a
  //    "which is worst" ask, or a cross-sheet comparison.
  const comparison = detectComparison(trimmed);
  // "compare A and B" is usually two metrics on one sheet; only treat it as a
  // cross-sheet task when it names years, uses "between … and …" / "what
  // changed", or names an entity SheetAgent has already resolved.
  const strongComparison =
    comparison !== null &&
    (comparison.phrase === "what changed" ||
      /\bbetween\b|между/i.test(lower) ||
      comparison.targets.every((tok) => /\b(?:19|20)\d{2}\b/.test(tok)) ||
      comparison.targets.some((tok) => ctx.knownEntities.some((e) => e.toLowerCase() === tok.toLowerCase())));
  if (
    intent.analytical ||
    intent.visualization ||
    isTransformRequest(trimmed) ||
    isExtremeQuestion(trimmed) ||
    comparison !== null ||
    (ctx.hasPriorResult && deixis)
  ) {
    if (strongComparison) reasons.push("cross-target-comparison");
    if (isTransformRequest(trimmed) || isExtremeQuestion(trimmed)) reasons.push("result-transform");
    if (intent.analytical) reasons.push("analytical-lexicon");
    if (intent.visualization) reasons.push("visualization-lexicon");
    return {
      route: "workbook_analysis",
      needsSelection: true,
      // Only reach across sheets when two distinct targets are named that the
      // selection cannot both satisfy — the caller confirms against the map.
      needsWorkbookMap: strongComparison,
      reasons: reasons.length > 0 ? reasons : ["analytical-default"],
    };
  }

  // 6. Fallback — anything not positively identified as chat keeps the
  //    pre-Stage-24 behaviour: analyse against the selection. Only rule 1 (a
  //    clear concept question with no workbook pull) diverts to general chat.
  return { route: "workbook_analysis", needsSelection: true, needsWorkbookMap: false, reasons: ["fallback"] };
}

// --- cross-target comparison detection -------------------------------------

export interface ComparisonTargets {
  /** Up to two short target tokens ("2024", "2025", "Portfolio", "Q1"). */
  readonly targets: readonly string[];
  readonly phrase: string;
}

const BETWEEN_RE = /\bbetween\s+([\p{L}\p{N} .'&-]{1,40}?)\s+and\s+([\p{L}\p{N} .'&-]{1,40}?)(?:[.?!,]|$)/iu;
const BETWEEN_RE_RU = /между\s+([\p{L}\p{N} .'&-]{1,40}?)\s+и\s+([\p{L}\p{N} .'&-]{1,40}?)(?:[.?!,]|$)/iu;
const COMPARE_AND_RE =
  /\bcompare\s+([\p{L}\p{N} .'&-]{1,40}?)\s+(?:and|vs\.?|versus|to|with|against)\s+([\p{L}\p{N} .'&-]{1,40}?)(?:[.?!,]|$)/iu;
const COMPARE_AND_RE_RU =
  /сравн[а-яё]*\s+([\p{L}\p{N} .'&-]{1,40}?)\s+(?:и|с|против|со)\s+([\p{L}\p{N} .'&-]{1,40}?)(?:[.?!,]|$)/iu;
const CHANGED_RE =
  /\bwhat (?:changed|is different|has changed)\b/i;
const CHANGED_RE_RU = /что (?:измен|поменял|стало (?:иначе|по-другому)|не так)/i;

function cleanTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:the|a|an|my|our|его|её|наш[а-яё]*)\s+/i, "")
    .replace(/\s+(?:data|table|sheet|numbers|figures|данные|таблиц[а-яё]*|лист[а-яё]*|цифры|показатели)$/i, "")
    .trim();
}

/**
 * Detects "compare A and B" / "what changed between A and B" style asks and
 * extracts up to two target tokens. Returns null when the turn is not a
 * two-target comparison.
 */
export function detectComparison(text: string): ComparisonTargets | null {
  for (const re of [BETWEEN_RE, BETWEEN_RE_RU, COMPARE_AND_RE, COMPARE_AND_RE_RU]) {
    const m = re.exec(text);
    if (m && m[1] && m[2]) {
      const a = cleanTarget(m[1]);
      const b = cleanTarget(m[2]);
      if (a && b && a.toLowerCase() !== b.toLowerCase() && a.length <= 32 && b.length <= 32) {
        return { targets: [a, b], phrase: m[0].trim() };
      }
    }
  }
  // "what changed between 2024 and 2025" is caught above; a bare "what changed"
  // with two year-like tokens anywhere is also a comparison.
  if (CHANGED_RE.test(text) || CHANGED_RE_RU.test(text)) {
    const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((y) => y[0]);
    const uniqueYears = [...new Set(years)];
    if (uniqueYears.length >= 2) return { targets: uniqueYears.slice(0, 2), phrase: "what changed" };
  }
  return null;
}
