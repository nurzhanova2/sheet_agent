// ---------------------------------------------------------------------------
// Stage 24.2B — deterministic read-only transforms over a remembered ResultRef.
//
// A follow-up like "show only the top 2 by Fact" or "which one is worst" must be
// answered from the STRUCTURED rows of the earlier result — never by re-parsing
// assistant markdown, and never by the model re-deriving numbers. These pure
// functions take a ResultRef's own `columns` / `rows` and produce a new grid
// plus a plain-language answer; the caller persists the output as a derived
// ResultRef with `derivedFromResultId` lineage.
//
// `\b` is ASCII-only in JS regex — Russian alternatives use explicit classes.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import type { ResultKind, ResultRef } from "./session-memory.js";

export type ResultTransformKind =
  | "top_n"
  | "bottom_n"
  | "head_n"
  | "sort_asc"
  | "sort_desc"
  | "which_extreme"
  | "column_subset";

export interface ResultTransform {
  readonly kind: ResultTransformKind;
  readonly n?: number;
  /** Resolved column name (one of the source result's columns). */
  readonly by?: string;
  /** which_extreme direction. */
  readonly extreme?: "max" | "min";
  /** column_subset — resolved column names to keep. */
  readonly keep?: readonly string[];
  /** The user phrase this was read from (audit / display). */
  readonly phrase: string;
}

export type TransformDetection =
  | { readonly kind: "transform"; readonly transform: ResultTransform }
  | { readonly kind: "column_ambiguous"; readonly term: string; readonly candidates: readonly string[] }
  | { readonly kind: "none" };

export interface AppliedTransform {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
  readonly kind: ResultKind;
  /** Derived result title — no internal terminology. */
  readonly title: string;
  /** One-line natural-language answer for the transcript. */
  readonly answer: string;
  readonly transform: ResultTransform;
}

export type TransformOutcome = AppliedTransform | { readonly error: string };

export function isTransformError(o: TransformOutcome): o is { readonly error: string } {
  return "error" in o;
}

// --- helpers --------------------------------------------------------------


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

/** Indexes of columns whose values are predominantly numeric across the rows. */
function numericColumnIndexes(ref: Pick<ResultRef, "columns" | "rows">): number[] {
  const out: number[] = [];
  for (let c = 0; c < ref.columns.length; c += 1) {
    let numbers = 0;
    let total = 0;
    for (const row of ref.rows) {
      const v = row[c];
      if (v === null || v === undefined || v === "") continue;
      total += 1;
      if (asNumber(v) !== null) numbers += 1;
    }
    if (total > 0 && numbers / total >= 0.6) out.push(c);
  }
  return out;
}

// An aggregate prefix a group_by / summary result puts in front of a base column
// name — "Mean Fact", "Average Plan", "Sum Revenue". When the user says the bare
// base name ("Fact") and exactly one column is that base under such a prefix, the
// provenance makes the alias unambiguous (24.3.1). `\b` is ASCII-only; the list
// is English aggregate words the engine actually emits.
const AGG_PREFIX_RE =
  /^(?:mean|average|avg|median|sum|total|min|minimum|max|maximum|count|std|stdev|stddev)\s+/i;

/** The base column name with any aggregate prefix and trailing "%"/punctuation removed. */
export function baseColumnName(header: string): string {
  return header.trim().toLowerCase().replace(AGG_PREFIX_RE, "").replace(/[\s%.]+$/, "").trim();
}

function resolveColumnTerm(term: string, columns: readonly string[]): { name: string } | { ambiguous: string[] } | null {
  const wanted = term.trim().toLowerCase();
  if (wanted === "") return null;
  const exact = columns.filter((h) => h.toLowerCase() === wanted);
  if (exact.length === 1) return { name: exact[0]! };
  if (exact.length > 1) return { ambiguous: exact };
  // Provenance-safe aggregate alias: "Fact" → "Mean Fact" only when exactly one
  // column is that base name under an aggregate prefix.
  const wantedBase = baseColumnName(wanted);
  const aggAlias = columns.filter((h) => AGG_PREFIX_RE.test(h) && baseColumnName(h) === wantedBase);
  if (aggAlias.length === 1) return { name: aggAlias[0]! };
  if (aggAlias.length > 1) return { ambiguous: aggAlias };
  const sub = columns.filter((h) => h.toLowerCase().includes(wanted) || wanted.includes(h.toLowerCase()));
  if (sub.length === 1) return { name: sub[0]! };
  if (sub.length > 1) return { ambiguous: sub };
  return null;
}

function labelColumnIndex(ref: Pick<ResultRef, "columns" | "rows">, numeric: readonly number[]): number {
  for (let c = 0; c < ref.columns.length; c += 1) if (!numeric.includes(c)) return c;
  return 0;
}

function compareValues(a: CellValue, b: CellValue): number {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function sortRows(
  rows: readonly (readonly CellValue[])[],
  columnIndex: number,
  direction: "asc" | "desc",
): (readonly CellValue[])[] {
  const indexed = rows.map((row, i) => ({ row, i }));
  indexed.sort((x, y) => {
    const cmp = compareValues(x.row[columnIndex] ?? null, y.row[columnIndex] ?? null);
    return direction === "asc" ? cmp || x.i - y.i : -cmp || x.i - y.i;
  });
  return indexed.map((e) => e.row);
}

// --- detection ----------------------------------------------------------

const BY_RE = /\bby\s+([\p{L}\p{N} _%.-]{1,40}?)(?:[.?!,]|\s+(?:asc|desc|ascending|descending|column)\b|$)/iu;
const BY_RE_RU = /по\s+(?:стил|колонк[а-яё]*\s+|столбц[а-яё]*\s+)?([\p{L}\p{N} _%.-]{1,40}?)(?:[.?!,]|$)/iu;
const TOP_RE = /\btop\s+(\d{1,3})\b/i;
const BOTTOM_RE = /\bbottom\s+(\d{1,3})\b/i;
const HEAD_RE = /\b(?:first|last)\s+(\d{1,3})\b/i;
const TOP_RE_RU = /топ[-\s]?(\d{1,3})/i;
const BOTTOM_RE_RU = /(?:последн[а-яё]*)\s+(\d{1,3})/i;
const HEAD_RE_RU = /перв[а-яё]*\s+(\d{1,3})/i;
// Stage 24.5.1 §11 — "3 managers with the worst Variance" / "3 менеджеров с
// худшим Variance": a bare count + a superlative, no "top"/"топ" keyword. Used
// to narrow a group_by result to the REQUESTED set (not every entity in prose).
const BOTTOM_BY_WORST_RE = /\b(\d{1,3})\s+\p{L}+\s+(?:with|by|having)\s+(?:the\s+)?(?:worst|lowest|smallest|weakest)\b/iu;
const TOP_BY_BEST_RE = /\b(\d{1,3})\s+\p{L}+\s+(?:with|by|having)\s+(?:the\s+)?(?:best|highest|largest|strongest)\b/iu;
const BOTTOM_BY_WORST_RE_RU = /(\d{1,3})\s+[а-яё]+\s+с\s+(?:худшим|наименьшим|наихудшим|минимальным|самым низким)/i;
const TOP_BY_BEST_RE_RU = /(\d{1,3})\s+[а-яё]+\s+с\s+(?:лучшим|наибольшим|наилучшим|максимальным|самым высоким)/i;
const SORT_RE = /\b(?:sort|re-?sort|order)\b/i;
const SORT_RE_RU = /(?:отсортир|пересортир|упорядоч)/i;
const DESC_RE = /\b(?:desc|descending|high(?:est)? (?:to|first)|large(?:st)? first|biggest first)\b/i;
const DESC_RE_RU = /по убыв|убыван|от больш|по нисход/i;
const ASC_RE = /\b(?:asc|ascending|low(?:est)? (?:to|first)|small(?:est)? first)\b/i;
const ASC_RE_RU = /по возраст|возрастан|от меньш|по восход/i;
const WORST_RE = /\b(?:worst|lowest|smallest|weakest|min(?:imum)?|bottom|missed (?:plan|target)|failed to (?:meet|hit|make)|under-?perform(?:ed|ing)?|below (?:plan|target))\b/i;
// Stage 24.5.1 — "не выполнил план" (missed the plan) ⇒ the manager with the
// most-negative / lowest metric.
const WORST_RE_RU = /(?:хуже всех|худш|наименьш|наимень|минимальн|меньше всех|слабе|не выполнил|недовыполн|провалил|ниже план|отста(?:л|ёт|ет))/i;
const BEST_RE = /\b(?:best|highest|largest|biggest|strongest|max(?:imum)?|top)\b/i;
const BEST_RE_RU = /(?:лучше всех|лучш|наибольш|наибол|максимальн|больше всех|сильне)/i;
const SUBSET_RE =
  /\b(?:only|just) (?:the )?(?:columns? )?([\p{L}\p{N} _%.-]+?)(?: columns?)?\b|\bkeep (?:only )?(?:the )?columns? ([\p{L}\p{N} _%.,-]+)/iu;

function detectByColumn(text: string, columns: readonly string[]): { name: string } | { ambiguous: string[] } | null {
  const m = BY_RE.exec(text) ?? BY_RE_RU.exec(text);
  if (!m || !m[1]) return null;
  return resolveColumnTerm(m[1], columns);
}

/**
 * 24.3.1 — the ranking metric carried by a DERIVED result. When the previous
 * turn produced "top 2 by Mean Fact", a follow-up "which one is worst?" (with no
 * column named) must stay on Mean Fact — never drift to another numeric column.
 */
function priorRankingColumn(ref: { readonly transform?: unknown; readonly columns: readonly string[] }): string | undefined {
  const t = ref.transform;
  if (!t || typeof t !== "object") return undefined;
  const r = t as { readonly kind?: unknown; readonly by?: unknown };
  const rankingKinds = ["top_n", "bottom_n", "sort_asc", "sort_desc", "which_extreme"];
  if (typeof r.kind === "string" && rankingKinds.includes(r.kind) && typeof r.by === "string" && r.by) {
    return ref.columns.some((c) => c === r.by) ? r.by : undefined;
  }
  return undefined;
}

/**
 * Reads a follow-up as a transform over `ref`. Returns `column_ambiguous` when
 * the user named a column that matches more than one — the caller then asks.
 */
export function detectResultTransform(
  text: string,
  ref: Pick<ResultRef, "columns" | "rows"> & { readonly transform?: unknown },
  forcedColumn?: string,
): TransformDetection {
  const numeric = numericColumnIndexes(ref);
  const defaultBy = numeric.length > 0 ? ref.columns[numeric[numeric.length - 1]!]! : undefined;
  // A derived ranking result keeps its metric for an unqualified follow-up.
  const priorBy = priorRankingColumn(ref);
  const forced =
    forcedColumn && ref.columns.some((c) => c.toLowerCase() === forcedColumn.toLowerCase())
      ? { name: ref.columns.find((c) => c.toLowerCase() === forcedColumn.toLowerCase())! }
      : null;
  const by = forced ?? detectByColumn(text, ref.columns);
  if (by && "ambiguous" in by) {
    const m = BY_RE.exec(text) ?? BY_RE_RU.exec(text);
    return { kind: "column_ambiguous", term: (m?.[1] ?? "").trim(), candidates: by.ambiguous };
  }
  const byName = by && "name" in by ? by.name : undefined;

  const topM = TOP_RE.exec(text) ?? TOP_RE_RU.exec(text) ?? TOP_BY_BEST_RE.exec(text) ?? TOP_BY_BEST_RE_RU.exec(text);
  const bottomM =
    BOTTOM_RE.exec(text) ?? BOTTOM_RE_RU.exec(text) ?? BOTTOM_BY_WORST_RE.exec(text) ?? BOTTOM_BY_WORST_RE_RU.exec(text);
  const headM = HEAD_RE.exec(text) ?? HEAD_RE_RU.exec(text);
  const rankBy = byName ?? priorBy ?? defaultBy;

  if (topM) {
    const n = Number(topM[1]);
    if (n > 0) return mk({ kind: "top_n", n, ...(rankBy ? { by: rankBy } : {}), phrase: topM[0] });
  }
  if (bottomM) {
    const n = Number(bottomM[1]);
    if (n > 0) return mk({ kind: "bottom_n", n, ...(rankBy ? { by: rankBy } : {}), phrase: bottomM[0] });
  }
  if (headM && !topM && !bottomM) {
    const n = Number(headM[1]);
    if (n > 0) return mk({ kind: "head_n", n, phrase: headM[0] });
  }

  if (SORT_RE.test(text) || SORT_RE_RU.test(text)) {
    const desc = DESC_RE.test(text) || DESC_RE_RU.test(text);
    const asc = ASC_RE.test(text) || ASC_RE_RU.test(text);
    const col = byName ?? priorBy ?? defaultBy;
    if (col) {
      return mk({ kind: desc && !asc ? "sort_desc" : asc ? "sort_asc" : "sort_desc", by: col, phrase: "sort" });
    }
  }

  // "which one is worst / best" — an extreme over the named column, else the
  // active ranking metric of a derived result, else the default numeric column.
  const worst = WORST_RE.test(text) || WORST_RE_RU.test(text);
  const best = BEST_RE.test(text) || BEST_RE_RU.test(text);
  if ((worst || best) && (byName ?? priorBy ?? defaultBy)) {
    return mk({
      kind: "which_extreme",
      extreme: worst && !best ? "min" : "max",
      by: byName ?? priorBy ?? defaultBy!,
      phrase: worst ? "which is worst" : "which is best",
    });
  }

  // column subset — "show only the Category and Fact columns"
  const subM = SUBSET_RE.exec(text);
  if (subM) {
    const chunk = (subM[1] ?? subM[2] ?? "").trim();
    const parts = chunk
      .split(/\s*(?:,|\band\b|\bи\b|&)\s*/i)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const keep: string[] = [];
    for (const part of parts) {
      const r = resolveColumnTerm(part, ref.columns);
      if (r && "name" in r && !keep.includes(r.name)) keep.push(r.name);
      else if (r && "ambiguous" in r) return { kind: "column_ambiguous", term: part, candidates: r.ambiguous };
    }
    if (keep.length > 0 && keep.length < ref.columns.length) {
      return mk({ kind: "column_subset", keep, phrase: subM[0].trim() });
    }
  }

  return { kind: "none" };
}

function mk(transform: ResultTransform): TransformDetection {
  return { kind: "transform", transform };
}

// Stage 24.5.3 — the requested count in a "top N" / "bottom N" / "N <noun> with
// the worst/best <metric>" ask (EN + RU), or null. The caller uses it to pick
// the fullest compatible ancestor result to reshape (a 1-row "which is worst"
// result must not be the thing a "3 managers …" follow-up narrows).
const RANK_COUNT_RE =
  /\b(?:top|bottom|first|last)\s+(\d{1,3})\b|топ[-\s]?(\d{1,3})|(?:перв|последн)[а-яё]*\s+(\d{1,3})|\b(\d{1,3})\s+\p{L}+\s+(?:with|by|having)\s+(?:the\s+)?(?:worst|best|lowest|highest|smallest|largest|weakest|strongest)\b|(\d{1,3})\s+[а-яё]+\s+с\s+(?:худшим|лучшим|наименьшим|наибольшим|наихудшим|наилучшим|минимальным|максимальным|самым низким|самым высоким)/iu;

export function rankRequestCount(text: string): number | null {
  const m = RANK_COUNT_RE.exec(text);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// --- application ------------------------------------------------------

/** Applies a detected transform to `ref`'s structured rows. Pure. */
export function applyResultTransform(ref: ResultRef, transform: ResultTransform): TransformOutcome {
  const columns = ref.columns;
  const rows = ref.rows;
  if (rows.length === 0) return { error: "the earlier result has no rows to work from" };

  const byIndex = transform.by ? columns.findIndex((c) => c === transform.by) : -1;
  if ((transform.kind === "top_n" || transform.kind === "bottom_n" || transform.kind === "sort_asc" || transform.kind === "sort_desc" || transform.kind === "which_extreme") && transform.by && byIndex < 0) {
    return { error: `the earlier result has no "${transform.by}" column` };
  }

  const numeric = numericColumnIndexes(ref);
  const labelIndex = labelColumnIndex(ref, numeric);

  switch (transform.kind) {
    case "head_n": {
      const n = Math.max(1, transform.n ?? 1);
      return {
        columns,
        rows: rows.slice(0, n),
        kind: "ranking",
        title: `${ref.title} — first ${n}`,
        answer: `Here are the first ${Math.min(n, rows.length)} row(s) of that result.`,
        transform,
      };
    }
    case "top_n":
    case "bottom_n": {
      const n = Math.max(1, transform.n ?? 1);
      const col = byIndex >= 0 ? byIndex : numeric[numeric.length - 1] ?? 0;
      const direction = transform.kind === "top_n" ? "desc" : "asc";
      const sorted = sortRows(rows, col, direction).slice(0, n);
      const byLabel = columns[col];
      return {
        columns,
        rows: sorted,
        kind: "ranking",
        title: `${ref.title} — ${transform.kind === "top_n" ? "top" : "bottom"} ${n} by ${byLabel}`,
        answer: `${transform.kind === "top_n" ? "Top" : "Bottom"} ${Math.min(n, sorted.length)} by ${byLabel}, from the earlier result.`,
        transform,
      };
    }
    case "sort_asc":
    case "sort_desc": {
      const col = byIndex >= 0 ? byIndex : numeric[numeric.length - 1] ?? 0;
      const direction = transform.kind === "sort_asc" ? "asc" : "desc";
      const byLabel = columns[col];
      return {
        columns,
        rows: sortRows(rows, col, direction),
        kind: "ranking",
        title: `${ref.title} — sorted by ${byLabel} (${direction})`,
        answer: `Sorted the earlier result by ${byLabel}, ${direction === "asc" ? "ascending" : "descending"}.`,
        transform,
      };
    }
    case "which_extreme": {
      const col = byIndex >= 0 ? byIndex : numeric[numeric.length - 1] ?? 0;
      const direction = transform.extreme === "min" ? "asc" : "desc";
      const winner = sortRows(rows, col, direction)[0]!;
      const label = String(winner[labelIndex] ?? winner[0] ?? "");
      const value = winner[col];
      const word = transform.extreme === "min" ? "lowest" : "highest";
      return {
        columns,
        rows: [winner],
        kind: "scalar",
        title: `${ref.title} — ${word} ${columns[col]}`,
        answer: `${label} has the ${word} ${columns[col]} (${String(value)}) in that result.`,
        transform,
      };
    }
    case "column_subset": {
      const keep = transform.keep ?? [];
      const keepIndexes = keep.map((k) => columns.findIndex((c) => c === k)).filter((i) => i >= 0);
      if (keepIndexes.length === 0) return { error: "none of those columns are in the earlier result" };
      return {
        columns: keepIndexes.map((i) => columns[i]!),
        rows: rows.map((row) => keepIndexes.map((i) => row[i] ?? null)),
        kind: ref.kind,
        title: `${ref.title} — ${keep.join(", ")}`,
        answer: `Showing only ${keep.join(", ")} from the earlier result.`,
        transform,
      };
    }
    default:
      return { error: "unsupported transform" };
  }
}
