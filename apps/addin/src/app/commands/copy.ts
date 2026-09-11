// ---------------------------------------------------------------------------
// Stage 23 — `/copy <Sheet>!<range> to <Sheet>!<cell>` (deterministic, previewed).
//
// Narrow by design: copy the VALUES of a resolved source range to a resolved
// destination, sized from the source. Source and destination are resolved
// through the Workbook resolver — the model never invents an address. The
// destination is written with a single `set_values` action, so the existing
// Preview → Approve → applyAction(snapshot) → undoChange path applies unchanged
// (one `/undo` restores the destination's prior contents). A populated
// destination is flagged in the preview — never silently overwritten.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import type { ResponseLanguage } from "../language.js";
import type { SelectionSnapshot } from "../workbook-context.js";
import { buildLocalRange, parseLocalRange } from "../a1.js";
import { validateAction, type WorkbookAction } from "../workbook-actions.js";

/** Copy is deliberately capped well below the generic per-action cell limit. */
export const MAX_COPY_CELLS = 2_000;

export interface CopySpec {
  readonly source: { readonly sheet: string; readonly range: string };
  readonly dest: { readonly sheet: string; readonly anchor: string };
}

export interface CopyProposal {
  readonly text: string;
  readonly actions: readonly WorkbookAction[];
}
export interface CopyError {
  readonly error: string;
}
export function isCopyError(v: CopyProposal | CopyError): v is CopyError {
  return "error" in v;
}

const LOCAL_RANGE = /^[A-Za-z]{1,3}\d{1,7}(?::[A-Za-z]{1,3}\d{1,7})?$/;
const LOCAL_CELL = /^[A-Za-z]{1,3}\d{1,7}$/;
// "<sheet>!<range>  to|в|на  <sheet>!<cell>"  (sheet names may contain spaces).
const COPY_RE = /^(.+!.+?)\s+(?:to|в|на)\s+(.+!.+?)$/i;

function splitOnce(qualified: string): { sheet: string; local: string } | null {
  const bang = qualified.indexOf("!");
  if (bang < 1 || bang === qualified.length - 1) return null;
  return {
    sheet: qualified.slice(0, bang).replace(/^["'«](.*)["'»]$/, "$1").trim(),
    local: qualified.slice(bang + 1).replaceAll("$", "").trim(),
  };
}

export function parseCopySpec(args: string): CopySpec | null {
  const match = COPY_RE.exec(args.trim());
  if (!match) return null;
  const src = splitOnce((match[1] ?? "").trim());
  const dst = splitOnce((match[2] ?? "").trim());
  if (!src || !dst) return null;
  if (!LOCAL_RANGE.test(src.local) || !LOCAL_CELL.test(dst.local)) return null;
  return {
    source: { sheet: src.sheet, range: src.local },
    dest: { sheet: dst.sheet, anchor: dst.local },
  };
}

/** Destination range sized from the source range, anchored at `destAnchor`. */
export function copyDestRange(sourceRange: string, destAnchor: string): string {
  const src = parseLocalRange(sourceRange);
  const anchor = parseLocalRange(destAnchor).start;
  return buildLocalRange(anchor, src.rowCount, src.columnCount);
}

function rectangular(values: readonly (readonly CellValue[])[]): CellValue[][] {
  const width = values[0]?.length ?? 0;
  return values.map((row) => {
    const copy = row.slice(0, width);
    while (copy.length < width) copy.push(null);
    return copy as CellValue[];
  });
}

/**
 * Builds the copy proposal. `sourceSnapshot` is a read of the resolved source
 * range; `destBefore` is a read of the computed destination range on the
 * resolved destination sheet (used only for the overwrite warning).
 */
export function buildCopyProposal(
  spec: CopySpec,
  resolvedSourceSheet: string,
  resolvedDestSheet: string,
  sourceSnapshot: SelectionSnapshot,
  destBefore: SelectionSnapshot,
  language: ResponseLanguage,
): CopyProposal | CopyError {
  const ru = language === "ru";
  const requested = parseLocalRange(spec.source.range);
  const cells = requested.rowCount * requested.columnCount;
  if (cells > MAX_COPY_CELLS) {
    return {
      error: ru
        ? `Диапазон ${spec.source.range} слишком большой для /copy в этой версии (максимум ${MAX_COPY_CELLS} ячеек).`
        : `The range ${spec.source.range} is too large for /copy in this version (max ${MAX_COPY_CELLS} cells).`,
    };
  }

  const values = rectangular(sourceSnapshot.values);
  if (values.length !== requested.rowCount || (values[0]?.length ?? 0) !== requested.columnCount) {
    return {
      error: ru
        ? `Не удалось прочитать весь диапазон ${resolvedSourceSheet}!${spec.source.range}.`
        : `Could not read the full source range ${resolvedSourceSheet}!${spec.source.range}.`,
    };
  }

  const destRange = copyDestRange(spec.source.range, spec.dest.anchor);
  const populated = destBefore.values.reduce(
    (total, row) => total + row.filter((c) => c !== null && c !== "" && c !== undefined).length,
    0,
  );

  const candidate = {
    type: "set_values",
    sheetName: resolvedDestSheet,
    range: destRange,
    description: ru
      ? `Копирование ${resolvedSourceSheet}!${spec.source.range} → ${resolvedDestSheet}!${destRange}`
      : `Copy ${resolvedSourceSheet}!${spec.source.range} → ${resolvedDestSheet}!${destRange}`,
    payload: { values },
  };
  const validated = validateAction(candidate, 0);
  if (typeof validated === "string") {
    return {
      error: ru
        ? `Не удалось собрать корректное действие копирования (${validated}). Изменения не предложены.`
        : `Could not build a valid copy action (${validated}). No change was proposed.`,
    };
  }

  const overwriteLine =
    populated > 0
      ? ru
        ? ` ⚠ В целевом диапазоне уже есть данные (${populated} непустых ячеек) — подтверждение перезапишет их.`
        : ` ⚠ The destination already contains data (${populated} non-empty cells) — approving will overwrite them.`
      : "";
  const text = ru
    ? `Копирование ${resolvedSourceSheet}!${spec.source.range} (${requested.rowCount}×${requested.columnCount}) в ${resolvedDestSheet}!${destRange}.${overwriteLine} Подтвердите изменение.`
    : `Copy ${resolvedSourceSheet}!${spec.source.range} (${requested.rowCount}×${requested.columnCount}) to ${resolvedDestSheet}!${destRange}.${overwriteLine} Approve the change.`;

  return { text, actions: [validated] };
}
