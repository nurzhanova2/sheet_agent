import { describe, expect, it } from "vitest";
import { detectSchemaIntent, runSchemaAnalysis } from "./schema-result.js";
import { fixtureBalanceLike, fixtureHierarchical, type FixtureSnapshot } from "./__fixtures__/tables.js";
import { induceTableSchema } from "./schema-induction.js";

function describeOf(fx: FixtureSnapshot): string {
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: "v1",
    startsBelowRow1: false,
  });
  const out = runSchemaAnalysis(schema, { values: fx.values, numberFormats: fx.numberFormats }, detectSchemaIntent("о чем эта таблица"), "ru");
  return out.describeText ?? "";
}

describe("Stage 27.7 §6 — the table overview leads with what is in the table", () => {
  it("opens with the indicators and the span, not with the header depth", () => {
    const text = describeOf(fixtureBalanceLike());
    const first = text.split("\n")[0] ?? "";
    expect(first).toMatch(/^В таблице \d+ показателей за \d+ периодов: «/u);
    expect(first).not.toMatch(/заголовок|иерархическ|многоуровнев/iu);
  });

  it("names the time range the data covers", () => {
    expect(describeOf(fixtureBalanceLike())).toMatch(/Данные охватывают период с .+ по .+\./u);
  });

  it("says what can be asked of it", () => {
    expect(describeOf(fixtureBalanceLike())).toMatch(/Можно сравнить любые два периода/u);
  });

  it("keeps the layout classification, but last", () => {
    const text = describeOf(fixtureBalanceLike());
    const lines = text.split("\n");
    const structure = lines.findIndex((l) => /^Формат —/u.test(l));
    expect(structure).toBeGreaterThan(0);
    expect(structure).toBe(lines.length - 1);
    expect(lines[structure]).toMatch(/иерархическ|многоуровнев|матрица|отчёт|таблица|ряд|структура/u);
  });

  it("never prints an internal measure vocabulary at the reader", () => {
    const text = describeOf(fixtureBalanceLike());
    expect(text).not.toMatch(/numeric|absolute Δ|percent Δ|amount_like/u);
  });

  it("works the same on a deeper hierarchical report", () => {
    const text = describeOf(fixtureHierarchical());
    expect(text.split("\n")[0]).toMatch(/^В таблице \d+ показателей/u);
  });
});
