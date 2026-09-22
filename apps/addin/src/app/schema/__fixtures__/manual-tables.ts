// ---------------------------------------------------------------------------
// Stage 26.8 §39/§40/§41/§49 — the tables a HUMAN will test on.
//
// One definition, two consumers: the §42 production smoke suite runs against
// these in memory, and `scripts/build-manual-workbook.mjs` writes the same
// numbers into `SheetAgent_V2_Manual_Test.xlsx`. A tester's Excel and the
// automated smoke therefore see the same data, and a bug report about "Узел
// сборки" can be reproduced without asking what was on the screen.
//
// §41 — two of these are UNSEEN: they appear in no benchmark, no Stage 24-26
// test, and no prompt. Nothing in production keys off these strings, and
// nothing may start to.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import type { FixtureSnapshot } from "./tables.js";

function mk(
  sheetName: string,
  address: string,
  values: readonly (readonly CellValue[])[],
  fmt: readonly (readonly string[])[],
): FixtureSnapshot {
  const cols = values.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    sheetName,
    address,
    values,
    numberFormats: fmt,
    formulas: values.map(() => Array.from({ length: cols }, () => null)),
    startsBelowRow1: false,
  };
}

const MONTHS = ["Янв 2025", "Фев 2025", "Мар 2025", "Апр 2025", "Май 2025", "Июн 2025"] as const;

/**
 * §41 — an UNSEEN metrics-over-months table. Deliberately mixed units: two
 * percentages, an amount, a count and an index, so "what changed the most"
 * cannot be answered by absolute size alone.
 */
export function unseenOperations(): FixtureSnapshot {
  const series: Readonly<Record<string, readonly number[]>> = {
    "Выпуск продукции, шт": [12_400, 12_950, 12_100, 13_480, 13_900, 14_220],
    "Доля брака, %": [0.042, 0.038, 0.051, 0.033, 0.029, 0.031],
    "Загрузка линии, %": [0.78, 0.81, 0.74, 0.86, 0.89, 0.88],
    "Себестоимость единицы, ₸": [1_840, 1_795, 1_910, 1_760, 1_705, 1_738],
    "Простои, часов": [46, 39, 61, 28, 22, 35],
    "Индекс качества": [102.4, 103.1, 99.8, 104.6, 106.2, 105.4],
  };
  const header: CellValue[] = ["Показатель", ...MONTHS];
  const rows: CellValue[][] = [header];
  for (const [name, values] of Object.entries(series)) rows.push([name, ...values]);
  const fmt = rows.map((row, r) =>
    r === 0
      ? row.map(() => "General")
      : row.map((_, c) => (c === 0 ? "General" : String(row[0]).includes("%") ? "0.0%" : String(row[0]).includes("Индекс") ? "0.0" : "#,##0")),
  );
  return mk("Узел сборки", "Узел сборки!A1:G7", rows, fmt);
}

/**
 * §41 — a second UNSEEN table, hierarchical and quarterly, so a tester can
 * switch between two shapes as well as two subjects.
 */
export function unseenBranchQuarters(): FixtureSnapshot {
  // Quarter ends, LABELLED. Two earlier cuts of this sheet were unanswerable:
  // "I кв. 2025" is not a period the index parses, and a single header row of
  // raw date serials is not read as a header at all (the induction named the
  // columns "col 2".."col 5"). Both were caught by this file's own guard rather
  // than by a person opening the workbook.
  const quarterEnds = ["Мар 2025", "Июн 2025", "Сен 2025", "Дек 2025"] as const;
  const rows: CellValue[][] = [
    ["Филиал / показатель", ...quarterEnds],
    ["Север", null, null, null, null],
    ["  Выручка, млн ₸", 412, 438, 401, 466],
    ["  Расходы, млн ₸", 351, 362, 370, 379],
    ["  Клиентов", 1_240, 1_301, 1_288, 1_402],
    ["Юг", null, null, null, null],
    ["  Выручка, млн ₸", 286, 274, 309, 322],
    ["  Расходы, млн ₸", 233, 241, 248, 252],
    ["  Клиентов", 903, 894, 951, 1_004],
  ];
  const fmt = rows.map((row, r) => (r === 0 ? row.map(() => "General") : row.map((_, c) => (c === 0 ? "General" : "#,##0"))));
  return mk("Филиалы", "Филиалы!A1:E10", rows, fmt);
}

/**
 * §39 — the canonical Sales Test Data shape: flat records, the table the Stage
 * 24.5 mutation and grouping behaviour was built for. Kept a RECORDS table on
 * purpose, because that is what makes it Stage 24's and not V2's (§6).
 */
export function salesTestData(): FixtureSnapshot {
  const regions = ["Север", "Юг", "Восток", "Запад"] as const;
  const products = ["Альфа", "Бета", "Гамма"] as const;
  const managers = ["Асель", "Данияр", "Ирина", "Тимур"] as const;
  const rows: CellValue[][] = [["Дата", "Регион", "Продукт", "Менеджер", "План", "Факт"]];
  for (let i = 0; i < 36; i += 1) {
    const month = (i % 6) + 1;
    rows.push([
      `2025-0${month}-15`,
      regions[i % regions.length]!,
      products[i % products.length]!,
      managers[i % managers.length]!,
      1_000 + ((i * 37) % 900),
      900 + ((i * 53) % 1_400),
    ]);
  }
  const fmt = rows.map((_, r) =>
    r === 0 ? ["General", "General", "General", "General", "General", "General"] : ["yyyy-mm-dd", "General", "General", "General", "#,##0", "#,##0"],
  );
  return mk("Sales Test Data", "Sales Test Data!A1:F37", rows, fmt);
}

/** §49 — the sandbox sheet. Safe to overwrite; nothing reads it back. */
export function mutationSandbox(): FixtureSnapshot {
  const rows: CellValue[][] = [["Позиция", "Количество", "Цена", "Сумма"]];
  for (let i = 0; i < 12; i += 1) rows.push([`Позиция ${i + 1}`, 10 + i * 3, 250 + i * 17, (10 + i * 3) * (250 + i * 17)]);
  const fmt = rows.map((_, r) => (r === 0 ? ["General", "General", "General", "General"] : ["General", "#,##0", "#,##0", "#,##0"]));
  return mk("Песочница", "Песочница!A1:D13", rows, fmt);
}

/** §49 — every sheet of the manual-testing workbook, in the order it is written. */
export const MANUAL_WORKBOOK: readonly FixtureSnapshot[] = [unseenOperations(), unseenBranchQuarters(), salesTestData(), mutationSandbox()];
