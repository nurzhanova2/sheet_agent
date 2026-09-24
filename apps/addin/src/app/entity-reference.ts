import type { CellValue } from "@sheet-agent/application";
import type { ChartRef, ResultRef, RowSetRef, SessionMemory } from "./session-memory.js";

const MAX_ENTITY_VALUES = 50;

// --- entity-set extraction ------------------------------------------------

export type EntitySet =
  | { readonly kind: "set"; readonly column: string; readonly values: readonly CellValue[] }
  | { readonly kind: "ambiguous"; readonly columns: readonly string[] }
  | { readonly kind: "none" };

function asNumber(value: CellValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9eE.,+-]/g, "").replace(",", ".");
    if (cleaned === "" || !/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function columnIsNumeric(rows: readonly (readonly CellValue[])[], c: number): boolean {
  let numbers = 0;
  let total = 0;
  for (const row of rows) {
    const v = row[c];
    if (v === null || v === undefined || v === "") continue;
    total += 1;
    if (asNumber(v) !== null) numbers += 1;
  }
  return total > 0 && numbers / total >= 0.6;
}

function distinctNonEmpty(rows: readonly (readonly CellValue[])[], c: number): CellValue[] {
  const seen = new Set<string>();
  const out: CellValue[] = [];
  for (const row of rows) {
    const v = row[c] ?? null;
    if (v === null || v === "") continue;
    const key = String(v).trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_ENTITY_VALUES) break;
  }
  return out;
}

/**
 * Extracts the entity column + canonical values from a remembered result. Uses
 * the retained `entityColumn` / `entityValues` when present; otherwise derives
 * them deterministically from the structured grid.
 */
export function extractEntitySet(
  ref: Pick<ResultRef, "columns" | "rows"> & {
    readonly entityColumn?: string;
    readonly entityValues?: readonly CellValue[];
  },
): EntitySet {
  if (ref.entityColumn && ref.entityValues && ref.entityValues.length > 0) {
    return { kind: "set", column: ref.entityColumn, values: [...ref.entityValues].slice(0, MAX_ENTITY_VALUES) };
  }
  if (ref.columns.length === 0 || ref.rows.length === 0) return { kind: "none" };

  const labelCols: number[] = [];
  for (let c = 0; c < ref.columns.length; c += 1) {
    if (columnIsNumeric(ref.rows, c)) continue;
    const values = distinctNonEmpty(ref.rows, c);
    if (values.length === 0) continue;
    // A label column has mostly-distinct short text values.
    const avgLen = values.reduce<number>((n, v) => n + String(v).length, 0) / values.length;
    const distinctRatio = values.length / ref.rows.length;
    if (avgLen <= 40 && (distinctRatio >= 0.5 || values.length <= 12)) labelCols.push(c);
  }
  if (labelCols.length === 0) {
    // Fall back to the single non-numeric column if there is exactly one.
    const nonNumeric = ref.columns.map((_, c) => c).filter((c) => !columnIsNumeric(ref.rows, c));
    if (nonNumeric.length === 1) {
      const c = nonNumeric[0]!;
      const values = distinctNonEmpty(ref.rows, c);
      return values.length > 0 ? { kind: "set", column: ref.columns[c]!, values } : { kind: "none" };
    }
    return { kind: "none" };
  }
  if (labelCols.length === 1) {
    const c = labelCols[0]!;
    return { kind: "set", column: ref.columns[c]!, values: distinctNonEmpty(ref.rows, c) };
  }
  return { kind: "ambiguous", columns: labelCols.map((c) => ref.columns[c]!) };
}

// --- conversational reference resolution ---------------------------------

/** A bare pronoun / demonstrative referring to an earlier object (EN + RU). */
const PRONOUN_RE =
  /\b(?:it|them|those|these|that|this|him|her|the (?:result|table|rows|chart|previous result))\b|(?:^|\s)(?:их|его|её|ее|это|эт[иу]|эти строки|этот результат|тот результат|эту таблицу|по ним|по этим)(?:\s|$|[.,!?])/i;

/** True when the message is a bare conversational reference to something earlier. */
export function mentionsConversationalReference(text: string): boolean {
  return PRONOUN_RE.test(text);
}

export type ActionRefKind = "highlight" | "copy" | "chart" | "insert_chart" | "write" | "sort" | "filter";

export type ActionReference =
  | { readonly kind: "result"; readonly ref: ResultRef; readonly entitySet?: EntitySet }
  | { readonly kind: "rowset"; readonly ref: RowSetRef }
  | { readonly kind: "chart"; readonly ref: ChartRef }
  | {
      readonly kind: "clarify";
      readonly question: string;
      readonly candidates: readonly string[];
      readonly resultId?: string;
      readonly entityColumns?: readonly string[];
    }
  | { readonly kind: "none"; readonly reason: "no_object" | "incompatible" | "evicted" };

function lastResult(memory: SessionMemory): ResultRef | undefined {
  return (
    memory.recentResults.find((r) => r.id === memory.lastResultId) ??
    memory.recentResults[memory.recentResults.length - 1]
  );
}

/** A result whose leading title words are quoted verbatim in the message. */
function titleHintedResult(text: string, memory: SessionMemory): ResultRef | undefined {
  const lc = text.toLowerCase();
  return [...memory.recentResults]
    .sort((a, b) => b.order - a.order)
    .find((r) => {
      const key = r.title.toLowerCase().split(/\s+/).slice(0, 2).join(" ");
      return key.length >= 4 && lc.includes(key);
    });
}

/**
 * Resolves a conversational reference for `action`. Compatibility is enforced
 * before recency (§3): a chart is never returned for a highlight, a result is
 * never returned for "insert it".
 */
export function resolveActionReference(
  text: string,
  memory: SessionMemory,
  action: ActionRefKind,
  language: "en" | "ru" = "en",
): ActionReference {
  const ru = language === "ru";
  const hadResult = memory.seq > 0 && memory.knownIds.some((id) => id.startsWith("res_"));

  if (action === "insert_chart") {
    if (memory.lastChart) return { kind: "chart", ref: memory.lastChart };
    return { kind: "none", reason: memory.knownIds.some((id) => id.startsWith("cht_")) ? "evicted" : "no_object" };
  }

  if (action === "chart") {
    // "вставь его" after a chart resolves to the chart even though the verb here
    // is 'chart' only when insertion words are present — handled by insert_chart.
    const explicit = titleHintedResult(text, memory);
    const ref = explicit ?? lastResult(memory);
    if (ref) return { kind: "result", ref };
    return { kind: "none", reason: hadResult ? "evicted" : "no_object" };
  }

  if (action === "write" || action === "sort" || action === "filter") {
    const explicit = titleHintedResult(text, memory);
    const ref = explicit ?? lastResult(memory);
    if (ref) return { kind: "result", ref };
    return { kind: "none", reason: hadResult ? "evicted" : "no_object" };
  }

  // highlight / copy — a concrete set of source rows. Selection follows
  // conversational recency, not a hard RowSet-vs-Result precedence (§4):
  //   1. an explicitly named earlier result ("the top 3 from that")
  //   2. an active RowSetRef — UNLESS a compatible structured result was created
  //      strictly AFTER it, in which case the newer semantic result wins
  //      (Stage 24.5.3: "выдели его" builds RowSet S1 from R1, then "покажи 3 …"
  //      builds R2; "выдели их" must resolve to R2, not S1). The row set is
  //      reused only when nothing newer and compatible exists (§3/§13).
  //   3. otherwise the most recent compatible structured result
  //   4. otherwise clarify / none
  const explicitResult = titleHintedResult(text, memory);
  if (explicitResult) {
    return resultOrClarify(explicitResult, extractEntitySet(explicitResult), ru);
  }
  const activeRowSet =
    memory.lastRowSet && memory.lastRowSet.sheetRows.length > 0 ? memory.lastRowSet : undefined;
  if (activeRowSet) {
    const newer = [...memory.recentResults]
      .filter((r) => r.order > activeRowSet.order && extractEntitySet(r).kind === "set")
      .sort((a, b) => b.order - a.order)[0];
    if (newer) return resultOrClarify(newer, extractEntitySet(newer), ru);
    return { kind: "rowset", ref: activeRowSet };
  }
  const candidate = lastResult(memory);
  if (candidate) {
    return resultOrClarify(candidate, extractEntitySet(candidate), ru);
  }
  return { kind: "none", reason: hadResult ? "evicted" : "no_object" };
}

function resultOrClarify(ref: ResultRef, es: EntitySet, ru: boolean): ActionReference {
  if (es.kind === "ambiguous") {
    return {
      kind: "clarify",
      resultId: ref.id,
      entityColumns: es.columns,
      candidates: [...es.columns],
      question: ru
        ? `Что выделить: ${es.columns.join(" или ")}?`
        : `Which should I act on — ${es.columns.join(" or ")}?`,
    };
  }
  if (es.kind === "none") {
    return {
      kind: "clarify",
      resultId: ref.id,
      candidates: [],
      question: ru
        ? "Не понял, какие именно строки выделить по этому результату. Уточните, пожалуйста."
        : "I couldn't tell which rows to act on from that result. Could you say which?",
    };
  }
  return { kind: "result", ref, entitySet: es };
}
