import type { WorkbookMap, WorkbookMapSheet } from "./workbook-map.js";

export interface ResolvedSheet {
  readonly kind: "ok";
  readonly sheet: WorkbookMapSheet;
}
export interface AmbiguousRef {
  readonly kind: "ambiguous";
  readonly candidates: readonly string[];
}
export interface UnknownRef {
  readonly kind: "not_found";
}
export type SheetResolution = ResolvedSheet | AmbiguousRef | UnknownRef;

export interface ResolvedColumn {
  readonly kind: "ok";
  readonly name: string;
  /** 0-based index into `sheet.headers`. */
  readonly index: number;
}
export type ColumnResolution = ResolvedColumn | AmbiguousRef | UnknownRef;

export interface ResolveOptions {
  /** Mutation targets: accept only an exact (case-insensitive) name. */
  readonly strict?: boolean;
}

function norm(text: string): string {
  return text.trim().toLowerCase();
}

/** Resolves a worksheet reference against the map. Never guesses between candidates. */
export function resolveSheet(map: WorkbookMap, reference: string, options: ResolveOptions = {}): SheetResolution {
  const wanted = reference.trim();
  if (wanted === "") return { kind: "not_found" };
  const lower = norm(wanted);

  const exact = map.sheets.find((sheet) => sheet.name === wanted);
  if (exact) return { kind: "ok", sheet: exact };

  const caseInsensitive = map.sheets.filter((sheet) => norm(sheet.name) === lower);
  if (caseInsensitive.length === 1) return { kind: "ok", sheet: caseInsensitive[0]! };
  if (caseInsensitive.length > 1) return { kind: "ambiguous", candidates: caseInsensitive.map((s) => s.name) };

  if (options.strict) return { kind: "not_found" };

  const prefix = map.sheets.filter((sheet) => norm(sheet.name).startsWith(lower));
  if (prefix.length === 1) return { kind: "ok", sheet: prefix[0]! };
  if (prefix.length > 1) return { kind: "ambiguous", candidates: prefix.map((s) => s.name) };

  const substring = map.sheets.filter((sheet) => norm(sheet.name).includes(lower));
  if (substring.length === 1) return { kind: "ok", sheet: substring[0]! };
  if (substring.length > 1) return { kind: "ambiguous", candidates: substring.map((s) => s.name) };

  return { kind: "not_found" };
}

/**
 * Resolves a column reference within an ALREADY resolved sheet. Only the sheet's
 * known headers are considered; an exact (case-insensitive) match wins, a single
 * substring match resolves, two or more are ambiguous.
 */
export function resolveColumn(sheet: WorkbookMapSheet, reference: string): ColumnResolution {
  const wanted = reference.trim();
  if (wanted === "" || sheet.headers.length === 0) return { kind: "not_found" };
  const lower = norm(wanted);

  const exactIndex = sheet.headers.findIndex((header) => header === wanted);
  if (exactIndex >= 0) return { kind: "ok", name: sheet.headers[exactIndex]!, index: exactIndex };

  const ciIndexes = sheet.headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => norm(header) === lower);
  if (ciIndexes.length === 1) return { kind: "ok", name: ciIndexes[0]!.header, index: ciIndexes[0]!.index };
  if (ciIndexes.length > 1) return { kind: "ambiguous", candidates: ciIndexes.map((c) => c.header) };

  const subIndexes = sheet.headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => norm(header).includes(lower));
  if (subIndexes.length === 1) return { kind: "ok", name: subIndexes[0]!.header, index: subIndexes[0]!.index };
  if (subIndexes.length > 1) return { kind: "ambiguous", candidates: subIndexes.map((c) => c.header) };

  return { kind: "not_found" };
}
