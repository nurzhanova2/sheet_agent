import { describe, expect, it } from "vitest";
import { induceTableSchema } from "../schema-induction.js";
import { fixtureBalanceLike, fixtureTransposed } from "../__fixtures__/tables.js";
import { buildMetricIndex, resolveMetric } from "./metric-resolver.js";

function load(fx: ReturnType<typeof fixtureBalanceLike>) {
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: `v@${fx.address}`,
    startsBelowRow1: fx.startsBelowRow1,
  });
  return { schema, grids: { values: fx.values, numberFormats: fx.numberFormats } };
}

describe("resolveMetric (§7, §50)", () => {
  const { schema } = load(fixtureBalanceLike());
  const index = buildMetricIndex(schema);

  it("exact and case-insensitive row-axis members", () => {
    expect(resolveMetric("Активы", index)).toMatchObject({ kind: "resolved", entry: { label: "Активы" } });
    expect(resolveMetric("активы", index)).toMatchObject({ kind: "resolved", entry: { label: "Активы" } });
  });

  it("a shared stem across RU case endings resolves ('активов' → 'Активы')", () => {
    const r = resolveMetric("активов", index);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entry.label).toBe("Активы");
  });

  it("a multi-word member resolves on a normalised prefix", () => {
    const r = resolveMetric("ссудный портфель", index);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entry.label).toBe("Ссудный портфель");
  });

  it("an unknown needle is 'unknown', never a silent pick", () => {
    expect(resolveMetric("Прибыль до налогов", index).kind).toBe("unknown");
  });

  it("transpose: a metric column resolves as a 'column' entry", () => {
    const t = load(fixtureTransposed());
    const ti = buildMetricIndex(t.schema);
    const r = resolveMetric("Revenue", ti);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entry.kind).toBe("column");
  });
});
