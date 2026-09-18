// ---------------------------------------------------------------------------
// Stage 24.7 — deterministic metric / entity resolution over a TableSchema
// (§6, §7, §50). The word after an analytical verb is NOT necessarily a
// column: it can be a row-axis member ("Активы"), a measure ("Revenue"), or an
// axis noun ("показателей" = "the row metrics"). Multiple candidates → clarify,
// never a silent pick.
// ---------------------------------------------------------------------------

import type { ColumnPath, RowAxisMember, TableSchema } from "../schema-induction.js";

/** Axis nouns that mean "the members of the subject axis", not a literal field. */
export const AXIS_NOUN_RE =
  /^(?:показател\p{L}*|метрик\p{L}*|индикатор\p{L}*|строк\p{L}*|позици\p{L}*|пункт\p{L}*|статей?|стро[кч]\p{L}*|indicators?|metrics?|rows?|line\s+items?|items?)$/iu;

/** Dimension nouns → a row/column dimension member set ("региона", "категории"). */
export const DIMENSION_NOUN_RE =
  /^(?:регион\p{L}*|област\p{L}*|категори\p{L}*|продукт\p{L}*|товар\p{L}*|группа?\p{L}*|сегмент\p{L}*|подразделен\p{L}*|отдел\p{L}*|regions?|categor\p{L}*|products?|segments?|groups?|divisions?|departments?)$/iu;

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[«»"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normLoose(s: string): string {
  return norm(s).replace(/[.,;:()/\\-]/g, " ").replace(/\s+/g, " ").trim();
}

export interface MetricEntry {
  readonly kind: "row_member" | "column";
  readonly label: string;
  readonly aliases: readonly string[];
  readonly member?: RowAxisMember;
  readonly column?: ColumnPath;
}

export interface MetricIndex {
  readonly entries: readonly MetricEntry[];
}

/**
 * Builds the reusable MetricIndex — canonical labels + normalized aliases +
 * axis coordinates. No LLM-generated coordinates.
 *
 * Stage 24.7.1 §4/§5/§6 — TYPED NAMESPACES. `MetricIndex` must contain ONLY
 * objects that are valid analytical subjects. For `row_metrics` /
 * `hierarchical_report` / `matrix` / `time_series_matrix` / `bidimensional`
 * orientation, the COLUMNS are periods (dates / years / change horizons /
 * abs-% measure variants) — they belong to `PeriodIndex`, never here. For
 * `column_metrics` orientation (transpose), the ROWS are periods (dates) and
 * the COLUMNS are the real metrics — the reverse namespace split.
 */
export function buildMetricIndex(schema: TableSchema): MetricIndex {
  const entries: MetricEntry[] = [];
  const columnsAreMetrics = schema.orientation === "column_metrics";

  if (!columnsAreMetrics) {
    for (const member of schema.rowAxis) {
      const label = member.display;
      entries.push({
        kind: "row_member",
        label,
        aliases: [...new Set([norm(label), normLoose(label), ...member.labels.map(norm)])],
        member,
      });
    }
  }
  if (columnsAreMetrics) {
    for (const p of schema.columnPaths) {
      const label = p.displayLabel;
      entries.push({
        kind: "column",
        label,
        aliases: [...new Set([norm(label), normLoose(label), ...p.levels.map((l) => norm(l.value))])],
        column: p,
      });
    }
  }
  return { entries };
}

export type MetricResolution =
  | { readonly kind: "resolved"; readonly entry: MetricEntry; readonly how: string }
  | { readonly kind: "ambiguous"; readonly needle: string; readonly candidates: readonly string[] }
  | { readonly kind: "unknown"; readonly needle: string };

/**
 * Stage 24.7.1 (final correction, §3/§13) — the REQUIRED match-class
 * precedence, most specific first. A longer label that merely CONTAINS the
 * requested metric's words ("доля ликвидных активов в активах") can never
 * outrank an exact or morphologically exact shorter metric ("Активы",
 * "Ликвидные активы") — every entry is classified into the SINGLE highest
 * class it qualifies for, and only entries at the globally highest class
 * present are ever candidates. A lower class can never beat a higher one,
 * regardless of label length, substring count, or row position (§16).
 */
export type MetricMatchClass =
  | "exact_normalized"
  | "morphological_exact"
  | "whole_token_sequence"
  | "prefix"
  | "token_subset"
  | "substring";

export const MATCH_CLASS_RANK: Readonly<Record<MetricMatchClass, number>> = {
  exact_normalized: 100,
  morphological_exact: 90,
  whole_token_sequence: 80,
  prefix: 70,
  token_subset: 60,
  substring: 50,
};

export interface MetricResolutionCandidate {
  readonly label: string;
  readonly matchClass: MetricMatchClass;
  readonly score: number;
}

export interface MetricResolutionTrace {
  readonly query: string;
  readonly normalizedQuery: string;
  /** every entry that qualified at any class, highest score first. */
  readonly candidates: readonly MetricResolutionCandidate[];
  readonly selected?: string;
  readonly selectionReason: "no_candidates" | "higher_match_class" | "ambiguous_same_class";
}

function tokenize(s: string): string[] {
  return s.split(" ").filter(Boolean);
}

/** True when two normalised single tokens are equal or share a dominant
 *  common prefix (RU case-ending variance, e.g. "активы" ~ "активов",
 *  "доли" ~ "доля"). Shorter words (min length 4–6) require only the last
 *  character to differ — a single case-ending swap; longer words use the
 *  looser 70%-prefix heuristic already proven on real metric names. */
function sharedStem(a: string, b: string): boolean {
  if (a.includes(" ") || b.includes(" ")) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  const max = Math.max(a.length, b.length);
  if (min < 4 || max - min > 2) return false;
  let k = 0;
  while (k < min && a[k] === b[k]) k += 1;
  if (min >= 7) return k >= 4 && k / min >= 0.7;
  return k >= min - 1;
}

function tokenEq(a: string, b: string): boolean {
  return a === b || sharedStem(a, b);
}

/** Same token count, every corresponding token pair equal or a shared stem.
 *  Covers both single-word ("активов" ~ "активы") and multi-word
 *  ("ликвидных активов" ~ "ликвидные активы") morphology. */
function morphMatch(aliasNorm: string, needleNorm: string): boolean {
  const at = tokenize(aliasNorm);
  const nt = tokenize(needleNorm);
  if (at.length === 0 || at.length !== nt.length) return false;
  return at.every((tok, i) => tokenEq(tok, nt[i]!));
}

/** The needle's tokens appear as an exact contiguous whole-token run inside
 *  a strictly longer label's tokens. Token-based (word-boundary aware), not
 *  a raw character substring — "период" never matches inside "периодов". */
function tokenSequenceMatch(aliasNorm: string, needleNorm: string): boolean {
  const at = tokenize(aliasNorm);
  const nt = tokenize(needleNorm);
  if (nt.length === 0 || at.length <= nt.length) return false;
  for (let i = 0; i + nt.length <= at.length; i += 1) {
    if (nt.every((tok, j) => at[i + j] === tok)) return true;
  }
  return false;
}

/** Every needle token has a distinct (order-independent) equal-or-stem
 *  match among a strictly longer label's tokens — a weaker, non-contiguous
 *  relaxation of `tokenSequenceMatch` for morphological variants spread
 *  across a longer label. */
function tokenSubsetMatch(aliasNorm: string, needleNorm: string): boolean {
  const at = tokenize(aliasNorm);
  const nt = tokenize(needleNorm);
  if (nt.length === 0 || at.length <= nt.length) return false;
  const used = new Array<boolean>(at.length).fill(false);
  for (const tok of nt) {
    const idx = at.findIndex((a, i) => !used[i] && tokenEq(a, tok));
    if (idx === -1) return false;
    used[idx] = true;
  }
  return true;
}

/** Classifies ONE entry into the single highest match class it qualifies
 *  for against the needle, or `null` if it doesn't qualify at all. */
function classifyEntry(e: MetricEntry, raw: string, n: string, nl: string): MetricMatchClass | null {
  if (e.label === raw || e.aliases.includes(n) || e.aliases.includes(nl)) return "exact_normalized";
  if (morphMatch(norm(e.label), nl)) return "morphological_exact";
  if (nl.length < 3) return null;
  if (tokenSequenceMatch(norm(e.label), nl)) return "whole_token_sequence";
  if (e.aliases.some((a) => a.startsWith(nl) || nl.startsWith(a))) return "prefix";
  if (tokenSubsetMatch(norm(e.label), nl)) return "token_subset";
  if (e.aliases.some((a) => a.includes(nl) || nl.includes(a))) return "substring";
  return null;
}

function classifyAll(needle: string, index: MetricIndex): { readonly raw: string; readonly candidates: readonly { readonly entry: MetricEntry; readonly cls: MetricMatchClass }[] } {
  const raw = needle.trim();
  const n = norm(raw);
  const nl = normLoose(raw);
  const classified: { entry: MetricEntry; cls: MetricMatchClass }[] = [];
  for (const e of index.entries) {
    const cls = raw === "" ? null : classifyEntry(e, raw, n, nl);
    if (cls) classified.push({ entry: e, cls });
  }
  return { raw, candidates: dedupeClassified(classified) };
}

/**
 * Resolves a metric needle against the index. Every entry is classified into
 * its single best match class (§13); only entries at the globally highest
 * class present are considered — a lower class can never win over a higher
 * one, no matter how long the label or how many tokens overlap (§16).
 * Ambiguity within the winning class always clarifies, never silently picks.
 */
export function resolveMetric(needle: string, index: MetricIndex): MetricResolution {
  const raw = needle.trim();
  if (raw === "") return { kind: "unknown", needle: raw };
  const { candidates } = classifyAll(needle, index);
  if (candidates.length === 0) return { kind: "unknown", needle: raw };
  const maxRank = Math.max(...candidates.map((c) => MATCH_CLASS_RANK[c.cls]));
  const top = candidates.filter((c) => MATCH_CLASS_RANK[c.cls] === maxRank);
  if (top.length === 1) return { kind: "resolved", entry: top[0]!.entry, how: top[0]!.cls };
  return { kind: "ambiguous", needle: raw, candidates: top.map((c) => c.entry.label) };
}

/**
 * Stage 24.7.1 (final correction, §15) — a developer-only trace of the full
 * candidate set considered during resolution, for `/debug` diagnostics. Never
 * shown to normal users; reuses the exact same classification as
 * `resolveMetric` so the trace can never disagree with the actual selection.
 */
export function traceMetricResolution(needle: string, index: MetricIndex): MetricResolutionTrace {
  const { raw, candidates } = classifyAll(needle, index);
  const ranked = [...candidates].sort((a, b) => MATCH_CLASS_RANK[b.cls] - MATCH_CLASS_RANK[a.cls] || a.entry.label.localeCompare(b.entry.label));
  const traceCandidates = ranked.map((c) => ({ label: c.entry.label, matchClass: c.cls, score: MATCH_CLASS_RANK[c.cls] }));
  if (candidates.length === 0) {
    return { query: raw, normalizedQuery: normLoose(raw), candidates: traceCandidates, selectionReason: "no_candidates" };
  }
  const maxRank = ranked[0]!.cls;
  const top = ranked.filter((c) => c.cls === maxRank);
  return {
    query: raw,
    normalizedQuery: normLoose(raw),
    candidates: traceCandidates,
    ...(top.length === 1 ? { selected: top[0]!.entry.label } : {}),
    selectionReason: top.length === 1 ? "higher_match_class" : "ambiguous_same_class",
  };
}

// ---------------------------------------------------------------------------
// Stage 24.9 §8/§9/§27/§28 — MULTI-METRIC resolution ("Активы и
// Обязательства", "Ликвидные активы и доля ликвидных активов в активах").
//
// The whole phrase is tried as ONE metric FIRST — this protects a legitimate
// label that itself contains a connector word ("корреспондентские счета и
// вклады", §27/§28) from ever being split. Only when the whole phrase does
// NOT resolve does it get split on top-level connectors and each segment
// resolved independently via the SAME `resolveMetric` used everywhere else —
// no separate multi-metric matching logic, no greedy longest-label merge.
// ---------------------------------------------------------------------------

export type MetricSetResolution =
  | { readonly kind: "resolved"; readonly entries: readonly MetricEntry[] }
  | { readonly kind: "ambiguous"; readonly needle: string; readonly candidates: readonly string[] }
  | { readonly kind: "unknown"; readonly needle: string };

const METRIC_SET_CONNECTOR_RE = /\s*,\s*(?:и\s+)?|\s+и\s+|\s+против\s+|\s+vs\.?\s+|\s+versus\s+/giu;

function splitMetricSetText(text: string): string[] {
  return text
    .split(METRIC_SET_CONNECTOR_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolves "A и B [и C]" against the index. §9 — no greedy merge: "Ликвидные
 * активы и доля ликвидных активов в активах" always resolves as the two
 * EXACT metrics, never one metric whose label happens to contain the other.
 */
export function resolveMetricSet(text: string, index: MetricIndex): MetricSetResolution {
  const raw = text.trim();
  if (raw === "") return { kind: "unknown", needle: raw };

  // §27/§28 — protect a legitimate single label containing a connector word
  // ("корреспондентские счета и вклады"). Only an EXACT or morphological
  // match protects the whole phrase — a "prefix" match (a real single metric
  // like "Активы" is a literal string-prefix of "Активы и Обязательства")
  // must NOT swallow a genuine two-metric phrase.
  const whole = resolveMetric(raw, index);
  if (whole.kind === "resolved" && (whole.how === "exact_normalized" || whole.how === "morphological_exact")) {
    return { kind: "resolved", entries: [whole.entry] };
  }

  const parts = splitMetricSetText(raw);
  if (parts.length < 2) {
    return whole.kind === "ambiguous"
      ? { kind: "ambiguous", needle: whole.needle, candidates: whole.candidates }
      : { kind: "unknown", needle: raw };
  }
  const entries: MetricEntry[] = [];
  for (const part of parts) {
    const r = resolveMetric(part, index);
    if (r.kind === "ambiguous") return { kind: "ambiguous", needle: r.needle, candidates: r.candidates };
    if (r.kind === "unknown") return { kind: "unknown", needle: r.needle };
    entries.push(r.entry);
  }
  return { kind: "resolved", entries };
}

function dedupeClassified<T extends { entry: MetricEntry }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of entries) {
    const key = `${c.entry.kind}:${c.entry.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
