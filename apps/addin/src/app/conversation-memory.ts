import type { CellValue } from "@sheet-agent/application";
import type { ResponseLanguage } from "./language.js";
import { nextId } from "./agent-session.js";
import { extractEntitySet } from "./entity-reference.js";
import {
  MEMORY_LIMITS,
  type ChartRef,
  type ConversationRoute,
  type PendingClarification,
  type ResultKind,
  type ResultRef,
  type RowSetRef,
  type SessionMemory,
  type SheetRef,
} from "./session-memory.js";

export function emptySessionMemory(): SessionMemory {
  return { recentResults: [], seq: 0, knownIds: [] };
}

function pushKnownId(ids: readonly string[], id: string): readonly string[] {
  return [...ids, id].slice(-MEMORY_LIMITS.maxKnownIds);
}

type ResultInput = Omit<ResultRef, "id" | "order" | "createdAt">;
type RowSetInput = Omit<RowSetRef, "id" | "order" | "createdAt">;
type ChartInput = Omit<ChartRef, "id" | "order" | "createdAt">;
type SheetInput = Omit<SheetRef, "id" | "order" | "createdAt">;

/** Persists a structured analytical result, clamped to the row/column caps, evicting the oldest. */
export function rememberResult(memory: SessionMemory, input: ResultInput): SessionMemory {
  const seq = memory.seq + 1;
  const id = nextId("res");
  const rows = input.rows.slice(0, MEMORY_LIMITS.maxRowsPerResult).map((row) => row.slice(0, MEMORY_LIMITS.maxColumnsPerResult));
  const columns = input.columns.slice(0, MEMORY_LIMITS.maxColumnsPerResult);
  // Stage 24.5 §2 — retain a clear entity column + canonical values so a later
  // "выдели их" grounds from structured state, never from rendered markdown.
  const explicitEntity = input.entityColumn && input.entityValues && input.entityValues.length > 0;
  const es = explicitEntity ? null : extractEntitySet({ columns, rows });
  const ref: ResultRef = {
    ...input,
    id,
    order: seq,
    createdAt: Date.now(),
    columns,
    rows,
    rowsTruncated: input.rowsTruncated || input.rows.length > rows.length,
    ...(es && es.kind === "set" ? { entityColumn: es.column, entityValues: es.values } : {}),
  };
  const recentResults = [...memory.recentResults, ref].slice(-MEMORY_LIMITS.maxResults);
  return {
    ...memory,
    recentResults,
    lastResultId: id,
    seq,
    knownIds: pushKnownId(memory.knownIds, id),
  };
}

/** Persists a deterministic transform of an earlier result as a NEW derived ResultRef (24.2B lineage). */
export function rememberDerivedResult(
  memory: SessionMemory,
  parent: ResultRef,
  derived: {
    readonly columns: readonly string[];
    readonly rows: readonly (readonly CellValue[])[];
    readonly kind: ResultKind;
    readonly title: string;
    readonly transform: unknown;
  },
): SessionMemory {
  return rememberResult(memory, {
    turnId: nextId("turn"),
    kind: derived.kind,
    title: derived.title,
    spec: derived.transform,
    columns: derived.columns,
    rows: derived.rows,
    rowsTruncated: false,
    facts: parent.facts,
    sourceSheet: parent.sourceSheet,
    sourceRange: parent.sourceRange,
    sourceVersion: parent.sourceVersion,
    resolved: parent.resolved,
    derivedFromResultId: parent.id,
    transform: derived.transform,
  });
}

export function rememberRowSet(memory: SessionMemory, input: RowSetInput): SessionMemory {
  const seq = memory.seq + 1;
  const id = nextId("rows");
  const ref: RowSetRef = { ...input, id, order: seq, createdAt: Date.now() };
  return { ...memory, lastRowSet: ref, seq, knownIds: pushKnownId(memory.knownIds, id) };
}

export function rememberChart(memory: SessionMemory, input: ChartInput): SessionMemory {
  const seq = memory.seq + 1;
  const id = nextId("cht");
  const ref: ChartRef = { ...input, id, order: seq, createdAt: Date.now() };
  return { ...memory, lastChart: ref, seq, knownIds: pushKnownId(memory.knownIds, id) };
}

export function rememberSheet(memory: SessionMemory, input: SheetInput): SessionMemory {
  const seq = memory.seq + 1;
  const id = nextId("sht");
  const ref: SheetRef = { ...input, id, order: seq, createdAt: Date.now() };
  return { ...memory, lastCreatedSheet: ref, seq, knownIds: pushKnownId(memory.knownIds, id) };
}

/** Returns a shallow copy of `obj` with the given keys removed (respects exactOptionalPropertyTypes). */
function withoutKeys<T extends object>(obj: T, keys: readonly (keyof T)[]): T {
  const copy = { ...obj } as Record<string, unknown>;
  for (const key of keys) delete copy[key as string];
  return copy as T;
}

export function setClarification(memory: SessionMemory, clarification: PendingClarification): SessionMemory {
  return { ...memory, pendingClarification: clarification };
}

export function clearClarification(memory: SessionMemory): SessionMemory {
  return memory.pendingClarification ? withoutKeys(memory, ["pendingClarification"]) : memory;
}

/** Undo reconciliation — a `sheet` undo removed a worksheet SheetAgent created. */
export function forgetSheet(memory: SessionMemory, sheetName: string): SessionMemory {
  const lc = sheetName.toLowerCase();
  let next: SessionMemory = {
    ...memory,
    recentResults: memory.recentResults.filter((r) => r.sourceSheet.toLowerCase() !== lc),
  };
  if (next.lastCreatedSheet && next.lastCreatedSheet.name.toLowerCase() === lc) {
    next = withoutKeys(next, ["lastCreatedSheet"]);
  }
  if (next.lastResultId && !next.recentResults.some((r) => r.id === next.lastResultId)) {
    next = withoutKeys(next, ["lastResultId"]);
  }
  return next;
}

/** Undo reconciliation — a `shape` undo removed an inserted chart image. */
export function forgetChartPlacement(memory: SessionMemory, shapeName: string): SessionMemory {
  if (!memory.lastChart?.placed || memory.lastChart.placed.shapeName !== shapeName) return memory;
  return { ...memory, lastChart: withoutKeys(memory.lastChart, ["placed"]) };
}

// --- reference resolution ---------------------------------------------------

export type ReferenceTarget =
  | { readonly kind: "result"; readonly ref: ResultRef }
  | { readonly kind: "rowset"; readonly ref: RowSetRef }
  | { readonly kind: "chart"; readonly ref: ChartRef }
  | { readonly kind: "sheet"; readonly ref: SheetRef };

export type ReferenceWhat = "result" | "rowset" | "chart" | "sheet";

export type ReferenceResolution =
  | { readonly kind: "resolved"; readonly phrase: string; readonly target: ReferenceTarget }
  | { readonly kind: "ambiguous"; readonly phrase: string; readonly candidates: readonly ReferenceTarget[] }
  | { readonly kind: "evicted"; readonly phrase: string; readonly what: ReferenceWhat }
  | { readonly kind: "none" };

// `\b` is ASCII-only in JS regex — the RU alternatives are matched without it.
// A chart / row-set / sheet reference needs a DEMONSTRATIVE ("that", "the",
// "этот", …) — a bare "a chart" is not a reference to an existing one.
const CHART_RE = /(that|this|the)\s+chart|(этот|тот|это|эту|ту)\s+(график|диаграмм[ауеыой])/i;
const ROWS_EXPLICIT_RE = /(those|these)\s+rows|(те|эти)\s+(строк[аеиуы]?|записи)/i;
const SHEET_RE = /(the\s+new\s+sheet|that\s+sheet|\bthere\b)|нов[ыа][йя]\s+лист|этот\s+лист|\bтуда\b/i;
// Generic reference — could be a result, a row-set or a chart; the most recent wins.
const GENERIC_RE =
  /(that|this)\s+(result|table)|the\s+(previous\s+)?result|\bthat\b|\bit\b|\bthose\b|\bthem\b|(этот|тот)\s+результат|(эта|та)\s+таблица|предыдущ\w*\s+результат|\bрезультат\b|\bэто\b|\bих\b|top\s+\d+|топ[-\s]?\d+|перв\w+\s+\d+/i;

function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[0] : null;
}

function hadKind(memory: SessionMemory, prefix: string): boolean {
  return memory.knownIds.some((id) => id.startsWith(`${prefix}_`));
}

function lastResult(memory: SessionMemory): ResultRef | undefined {
  return memory.recentResults.find((r) => r.id === memory.lastResultId) ?? memory.recentResults[memory.recentResults.length - 1];
}

/** Resolves a conversational reference against structured memory only. Never scrapes prose. */
export function resolveReference(text: string, memory: SessionMemory): ReferenceResolution {
  const chartPhrase = firstMatch(text, CHART_RE);
  if (chartPhrase) {
    if (memory.lastChart) return { kind: "resolved", phrase: chartPhrase, target: { kind: "chart", ref: memory.lastChart } };
    return hadKind(memory, "cht") ? { kind: "evicted", phrase: chartPhrase, what: "chart" } : { kind: "none" };
  }

  const rowsPhrase = firstMatch(text, ROWS_EXPLICIT_RE);
  if (rowsPhrase) {
    if (memory.lastRowSet) return { kind: "resolved", phrase: rowsPhrase, target: { kind: "rowset", ref: memory.lastRowSet } };
    return hadKind(memory, "rows") ? { kind: "evicted", phrase: rowsPhrase, what: "rowset" } : { kind: "none" };
  }

  const sheetPhrase = firstMatch(text, SHEET_RE);
  if (sheetPhrase) {
    if (memory.lastCreatedSheet) return { kind: "resolved", phrase: sheetPhrase, target: { kind: "sheet", ref: memory.lastCreatedSheet } };
    return hadKind(memory, "sht") ? { kind: "evicted", phrase: sheetPhrase, what: "sheet" } : { kind: "none" };
  }

  const genericPhrase = firstMatch(text, GENERIC_RE);
  if (genericPhrase) {
    const candidates: ReferenceTarget[] = [];
    const res = lastResult(memory);
    if (res) candidates.push({ kind: "result", ref: res });
    if (memory.lastRowSet) candidates.push({ kind: "rowset", ref: memory.lastRowSet });
    if (memory.lastChart) candidates.push({ kind: "chart", ref: memory.lastChart });
    if (candidates.length === 0) {
      return memory.seq > 0 ? { kind: "evicted", phrase: genericPhrase, what: "result" } : { kind: "none" };
    }
    candidates.sort((a, b) => b.ref.order - a.ref.order);
    const [top, second] = candidates;
    if (top && second && top.ref.turnId === second.ref.turnId && top.kind !== second.kind) {
      return { kind: "ambiguous", phrase: genericPhrase, candidates };
    }
    return { kind: "resolved", phrase: genericPhrase, target: top! };
  }

  return { kind: "none" };
}

// --- clarification generation (24.6) ------------------------------------

/** A short human label for a reference candidate — used in the clarification question. */
export function describeReferenceTarget(target: ReferenceTarget): string {
  if (target.kind === "result") return `"${target.ref.title}"`;
  if (target.kind === "rowset") return target.ref.describe ? `the rows where ${target.ref.describe}` : "those rows";
  if (target.kind === "chart") return `the chart "${target.ref.data.title}"`;
  return `the sheet "${target.ref.name}"`;
}

/** Builds a PendingClarification for an ambiguous conversational reference ("show the top 3 from that"). */
export function buildReferenceClarification(
  originalPrompt: string,
  phrase: string,
  candidates: readonly ReferenceTarget[],
  language: ResponseLanguage,
): PendingClarification {
  const labels = candidates.map(describeReferenceTarget);
  const ru = language === "ru";
  return {
    id: nextId("clr"),
    turnId: nextId("turn"),
    createdAt: Date.now(),
    originalPrompt,
    route: "workbook_analysis",
    kind: "reference_ambiguous",
    resolved: [],
    observations: [],
    candidates: labels,
    targetIds: candidates.map((c) => c.ref.id),
    term: phrase,
    question: ru
      ? `Не понял, о каком результате речь: ${labels.join(" или ")}. Какой взять?`
      : `I'm not sure which earlier result you mean — ${labels.join(" or ")}. Which one?`,
    answerShape: "one_of",
  };
}

/** Builds a PendingClarification when a named column matches more than one candidate. */
export function buildColumnClarification(
  originalPrompt: string,
  term: string,
  candidates: readonly string[],
  language: ResponseLanguage,
  opts: { readonly resultId?: string; readonly route?: ConversationRoute } = {},
): PendingClarification {
  const ru = language === "ru";
  return {
    id: nextId("clr"),
    turnId: nextId("turn"),
    createdAt: Date.now(),
    originalPrompt,
    route: opts.route ?? "workbook_analysis",
    kind: "column_ambiguous",
    resolved: [],
    observations: [],
    candidates: [...candidates],
    ...(opts.resultId ? { targetIds: [opts.resultId] } : {}),
    term,
    question: ru
      ? `Уточните столбец «${term}» — подходит несколько: ${candidates.join(", ")}. Какой брать?`
      : `Which "${term}" column do you mean — ${candidates.join(", ")}?`,
    answerShape: "one_of",
  };
}

/**
 * Builds a PendingClarification when `resultToChartData` finds several numeric
 * columns. The answer picks which columns the chart uses; the resume rebuilds
 * ChartData from the SAME ResultRef (24.3.1) — never a fresh workbook query.
 */
export function buildChartColumnsClarification(
  originalPrompt: string,
  question: string,
  candidates: readonly string[],
  resultId: string,
  language: ResponseLanguage,
): PendingClarification {
  return {
    id: nextId("clr"),
    turnId: nextId("turn"),
    createdAt: Date.now(),
    originalPrompt,
    route: "workbook_analysis",
    kind: "chart_columns",
    resolved: [],
    observations: [],
    candidates: [...candidates],
    targetIds: [resultId],
    term: language === "ru" ? "столбцы графика" : "chart columns",
    question,
    answerShape: "one_or_many",
  };
}

/**
 * Stage 24.4 §6 — a bounded agent task paused for a clarification. The answer
 * resumes the SAME `AgentLoopState` (carried in `agentContinuation`); it is
 * never re-routed as a fresh request.
 */
export function buildAgentClarification(
  originalPrompt: string,
  question: string,
  candidates: readonly string[],
  agentContinuation: unknown,
  sourceIdentity: string | undefined,
): PendingClarification {
  return {
    id: nextId("clr"),
    turnId: nextId("turn"),
    createdAt: Date.now(),
    originalPrompt,
    route: "workbook_analysis",
    kind: "agent",
    resolved: [],
    observations: [],
    candidates: [...candidates],
    question,
    answerShape: candidates.length > 0 ? "one_of" : "free",
    agentContinuation,
    ...(sourceIdentity ? { sourceIdentity } : {}),
  };
}

/**
 * Stage 24.5 §15 — a remembered result has two plausible entity columns
 * ("Region | Manager | Mean Variance"). The answer picks the column an entity
 * action (highlight / copy) grounds on; the resume re-runs that action.
 */
export function buildEntityActionClarification(
  originalPrompt: string,
  question: string,
  entityColumns: readonly string[],
  resultId: string,
  entityAction: NonNullable<PendingClarification["entityAction"]>,
  language: ResponseLanguage,
): PendingClarification {
  return {
    id: nextId("clr"),
    turnId: nextId("turn"),
    createdAt: Date.now(),
    originalPrompt,
    route: "workbook_analysis",
    kind: "entity_action",
    resolved: [],
    observations: [],
    candidates: [...entityColumns],
    targetIds: [resultId],
    term: language === "ru" ? "объект выделения" : "target entity",
    question,
    answerShape: "one_of",
    entityAction,
  };
}

/** Builds a PendingClarification when a comparison target matches more than one dataset family. */
export function buildDatasetClarification(
  originalPrompt: string,
  candidates: readonly string[],
  language: ResponseLanguage,
): PendingClarification {
  const ru = language === "ru";
  return {
    id: nextId("clr"),
    turnId: nextId("turn"),
    createdAt: Date.now(),
    originalPrompt,
    route: "workbook_analysis",
    kind: "dataset_ambiguous",
    resolved: [],
    observations: [],
    candidates: [...candidates],
    question: ru
      ? `Нашёл несколько наборов данных: ${candidates.join(", ")}. Какой сравнивать?`
      : `I found more than one dataset that could match: ${candidates.join(", ")}. Which should I compare?`,
    answerShape: "one_of",
  };
}

// --- natural-language undo ------------------------------------------------

const UNDO_RE =
  /^\s*(?:please\s+)?(?:undo|revert|roll\s*back|take\s+back)(?:\s+(?:that|it|this|the\s+last(?:\s+change)?|the\s+last\s+one))?\s*[.!]?\s*$|^\s*(?:отмени(?:ть)?|верни)(?:\s+(?:это|последн(?:ее|юю)(?:\s+изменение)?|как\s+было|назад))?\s*[.!]?\s*$/i;

/** True when the WHOLE message is a request to undo the last change (EN + RU). */
export function isUndoPhrase(text: string): boolean {
  return UNDO_RE.test(text.trim());
}

// --- clarification answers ----------------------------------------------

const CANCEL_RE = /^\s*(?:cancel|never\s*mind|forget\s+it|stop|отмена|не\s+важно|неважно|забудь)\s*[.!]?\s*$/i;
const ALL_RE = /^\s*(?:both|all|all\s+of\s+them|everything|оба|обе|все|всё)\s*[.!]?\s*$/i;

// 24.3.1 — a `chart_columns` answer ("Plan, Fact" / "Plan and Fact" / "план и
// факт" / "оба") is split into base tokens and matched against the actual
// candidate column names (which may be aggregate-prefixed, e.g. "Mean Fact").
const AGG_PREFIX_RE =
  /^(?:mean|average|avg|median|sum|total|min|minimum|max|maximum|count|std|stdev|stddev)\s+/i;
const RU_COLUMN_BASE: Readonly<Record<string, string>> = {
  план: "plan", факт: "fact", выручка: "revenue", доход: "revenue", продажи: "sales",
  отклонение: "variance", разница: "variance", вариация: "variance", цена: "price", количество: "quantity",
};
function chartColumnBase(s: string): string {
  return s.trim().toLowerCase().replace(AGG_PREFIX_RE, "").replace(/[\s%.]+$/, "").trim();
}
function matchChartColumns(answer: string, candidates: readonly string[]): string[] {
  const cleaned = answer.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (ALL_RE.test(cleaned)) return [...candidates];
  // Normalise every conjunction to a comma FIRST — `\b` is ASCII-only, so a
  // space-delimited Cyrillic "и" can never be matched with `\bи\b`.
  const tokens = cleaned
    .replace(/\s+(?:and|plus|и)\s+/gi, ", ")
    .split(/\s*[,&+/]\s*/)
    .map((tkn) => tkn.trim())
    .filter((tkn) => tkn.length > 0);
  const picked: string[] = [];
  for (const raw of tokens) {
    const token = RU_COLUMN_BASE[raw] ?? raw;
    const tb = chartColumnBase(token);
    const hit = candidates.find((c) => {
      const cl = c.toLowerCase();
      const cb = chartColumnBase(c);
      return cl === token || cb === tb || (tb.length >= 3 && (cb.includes(tb) || tb.includes(cb)));
    });
    if (hit && !picked.includes(hit)) picked.push(hit);
  }
  return picked;
}
const ORDINAL_FIRST_RE = /^\s*(?:the\s+)?first(?:\s+one)?\s*$|^\s*1\s*$|^\s*перв(?:ый|ая|ое)\s*$/i;
const ORDINAL_SECOND_RE = /^\s*(?:the\s+)?second(?:\s+one)?\s*$|^\s*2\s*$|^\s*втор(?:ой|ая|ое)\s*$/i;
const ORDINAL_LAST_RE = /^\s*(?:the\s+)?last(?:\s+one)?\s*$|^\s*послед(?:ний|няя|нее)\s*$/i;

export type ClarificationAnswer =
  | { readonly kind: "choice"; readonly choices: readonly string[] }
  | { readonly kind: "cancel" }
  | { readonly kind: "unclear" };

/** Interprets a short user reply as an answer to a pending clarification. */
export function interpretClarificationAnswer(text: string, pending: PendingClarification): ClarificationAnswer {
  const trimmed = text.trim();
  if (CANCEL_RE.test(trimmed)) return { kind: "cancel" };
  const candidates = pending.candidates;

  // 24.4 §7 — an agent clarification resumes the SAME task. Match a listed
  // candidate when the reply names one; otherwise pass the raw reply through as
  // the answer (the agent handles a free-form clarification answer).
  if (pending.kind === "agent") {
    const lc = trimmed.toLowerCase().replace(/[.!?]+$/, "");
    if (lc === "") return { kind: "unclear" };
    const hit = candidates.find((c) => c.toLowerCase() === lc)
      ?? candidates.find((c) => c.toLowerCase().includes(lc) || lc.includes(c.toLowerCase()));
    return { kind: "choice", choices: [hit ?? trimmed] };
  }

  if (candidates.length === 0) return { kind: "unclear" };

  // 24.3.1 — chart-column picks resolve with base-name / RU / multi-token aliasing.
  if (pending.kind === "chart_columns") {
    const picks = matchChartColumns(trimmed, candidates);
    return picks.length > 0 ? { kind: "choice", choices: picks } : { kind: "unclear" };
  }

  if (ALL_RE.test(trimmed)) return { kind: "choice", choices: candidates };
  if (ORDINAL_FIRST_RE.test(trimmed) && candidates[0]) return { kind: "choice", choices: [candidates[0]] };
  if (ORDINAL_SECOND_RE.test(trimmed) && candidates[1]) return { kind: "choice", choices: [candidates[1]] };
  if (ORDINAL_LAST_RE.test(trimmed) && candidates.length > 0) return { kind: "choice", choices: [candidates[candidates.length - 1]!] };

  const lc = trimmed.toLowerCase().replace(/[.!?]+$/, "");
  const exact = candidates.filter((c) => c.toLowerCase() === lc);
  if (exact.length === 1) return { kind: "choice", choices: exact };
  const contains = candidates.filter((c) => c.toLowerCase().includes(lc) || lc.includes(c.toLowerCase()));
  if (contains.length === 1) return { kind: "choice", choices: contains };
  if (contains.length > 1) return { kind: "choice", choices: contains };
  return { kind: "unclear" };
}

// --- model context projection -----------------------------------------

/** The compact PRIOR RESULTS block. Row grids are NOT dumped — refs carry them. */
export function projectMemoryForModel(memory: SessionMemory, language: ResponseLanguage): string {
  const ru = language === "ru";
  const lines: string[] = [];

  if (memory.recentResults.length > 0 || memory.lastRowSet || memory.lastChart || memory.lastCreatedSheet) {
    lines.push(
      ru
        ? "ПРЕДЫДУЩИЕ РЕЗУЛЬТАТЫ (этого диалога — ссылайся по фразе, не повторяй числа заново):"
        : "PRIOR RESULTS (this conversation — reference by phrase, do not restate the numbers):",
    );
    for (const r of memory.recentResults) {
      lines.push(
        `[${r.id}] "${r.title}" · ${r.kind} · ${r.columns.join(" | ")} · ${r.rows.length}${r.rowsTruncated ? "+" : ""} ${ru ? "строк" : "rows"} · ${r.sourceRange}`,
      );
    }
    if (memory.lastRowSet) {
      const rs = memory.lastRowSet;
      lines.push(`[${rs.id}] ${rs.count}${rs.truncated ? "+" : ""} ${ru ? "строк, где" : "rows where"} "${rs.describe}" · ${rs.sourceRange}`);
    }
    if (memory.lastChart) {
      lines.push(`[${memory.lastChart.id}] ${ru ? "график" : "chart"} "${memory.lastChart.data.title}" (${memory.lastChart.data.type})`);
    }
    if (memory.lastCreatedSheet) {
      lines.push(`${ru ? "последний созданный лист" : "last created sheet"}: "${memory.lastCreatedSheet.name}"`);
    }
  }

  if (memory.pendingClarification) {
    const pc = memory.pendingClarification;
    lines.push(
      ru
        ? `ОЖИДАЕТСЯ УТОЧНЕНИЕ: ${pc.question}${pc.candidates.length > 0 ? ` (варианты: ${pc.candidates.join(", ")})` : ""}`
        : `AWAITING YOUR CLARIFICATION: ${pc.question}${pc.candidates.length > 0 ? ` (candidates: ${pc.candidates.join(", ")})` : ""}`,
    );
  }

  return lines.join("\n");
}
