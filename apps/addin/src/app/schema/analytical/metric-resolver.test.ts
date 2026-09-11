import { describe, expect, it } from "vitest";
import { induceTableSchema } from "../schema-induction.js";
import { fixtureBalanceLike, fixtureTransposed } from "../__fixtures__/tables.js";
import { buildMetricIndex, resolveMetric } from "./metric-resolver.js";
import { buildPeriodIndex } from "./period-index.js";
import { validatePlan } from "./analytical-plan-validator.js";
import { compileAnalyticalPlan } from "./analytical-compiler.js";
import { detectAnalyticalIntent } from "./analytical-intent.js";

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

describe("validatePlan (§15, §47)", () => {
  const { schema, grids } = load(fixtureBalanceLike());
  const periodIndex = buildPeriodIndex(schema, grids);

  it("a well-formed argmax plan validates", () => {
    const intent = detectAnalyticalIntent("Когда активы были максимальными?");
    const c = compileAnalyticalPlan(intent, { schema, grids }, "ru");
    expect(c.kind).toBe("plan");
    if (c.kind === "plan") expect(validatePlan(c.plan, schema, grids, c.periodIndex).ok).toBe(true);
  });

  it("a rank plan without a resolvable horizon is unresolved before validation", () => {
    const intent = detectAnalyticalIntent("Покажи 5 показателей с наибольшим ростом за квартал.");
    const c = compileAnalyticalPlan(intent, { schema, grids }, "ru");
    // there is no "last_quarter" change column in the Balance fixture.
    expect(c.kind === "unresolved" || (c.kind === "plan" && c.plan.assumptions.length > 0)).toBe(true);
  });

  it("validatePlan rejects a temporal op with too few observations", () => {
    // craft a plan then shrink the period index
    const intent = detectAnalyticalIntent("Какие показатели наиболее волатильны?");
    const c = compileAnalyticalPlan(intent, { schema, grids }, "ru");
    expect(c.kind).toBe("plan");
    if (c.kind === "plan") {
      const shrunk = { ...periodIndex, points: periodIndex.points.slice(0, 2) };
      const v = validatePlan(c.plan, schema, grids, shrunk);
      expect(v.ok).toBe(false);
      expect(v.errors.join(" ")).toMatch(/observations/);
    }
  });
});
