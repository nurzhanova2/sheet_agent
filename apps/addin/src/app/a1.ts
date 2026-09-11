// Minimal A1-notation helpers. Kept dependency-free and pure so they are easy to test.

export interface CellRef {
  readonly row: number; // 0-based
  readonly column: number; // 0-based
}

export interface RangeRef {
  readonly start: CellRef;
  readonly end: CellRef;
  readonly rowCount: number;
  readonly columnCount: number;
}

export function columnLettersToIndex(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

export function columnIndexToLetters(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

export function parseCell(cell: string): CellRef {
  const match = CELL.exec(cell.trim());
  if (!match) throw new Error(`Invalid cell reference: ${cell}`);
  return { row: Number(match[2]) - 1, column: columnLettersToIndex(match[1] ?? "A") };
}

/** Parses a local A1 range such as `A1:F120` or a single cell `C3`. Sheet prefix is stripped. */
export function parseLocalRange(address: string): RangeRef {
  const local = address.includes("!") ? address.slice(address.lastIndexOf("!") + 1) : address;
  const cleaned = local.replaceAll("$", "").trim();
  const [startText, endText] = cleaned.split(":");
  if (!startText) throw new Error(`Invalid range: ${address}`);
  const start = parseCell(startText);
  const end = endText ? parseCell(endText) : start;
  const top = Math.min(start.row, end.row);
  const bottom = Math.max(start.row, end.row);
  const left = Math.min(start.column, end.column);
  const right = Math.max(start.column, end.column);
  return {
    start: { row: top, column: left },
    end: { row: bottom, column: right },
    rowCount: bottom - top + 1,
    columnCount: right - left + 1,
  };
}

export function buildLocalRange(start: CellRef, rowCount: number, columnCount: number): string {
  const startText = `${columnIndexToLetters(start.column)}${start.row + 1}`;
  if (rowCount <= 1 && columnCount <= 1) return startText;
  const endText = `${columnIndexToLetters(start.column + columnCount - 1)}${start.row + rowCount}`;
  return `${startText}:${endText}`;
}

export function splitSheetAddress(address: string): { sheetName: string; localAddress: string } {
  const separator = address.lastIndexOf("!");
  if (separator < 1) return { sheetName: "", localAddress: address };
  return {
    sheetName: address.slice(0, separator).replace(/^'|'$/g, "").replaceAll("''", "'"),
    localAddress: address.slice(separator + 1).replaceAll("$", ""),
  };
}

/**
 * Shifts the relative (non-`$`) A1 references inside a formula by the given row/column delta.
 * Handles `A1`, `$A1`, `A$1`, `$A$1`. Does not touch text in quotes, sheet-qualified
 * references (`Sheet1!A1`), structured table references, or R1C1 — those are returned unchanged.
 */
export function translateFormula(formula: string, rowDelta: number, columnDelta: number): string {
  if (rowDelta === 0 && columnDelta === 0) return formula;
  const parts = formula.split(/("(?:[^"]|"")*")/); // keep quoted string literals intact
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // quoted literal
      return part.replace(
        /(')?([A-Za-z0-9_À-￿ ]+'?!)?(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/g,
        (whole, _q, sheetPrefix, colAbs, colLetters, rowAbs, rowDigits) => {
          if (sheetPrefix) return whole; // leave cross-sheet references alone
          const column = colAbs ? columnLettersToIndex(colLetters) : columnLettersToIndex(colLetters) + columnDelta;
          const row = rowAbs ? Number(rowDigits) - 1 : Number(rowDigits) - 1 + rowDelta;
          if (column < 0 || row < 0) return whole;
          return `${colAbs}${columnIndexToLetters(column)}${rowAbs}${row + 1}`;
        },
      );
    })
    .join("");
}
