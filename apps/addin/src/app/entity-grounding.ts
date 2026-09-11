// ---------------------------------------------------------------------------
// Stage 24.5 §8–§9 — deterministic entity → source-row grounding.
//
// A remembered analytical result exposes an entity column and a set of canonical
// entity values (e.g. Manager ∈ {Aigerim, Aruzhan, Timur}). To act on those
// entities in Excel we must map them back to concrete source rows — WITHOUT a
// model call, without fuzzy matching, without joins.
//
// Matching rules (documented, exact):
//   • the entity column is resolved against the source headers by exact name,
//     then case-insensitive / whitespace-collapsed name; unknown or ambiguous
//     column ⇒ fail closed (no rows).
//   • each cell value and each requested value is normalised: strings are
//     trimmed, lower-cased and whitespace-collapsed; numbers compared by value
//     (with a 1e-9 epsilon); booleans by `String(v)`. Empty cells never match.
//   • a row matches (mode "in") when its normalised entity cell equals one of
//     the normalised requested values; mode "not_in" inverts this over the
//     non-empty entity cells.
//   • matched sheet rows are 1-based absolute, de-duplicated, kept in natural
//     workbook order.
//
// The SAME returned row set drives the displayed count, the Preview, the
// Office.js mutation target and the Undo snapshot (§9).
// ---------------------------------------------------------------------------

import type { CellValue, ExcelPort } from "@sheet-agent/application";
import { parseLocalRange, splitSheetAddress } from "./a1.js";
import { readAddressSnapshot } from "./workbook-context.js";
import { sourceVersionOf } from "./source-freshness.js";

export type EntityMatchMode = "in" | "not_in";

/** Defensive ceilings — grounding is bounded and never streams the sheet. */
const MAX_SOURCE_ROWS_SCANNED = 20000;
const MAX_RETAINED_ROWS = 200;

export interface EntityGroundingRequest {
  /** Sheet-qualified A1 the result was computed from (provenance, never the live selection). */
  readonly sourceRange: string;
  /** Freshness token captured when the result was computed. */
  readonly sourceVersion?: string;
  /** Canonical entity column name from the ResultRef. */
  readonly entityColumn: string;
  /** Canonical entity values from the ResultRef. */
  readonly entityValues: readonly CellValue[];
  readonly mode?: EntityMatchMode;
}

export type EntityGroundingErrorKind =
  | "unreadable_source"
  | "empty_source"
  | "unknown_column"
  | "ambiguous_column"
  | "stale_source"
  | "no_values";

export interface EntityGroundingError {
  readonly ok: false;
  readonly kind: EntityGroundingErrorKind;
  readonly message: string;
  /** For "ambiguous_column" — the competing header names. */
  readonly candidates?: readonly string[];
}

export interface EntityGroundingResult {
  readonly ok: true;
  readonly sourceSheet: string;
  /** Sheet-qualified A1 of the full source table actually scanned. */
  readonly sourceRange: string;
  readonly sourceVersion: string;
  readonly entityColumn: string;
  /** 1-based absolute sheet row numbers, de-duplicated, workbook order. */
  readonly sheetRows: readonly number[];
  /** Requested values that matched at least one row (normalised comparison). */
  readonly matchedValues: readonly string[];
  /** Requested values that matched no row — drives §16 partial-resolution UX. */
  readonly unmatchedValues: readonly string[];
  /** Data rows evaluated (header excluded). */
  readonly evaluated: number;
  /** Retained header names for the matched rows (bounded). */
  readonly columns: readonly string[];
  /** Retained cell values for the matched rows, aligned to `columns` (bounded). */
  readonly rows: readonly (readonly CellValue[])[];
  readonly truncated: boolean;
}

export type EntityGroundingOutcome = EntityGroundingResult | EntityGroundingError;

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Normalised comparison key for a cell / requested value. `null` never matches. */
function matchKey(value: CellValue): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? `n:${Math.round(value * 1e9) / 1e9}` : null;
  }
  if (typeof value === "boolean") return `b:${value}`;
  const s = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  return s === "" ? null : `s:${s}`;
}

function resolveEntityColumnIndex(
  headers: readonly string[],
  wanted: string,
): { index: number } | { ambiguous: string[] } | { missing: true } {
  const exact = headers.map((h, i) => ({ h, i })).filter((e) => e.h === wanted);
  if (exact.length === 1) return { index: exact[0]!.i };
  if (exact.length > 1) return { ambiguous: exact.map((e) => e.h) };
  const target = normalizeHeader(wanted);
  const fuzzy = headers.map((h, i) => ({ h, i })).filter((e) => normalizeHeader(e.h) === target);
  if (fuzzy.length === 1) return { index: fuzzy[0]!.i };
  if (fuzzy.length > 1) return { ambiguous: fuzzy.map((e) => e.h) };
  return { missing: true };
}

/**
 * Resolves `entityValues` against `entityColumn` in the source table at
 * `sourceRange`. One bounded workbook read; no model call. When `sourceVersion`
 * is supplied and no longer matches the live source, returns `stale_source`.
 */
export async function groundEntitiesToRows(
  port: ExcelPort,
  request: EntityGroundingRequest,
): Promise<EntityGroundingOutcome> {
  const wanted = [...request.entityValues].map(matchKey).filter((k): k is string => k !== null);
  if (wanted.length === 0) {
    return { ok: false, kind: "no_values", message: "that result carries no entity values to match" };
  }

  let snapshot;
  try {
    snapshot = await readAddressSnapshot(port, request.sourceRange);
  } catch {
    return { ok: false, kind: "unreadable_source", message: "the source data for that result could not be read" };
  }
  if (snapshot.isEmpty || snapshot.values.length < 2) {
    return { ok: false, kind: "empty_source", message: "the source data for that result is empty" };
  }

  const liveVersion = sourceVersionOf(snapshot);
  if (request.sourceVersion && request.sourceVersion !== liveVersion) {
    return { ok: false, kind: "stale_source", message: "the source data changed after that result was calculated" };
  }

  const headers = snapshot.headers && snapshot.headers.length > 0
    ? snapshot.headers
    : snapshot.values[0]!.map((c) => String(c ?? ""));
  const resolved = resolveEntityColumnIndex(headers, request.entityColumn);
  if ("ambiguous" in resolved) {
    return {
      ok: false,
      kind: "ambiguous_column",
      message: `"${request.entityColumn}" matches more than one column in the source data`,
      candidates: resolved.ambiguous,
    };
  }
  if ("missing" in resolved) {
    return { ok: false, kind: "unknown_column", message: `the source data has no "${request.entityColumn}" column` };
  }
  const colIndex = resolved.index;

  const { sheetName } = splitSheetAddress(request.sourceRange);
  const sourceSheet = sheetName || snapshot.sheetName;
  // values[0] is the header row → first data row is sheet row start.row + 2 (1-based).
  const firstDataSheetRow = parseLocalRange(request.sourceRange).start.row + 2;
  const mode: EntityMatchMode = request.mode ?? "in";
  const wantedSet = new Set(wanted);

  const dataRows = snapshot.values.slice(1, 1 + MAX_SOURCE_ROWS_SCANNED);
  const matchedSheetRows: number[] = [];
  const matchedKeys = new Set<string>();
  const retained: CellValue[][] = [];
  dataRows.forEach((row, i) => {
    const key = matchKey(row[colIndex] ?? null);
    if (key === null) return; // empty entity cell never matches (either mode)
    const inSet = wantedSet.has(key);
    const hit = mode === "in" ? inSet : !inSet;
    if (!hit) return;
    if (inSet) matchedKeys.add(key);
    matchedSheetRows.push(firstDataSheetRow + i);
    if (retained.length < MAX_RETAINED_ROWS) retained.push(headers.map((_, c) => row[c] ?? null));
  });

  const sheetRows = [...new Set(matchedSheetRows)].sort((a, b) => a - b);
  const matchedValues = [...request.entityValues]
    .filter((v) => { const k = matchKey(v); return k !== null && matchedKeys.has(k); })
    .map((v) => String(v));
  const unmatchedValues = [...request.entityValues]
    .filter((v) => { const k = matchKey(v); return k !== null && !matchedKeys.has(k); })
    .map((v) => String(v));

  return {
    ok: true,
    sourceSheet,
    sourceRange: snapshot.address,
    sourceVersion: liveVersion,
    entityColumn: headers[colIndex]!,
    sheetRows,
    matchedValues,
    unmatchedValues,
    evaluated: dataRows.length,
    columns: [...headers],
    rows: retained,
    truncated: retained.length < matchedSheetRows.length,
  };
}
