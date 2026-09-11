// ---------------------------------------------------------------------------
// Stage 22.3 — deterministic `/formula` calculated-column builder.
//
// `/formula` no longer lets the model author action ranges. SheetAgent resolves
// EVERYTHING from the current selection snapshot:
//   • source table  = the selected sheet + range (never another worksheet);
//   • column refs    = validated against the actual headers (no assumed F/G);
//   • destination    = existing column if the name already exists, else the
//                      column immediately right of the selection;
//   • header + formulas = ONE proposal (set_values <Col>1 + fill_formula
//                         <Col>2:<Col><lastRow>), applied/undone atomically.
// If anything can't be resolved deterministically it returns user guidance and
// proposes NOTHING.
// ---------------------------------------------------------------------------

import type { SelectionSnapshot } from "../workbook-context.js";
import type { ResponseLanguage } from "../language.js";
import { columnIndexToLetters, parseLocalRange, splitSheetAddress } from "../a1.js";
import { validateAction, type WorkbookAction } from "../workbook-actions.js";
import { deriveColumnName } from "./formula-header.js";

export interface FormulaColumnBuild {
  readonly text: string;
  readonly actions: readonly WorkbookAction[];
}
export interface FormulaColumnError {
  /** User-facing guidance. No mutation is proposed. */
  readonly error: string;
}
export function isFormulaColumnError(v: FormulaColumnBuild | FormulaColumnError): v is FormulaColumnError {
  return "error" in v;
}

const CMP_OPS: Record<string, string> = { ">": ">", "<": "<", ">=": ">=", "<=": "<=", "=": "=", "==": "=", "!=": "<>", "<>": "<>" };

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function headerIndex(headers: readonly string[], name: string): number {
  const wanted = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === wanted);
}

// Trailing "на <Sheet>" / "on <Sheet>" / "в листе <Sheet>" that names a sheet.
// `\b` is ASCII-only, so the Cyrillic keywords are anchored on (^|\s) instead.
const CROSS_SHEET_RE =
  /(?:(?:^|\s)на|(?:^|\s)в\s+лист[еа]?|\bon\s+sheet\b|\bon\b)\s+["'«]?([\p{L}][\p{L}\p{N} _-]{1,40}?)["'»]?\s*$/iu;

/** Returns the sheet name the args try to target when it differs from the selection's sheet. */
function crossSheetTarget(args: string, currentSheet: string): string | null {
  const m = CROSS_SHEET_RE.exec(args.trim());
  if (!m?.[1]) return null;
  const name = m[1].trim();
  return name.toLowerCase() === currentSheet.trim().toLowerCase() ? null : name;
}

interface IfSpec {
  readonly kind: "if";
  readonly left: string;
  readonly op: string;
  readonly right: string;
  readonly whenTrue: string;
  readonly whenFalse: string;
}
interface ExprSpec {
  readonly kind: "expr";
  readonly rhs: string;
}

function parseSpec(args: string): IfSpec | ExprSpec | null {
  const ifMatch =
    /(?:если|if)\s+(.+?)\s*(>=|<=|<>|!=|==|=|>|<)\s*(.+?)\s*["«]([^"»]*)["»]\s*(?:,|иначе|else|otherwise|:)?\s*["«]([^"»]*)["»]/i.exec(
      args,
    );
  if (ifMatch) {
    return {
      kind: "if",
      left: (ifMatch[1] ?? "").trim(),
      op: ifMatch[2] ?? ">",
      right: (ifMatch[3] ?? "").trim(),
      whenTrue: ifMatch[4] ?? "",
      whenFalse: ifMatch[5] ?? "",
    };
  }
  const eq = /=\s*([^=]+?)\s*$/.exec(args);
  if (eq?.[1] && /[A-Za-zА-Яа-яЁё]/.test(eq[1])) return { kind: "expr", rhs: eq[1].trim() };
  return null;
}

/** Compiles an arithmetic RHS ("Revenue - Cost") into "=<L>row<op>...". */
function compileArith(
  rhs: string,
  headers: readonly string[],
  firstColumn: number,
  row: number,
): { formula: string; refs: readonly string[] } | { missing: string } {
  let work = ` ${rhs} `;
  const refs: string[] = [];
  [...headers]
    .map((h, i) => ({ h, i }))
    .sort((a, b) => b.h.length - a.h.length)
    .forEach(({ h, i }) => {
      const re = new RegExp(esc(h), "gi");
      if (re.test(work)) {
        work = work.replace(re, ` @@${i}@@ `);
        if (!refs.includes(h)) refs.push(h);
      }
    });
  const tokens = work.split(/\s*([+\-*/()])\s*/).map((t) => t.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const tok of tokens) {
    if (/^[+\-*/()]$/.test(tok)) { parts.push(tok); continue; }
    const ref = /^@@(\d+)@@$/.exec(tok);
    if (ref) { parts.push(`${columnIndexToLetters(firstColumn + Number(ref[1]))}${row}`); continue; }
    if (/^-?\d[\d.]*$/.test(tok)) { parts.push(tok); continue; }
    return { missing: tok };
  }
  return { formula: `=${parts.join("")}`, refs };
}

export function buildFormulaColumn(
  selection: SelectionSnapshot,
  args: string,
  language: ResponseLanguage,
): FormulaColumnBuild | FormulaColumnError {
  const ru = language === "ru";
  const sheetName = splitSheetAddress(selection.address).sheetName || selection.sheetName;
  const local = splitSheetAddress(selection.address).localAddress || selection.address;

  // 1 — never redirect to another worksheet.
  const other = crossSheetTarget(args, sheetName);
  if (other) {
    return {
      error: ru
        ? `Выберите нужный диапазон на листе «${other}» (со столбцами Plan и Fact) и повторите /formula.`
        : `Select the intended data range on the "${other}" sheet (with the Plan and Fact columns), then run /formula again.`,
    };
  }

  // 2 — need a real table: headers + at least one data row.
  const headers = selection.headers ?? [];
  let range;
  try {
    range = parseLocalRange(local);
  } catch {
    return { error: ru ? "Не удалось определить диапазон выделения." : "Could not read the selected range." };
  }
  if (headers.length < 2 || range.rowCount < 2) {
    return {
      error: ru
        ? "Выделите таблицу/диапазон со столбцами Plan и Fact, затем снова запустите /formula."
        : "Select the table/range containing Plan and Fact, then run /formula again.",
    };
  }

  const spec = parseSpec(args);
  if (!spec) {
    return {
      error: ru
        ? 'Опишите столбец как `Имя = выражение` или `если КолонкаA > КолонкаB "текст1" иначе "текст2"`.'
        : 'Describe the column as `Name = expression` or `if ColumnA > ColumnB "text1" else "text2"`.',
    };
  }

  const firstDataRow = range.start.row + 2; // 1-based sheet row of the first data row
  const lastDataRow = range.end.row + 1;
  const firstColumn = range.start.column;

  // 3 — compile the formula from validated header positions.
  let formula: string;
  const missing: string[] = [];
  if (spec.kind === "if") {
    const li = headerIndex(headers, spec.left);
    const rimatch = headerIndex(headers, spec.right);
    if (li < 0) missing.push(spec.left);
    if (rimatch < 0) missing.push(spec.right);
    if (missing.length === 0) {
      const op = CMP_OPS[spec.op] ?? ">";
      const l = `${columnIndexToLetters(firstColumn + li)}${firstDataRow}`;
      const r = `${columnIndexToLetters(firstColumn + rimatch)}${firstDataRow}`;
      formula = `=IF(${l}${op}${r},"${spec.whenTrue}","${spec.whenFalse}")`;
    } else {
      formula = "";
    }
  } else {
    const compiled = compileArith(spec.rhs, headers, firstColumn, firstDataRow);
    if ("missing" in compiled) {
      missing.push(compiled.missing);
      formula = "";
    } else {
      formula = compiled.formula;
    }
  }
  if (missing.length > 0) {
    const list = [...new Set(missing)].join(", ");
    return {
      error: ru
        ? `Выделите таблицу/диапазон со столбцами: ${list}, затем снова запустите /formula.`
        : `Select the table/range containing the columns: ${list}, then run /formula again.`,
    };
  }

  // 4 — destination column: reuse an existing header, else the next column.
  const name = deriveColumnName(args);
  const existingIdx = name ? headerIndex(headers, name) : -1;
  const isNew = existingIdx < 0;
  if (isNew && !name) {
    return {
      error: ru
        ? "Назовите новый столбец: `/formula в <Имя> …`."
        : "Name the new column: `/formula in <Name> …`.",
    };
  }
  const destColumn = isNew ? range.end.column + 1 : firstColumn + existingIdx;
  const destLetter = columnIndexToLetters(destColumn);
  const headerRow = range.start.row + 1;

  // 5 — build the proposal and fail closed if any part is invalid.
  const candidates: unknown[] = [];
  if (isNew) {
    candidates.push({
      type: "set_values",
      sheetName,
      range: `${destLetter}${headerRow}:${destLetter}${headerRow}`,
      description: ru ? `Заголовок «${name}» в ${destLetter}${headerRow}` : `Header "${name}" in ${destLetter}${headerRow}`,
      payload: { values: [[name]] },
    });
  }
  candidates.push({
    type: "fill_formula",
    sheetName,
    range: `${destLetter}${firstDataRow}:${destLetter}${lastDataRow}`,
    description: ru
      ? `Формула ${formula} в ${destLetter}${firstDataRow}:${destLetter}${lastDataRow}`
      : `Formula ${formula} across ${destLetter}${firstDataRow}:${destLetter}${lastDataRow}`,
    payload: { formula, direction: "down" },
  });

  const actions: WorkbookAction[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const result = validateAction(candidate, index);
    if (typeof result === "string") {
      return {
        error: ru
          ? `Не удалось собрать корректное действие для формулы (${result}). Изменения не предложены.`
          : `Could not build a valid formula action (${result}). No change was proposed.`,
      };
    }
    actions.push(result);
  }

  const target = `${destLetter}${firstDataRow}:${destLetter}${lastDataRow}`;
  const text = isNew
    ? ru
      ? `Новый столбец «${name}»: заголовок ${destLetter}${headerRow} = «${name}» и формула \`${formula}\` в ${target}. Подтвердите изменение.`
      : `New column "${name}": header ${destLetter}${headerRow} = "${name}" and formula \`${formula}\` across ${target}. Approve the change.`
    : ru
      ? `Столбец «${name}» уже существует: формула \`${formula}\` в ${target}. Подтвердите изменение.`
      : `Column "${name}" already exists: formula \`${formula}\` across ${target}. Approve the change.`;

  return { text, actions };
}
