import { describe, expect, it } from "vitest";
import { buildDataset } from "./dataset.js";
import { runAnalysis } from "./engine.js";
import { isAnalysisError, type AnalysisRequest, type Expression } from "./types.js";
import { salesAnalysisSnapshot, salesSnapshot } from "./__fixtures__/sales-test-data.js";

const dataset = buildDataset(salesSnapshot());
if ("error" in dataset) throw new Error(dataset.error);

function run(request: AnalysisRequest) {
  const outcome = runAnalysis(dataset as Exclude<typeof dataset, { error: string }>, request);
  if (isAnalysisError(outcome)) throw new Error(`${outcome.code}: ${outcome.error}`);
  return outcome;
}

const absFactMinusPlan: AnalysisRequest = {
  op: "top_n",
  n: 10,
  by: { kind: "abs", value: { kind: "subtract", left: { kind: "column", name: "Fact" }, right: { kind: "column", name: "Plan" } } },
};

// Deterministic expectations, computed directly from Downloads/SheetAgent_Test_Data.xlsx.
describe("Stage 21 — reproduce the real E2E analytical failures deterministically", () => {
  it("exposes the canonical Stage 21.2 selection as exactly E1:L121", () => {
    const snapshot = salesAnalysisSnapshot();
    expect(snapshot.address).toBe("Sales Test Data!E1:L121");
    expect(snapshot.headers).toEqual(["Category", "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue"]);
    expect(snapshot.rowCount).toBe(121);
    expect(snapshot.columnCount).toBe(8);
    expect(snapshot.totalCellCount).toBe(968);
    expect(snapshot.values[1]).toEqual(["Accessories", 127, 93, -34, -0.2677165354330709, 93, 33571, 3122103]);
  });

  it("Top 10 rows by |Fact − Plan| — exact ordering and magnitudes", () => {
    const result = run(absFactMinusPlan);
    expect(result.rowsAnalyzed).toBe(120);
    expect(result.parameters?.["values"]).toEqual([207, 186, 108, 94, 91, 81, 79, 78, 71, 71]);
    // rows: [Date, Region, Manager, Product, Category, Plan, Fact, ...]
    const summary = (result.rows ?? []).map((row) => `${row[1]}/${row[3]} d=${(row[6] as number) - (row[5] as number)}`);
    expect(summary).toEqual([
      "Shymkent/Keyboard d=207",
      "Almaty/Laptop Pro d=-186",
      "Karaganda/Keyboard d=108",
      "Aktobe/Monitor 27 d=94",
      "Astana/Headset d=-91",
      "Astana/Keyboard d=-81",
      "Karaganda/Headset d=79",
      "Astana/Laptop Pro d=-78",
      "Karaganda/Monitor 27 d=-71",
      "Karaganda/Headset d=-71",
    ]);
    expect(result.sourceRows).toEqual([93, 50, 19, 22, 83, 3, 26, 40, 30, 61]);
  });

  it("Region × frequency of |Variance %| > 20% — exact counts (was hallucinated as Shymkent 25/8/32%)", () => {
    const result = run({
      op: "group_by",
      by: ["Region"],
      metrics: [
        { metric: "count", name: "total" },
        {
          metric: "count",
          name: "strong",
          where: { all: [{ left: { kind: "abs", value: { kind: "column", name: "Variance %" } }, operator: ">", value: 0.2 }] },
        },
      ],
      sort: { by: "strong", direction: "desc" },
    });
    const byRegion = Object.fromEntries(
      (result.groups ?? []).map((g) => [
        g.key["Region"],
        { total: g.metrics["total"], strong: g.metrics["strong"], pct: Math.round((1000 * (g.metrics["strong"] as number)) / (g.metrics["total"] as number)) / 10 },
      ]),
    );
    expect(byRegion).toEqual({
      Aktobe: { total: 28, strong: 12, pct: 42.9 },
      Almaty: { total: 28, strong: 11, pct: 39.3 },
      Shymkent: { total: 26, strong: 10, pct: 38.5 },
      Karaganda: { total: 20, strong: 7, pct: 35 },
      Astana: { total: 18, strong: 5, pct: 27.8 },
    });
  });

  it("Category × frequency of |Variance %| > 20% — exact counts", () => {
    const result = run({
      op: "group_by",
      by: ["Category"],
      metrics: [
        { metric: "count", name: "total" },
        {
          metric: "count",
          name: "strong",
          where: { all: [{ left: { kind: "abs", value: { kind: "column", name: "Variance %" } }, operator: ">", value: 0.2 }] },
        },
      ],
    });
    const byCategory = Object.fromEntries((result.groups ?? []).map((g) => [g.key["Category"], { total: g.metrics["total"], strong: g.metrics["strong"] }]));
    expect(byCategory).toEqual({
      Accessories: { total: 48, strong: 16 },
      Electronics: { total: 37, strong: 16 },
      Furniture: { total: 35, strong: 13 },
    });
  });

  // Stage 21.1.1 — the real Excel failure: a bare condition + a "%" threshold.
  const strongByRegion = (strongWhere: unknown) =>
    run({
      op: "group_by",
      by: ["Region"],
      metrics: [
        { metric: "count", name: "total" },
        { metric: "count", name: "strong", where: strongWhere as never },
      ],
      sort: { by: "strong", direction: "desc" },
    });

  const summarise = (result: ReturnType<typeof run>) =>
    Object.fromEntries(
      (result.groups ?? []).map((g) => [
        g.key["Region"],
        {
          total: g.metrics["total"],
          strong: g.metrics["strong"],
          pct: (100 * (g.metrics["strong"] as number)) / (g.metrics["total"] as number),
        },
      ]),
    );

  const EXPECTED = {
    Aktobe: { total: 28, strong: 12 },
    Almaty: { total: 28, strong: 11 },
    Shymkent: { total: 26, strong: 10 },
    Karaganda: { total: 20, strong: 7 },
    Astana: { total: 18, strong: 5 },
  } as const;

  it("ABS(Variance %) > {percent:20} grouped by Region — exact strong counts (was 28/28/100%)", () => {
    const byRegion = summarise(
      strongByRegion({
        left: { kind: "abs", value: { kind: "column", name: "Variance %" } },
        operator: ">",
        value: { kind: "percent", value: 20 },
      }),
    );
    for (const [region, exp] of Object.entries(EXPECTED)) {
      expect({ total: byRegion[region]?.total, strong: byRegion[region]?.strong }).toEqual(exp);
    }
    expect(byRegion["Aktobe"]?.pct).toBeCloseTo(42.857142, 4);
    expect(byRegion["Almaty"]?.pct).toBeCloseTo(39.285714, 4);
    expect(byRegion["Shymkent"]?.pct).toBeCloseTo(38.461538, 4);
    expect(byRegion["Karaganda"]?.pct).toBeCloseTo(35, 6);
    expect(byRegion["Astana"]?.pct).toBeCloseTo(27.777777, 4);
  });

  it("a BARE condition (no {all:[…]} wrapper) is honoured, not treated as match-all", () => {
    // exactly the malformed shape the live planner emitted for the real prompt
    const byRegion = summarise(
      strongByRegion({
        left: { kind: "abs", value: { kind: "column", name: "Variance %" } },
        operator: ">",
        value: 0.2,
      }),
    );
    expect(byRegion["Aktobe"]).toMatchObject({ total: 28, strong: 12 });
    expect(byRegion["Astana"]).toMatchObject({ total: 18, strong: 5 });
    // the bug produced strong === total for every region
    expect(byRegion["Aktobe"]?.strong).not.toBe(byRegion["Aktobe"]?.total);
  });

  it("negative Variance % values satisfy |x| > 20% (e.g. -0.2653)", () => {
    const negStrong = run({
      op: "count",
      where: {
        all: [
          { left: { kind: "abs", value: { kind: "column", name: "Variance %" } }, operator: ">", value: { kind: "percent", value: 20 } },
          { left: { column: "Variance %" }, operator: "<", value: 0 },
        ],
      },
    });
    // there are strong negative deviations in the fixture
    expect(negStrong.value as number).toBeGreaterThan(0);
  });

  it("ABS(Variance %) > 20% by Category — exact strong counts", () => {
    const result = run({
      op: "group_by",
      by: ["Category"],
      metrics: [
        { metric: "count", name: "total" },
        {
          metric: "count",
          name: "strong",
          where: { left: { kind: "abs", value: { kind: "column", name: "Variance %" } }, operator: ">", value: { kind: "percent", value: 20 } },
        },
      ],
    });
    const byCategory = Object.fromEntries((result.groups ?? []).map((g) => [g.key["Category"], { total: g.metrics["total"], strong: g.metrics["strong"] }]));
    expect(byCategory).toEqual({
      Accessories: { total: 48, strong: 16 },
      Electronics: { total: 37, strong: 16 },
      Furniture: { total: 35, strong: 13 },
    });
  });

  it("the Date column is analysed as ISO dates, not Excel serials", () => {
    const distinct = run({ op: "distinct", column: "Date" });
    expect(distinct.rows?.[0]).toEqual(["2026-01-01"]);
    expect(distinct.parameters?.["distinctCount"]).toBe(120);
    const stats = run({ op: "summary_statistics", columns: ["Date"] });
    expect(stats.statistics?.["Date"]?.count).toBe(120);
  });
});

// §8 — mean(abs(x)), abs(mean(x)) and mean(x) are three different metrics and
// must never collapse into one another.
describe("Stage 21.2 §8 — absolute vs signed Variance % by Category", () => {
  const meanBy = (target: Expression) =>
    Object.fromEntries(
      (run({ op: "group_by", by: ["Category"], metrics: [{ metric: "mean", name: "m", target }] }).groups ?? []).map((g) => [
        g.key["Category"],
        g.metrics["m"] as number,
      ]),
    );

  it("mean(abs(Variance %)) — Electronics is the most volatile (17.17%)", () => {
    const m = meanBy({ kind: "abs", value: { kind: "column", name: "Variance %" } });
    expect(m["Accessories"]).toBeCloseTo(0.16505133, 6);
    expect(m["Electronics"]).toBeCloseTo(0.17167145, 6);
    expect(m["Furniture"]).toBeCloseTo(0.14705316, 6);
    // Electronics > Accessories > Furniture
    expect(m["Electronics"]).toBeGreaterThan(m["Accessories"] as number);
    expect(m["Accessories"]).toBeGreaterThan(m["Furniture"] as number);
  });

  it("mean(Variance %) signed — a DIFFERENT ordering (Furniture is largest at 3.23%)", () => {
    const m = meanBy({ kind: "column", name: "Variance %" });
    expect(m["Accessories"]).toBeCloseTo(0.01501900, 6);
    expect(m["Electronics"]).toBeCloseTo(0.01531530, 6);
    expect(m["Furniture"]).toBeCloseTo(0.03229199, 6);
    // signed mean ranks Furniture first — opposite of the absolute metric
    expect(m["Furniture"]).toBeGreaterThan(m["Electronics"] as number);
    expect(m["Furniture"]).toBeGreaterThan(m["Accessories"] as number);
  });

  it("abs(mean(Variance %)) equals |signed mean|, not mean(abs(x))", () => {
    const signed = meanBy({ kind: "column", name: "Variance %" });
    const absOfMean = Math.abs(signed["Electronics"] as number);
    expect(absOfMean).toBeCloseTo(0.01531530, 6);
    expect(absOfMean).not.toBeCloseTo(0.17167145, 3);
  });
});
