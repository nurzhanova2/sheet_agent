import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { induceTableSchema } from "../app/schema/schema-induction.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import { buildFindings, extractFindings, resetFindingIds, type ExtractContext } from "./insight/extract-findings.js";
import { entityAxisOf, groundFindings, groundingContextOf, groundingStats } from "./insight/finding-subject.js";
import { benchmarkPortfolio } from "./harness/sandbox-tables.js";
import { benchmarkOperations } from "./harness/benchmark-tables.js";
import type { EngineResult, ResultField, ResultId, ResultType } from "./types.js";

const METRIC: ResultField = { name: "metric", kind: "metric" };
const NUM = (name: string): ResultField => ({ name, kind: "number" });
const TEXT = (name: string): ResultField => ({ name, kind: "text" });

interface Fixture {
  readonly ctx: ExtractContext;
  readonly schema: ReturnType<typeof induceTableSchema>;
  readonly grids: AnalysisGrids;
}

function fixtureOf(header: string, labels: readonly string[], sheet: string): Fixture {
  const values: CellValue[][] = [
    [header, "Янв", "Дек"],
    ...labels.map((label, i) => [label, 100.5 + i * 10, 130.2 + i * 7] as CellValue[]),
  ];
  const numberFormats = values.map((row, r) => row.map(() => (r === 0 ? "General" : "#,##0.0")));
  const schema = induceTableSchema({
    values,
    numberFormats,
    formulas: values.map((r) => r.map(() => null)),
    sheetName: sheet,
    sourceRange: `${sheet}!A1:C${values.length}`,
    sourceVersion: "v1",
    startsBelowRow1: false,
  });
  const grids: AnalysisGrids = { values, numberFormats };
  return { ctx: { schema, grids, locale: "ru" }, schema, grids };
}

const PRODUCTS = ["Ангара", "Кама", "Нева", "Обь", "Мезень"];
const METRICS = ["Активы", "Обязательства", "Капитал", "Прибыль", "Резервы"];

const productTable = (): Fixture => fixtureOf("Продукт", PRODUCTS, "Продажи");
const metricTable = (): Fixture => fixtureOf("Наименование показателя", METRICS, "Баланс");

let seq = 0;
function result(
  type: ResultType,
  fields: readonly ResultField[],
  rows: readonly (readonly CellValue[])[],
  metadata: Readonly<Record<string, unknown>> = {},
  sheet = "Продажи",
): EngineResult {
  seq += 1;
  return {
    resultId: `res_${seq}` as ResultId,
    tool: "test.tool",
    type,
    fields,
    rows,
    metricKeys: rows.map((r) => String(r[0] ?? "")),
    periodCanonicals: ["2025-01", "2025-12"],
    parents: [],
    sourceRange: `${sheet}!A1:C6`,
    sourceVersion: "v1",
    metadata,
  };
}

const CHANGE_FIELDS = [METRIC, TEXT("startPeriodLabel"), TEXT("endPeriodLabel"), NUM("startValue"), NUM("endValue"), NUM("absoluteChange"), NUM("percentageChange")];

interface Shape {
  readonly name: string;
  readonly build: () => EngineResult;
  readonly fixture: () => Fixture;
  readonly expectScope?: string;
}

const SHAPES: readonly Shape[] = [
  {
    name: "change rows on an entity axis",
    fixture: productTable,
    expectScope: "entity",
    build: () =>
      result("comparison", CHANGE_FIELDS, [
        ["Ангара", "Янв", "Дек", 100, 40, -60, -0.6],
        ["Кама", "Янв", "Дек", 110, 137, 27, 0.245],
      ]),
  },
  {
    name: "change rows on a metric axis",
    fixture: metricTable,
    expectScope: "metric",
    build: () =>
      result(
        "comparison",
        CHANGE_FIELDS,
        [
          ["Активы", "Янв", "Дек", 100, 140, 40, 0.4],
          ["Капитал", "Янв", "Дек", 120, 137, 17, 0.14],
        ],
        {},
        "Баланс",
      ),
  },
  {
    name: "series",
    fixture: productTable,
    expectScope: "entity",
    build: () =>
      result("series", [METRIC, TEXT("periodLabel"), NUM("value")], [
        ["Ангара", "Янв", 100],
        ["Ангара", "Фев", 120],
        ["Ангара", "Мар", 90],
        ["Ангара", "Апр", 140],
      ]),
  },
  {
    name: "volatility score",
    fixture: productTable,
    expectScope: "entity",
    build: () =>
      result("volatility", [METRIC, NUM("score")], [
        ["Ангара", 0.42],
        ["Кама", 0.11],
      ]),
  },
  {
    name: "trend",
    fixture: productTable,
    expectScope: "entity",
    build: () =>
      result("trend", [METRIC, NUM("slope"), NUM("normalizedSlope"), TEXT("direction"), NUM("r2"), NUM("periods")], [
        ["Ангара", -27.2, -0.4, "decreasing", 0.88, 12],
        ["Кама", 4.1, 0.1, "increasing", 0.55, 12],
      ]),
  },
  {
    name: "monotonicity",
    fixture: productTable,
    expectScope: "entity",
    build: () =>
      result("monotonicity", [METRIC, NUM("strictIncreasing"), NUM("strictDecreasing"), NUM("periods")], [
        ["Ангара", 2, 5, 12],
        ["Кама", 7, 1, 12],
      ]),
  },
  {
    name: "direction changes",
    fixture: productTable,
    expectScope: "entity",
    build: () =>
      result("direction_changes", [METRIC, NUM("directionChangeCount")], [
        ["Ангара", 4],
        ["Кама", 1],
      ]),
  },
  {
    name: "table overview",
    fixture: productTable,
    expectScope: "table",
    build: () =>
      result("schema", [TEXT("sheet"), TEXT("range"), TEXT("orientation"), NUM("metricCount"), NUM("periodCount")], [
        ["Продажи", "Продажи!A1:C6", "row_metrics", 5, 2],
      ]),
  },
  {
    name: "sandbox clusters",
    fixture: productTable,
    expectScope: "group",
    build: () =>
      result(
        "derived",
        [METRIC, TEXT("group"), NUM("profile")],
        [
          ["Ангара", "1", 0.9],
          ["Кама", "1", 0.8],
          ["Нева", "2", 0.1],
        ],
        { sandbox: true, outputName: "groups" },
      ),
  },
  {
    name: "sandbox generic measurement",
    fixture: productTable,
    expectScope: "entity",
    build: () =>
      result(
        "derived",
        [METRIC, NUM("score")],
        [
          ["Ангара", 0.91],
          ["Кама", 0.42],
          ["Нева", 0.13],
        ],
        { sandbox: true },
      ),
  },
  {
    name: "value at a period",
    fixture: productTable,
    expectScope: "entity",
    build: () =>
      result("value", [METRIC, TEXT("periodLabel"), NUM("value")], [
        ["Ангара", "Дек", 140],
      ]),
  },
  {
    name: "empty set",
    fixture: productTable,
    expectScope: "table",
    build: () => result("filtered_set", [METRIC, NUM("value")], [], { predicate: "value > 1000" }),
  },
  {
    name: "ranking over more rows than are stated",
    fixture: productTable,
    build: () =>
      result(
        "ranked_set",
        CHANGE_FIELDS,
        PRODUCTS.map((p, i) => [p, "Янв", "Дек", 100 + i, 130 + i * 3, 30 + i * 2, 0.3 - i * 0.02]),
        { ranking: { field: "percentageChange", magnitude: "relative" } },
      ),
  },
];

describe("Stage 27.2B §8/§39 — every extraction path carries a grounded subject", () => {
  for (const shape of SHAPES) {
    it(shape.name, () => {
      resetFindingIds();
      const fixture = shape.fixture();
      const findings = extractFindings(shape.build(), fixture.ctx);
      expect(findings.length, "the shape produced no finding at all").toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.subjectRef, `${shape.name}: ${finding.findingType} has no subjectRef`).toBeDefined();
      }
      const { held } = groundFindings(findings, groundingContextOf(fixture.schema, fixture.grids));
      expect(held.map((h) => `${h.finding.findingType}/${h.finding.subject}: ${h.reason}`)).toEqual([]);
      if (shape.expectScope) {
        expect(findings[0]!.subjectRef?.scope).toBe(shape.expectScope);
      }
    });
  }

  it("§38 — the held ratio across every shape is zero", () => {
    resetFindingIds();
    let extracted = 0;
    let heldTotal = 0;
    const heldByType: Record<string, number> = {};
    for (const shape of SHAPES) {
      const fixture = shape.fixture();
      const grounded = groundFindings(extractFindings(shape.build(), fixture.ctx), groundingContextOf(fixture.schema, fixture.grids));
      const stats = groundingStats(grounded);
      extracted += stats.extractedFindings;
      heldTotal += stats.heldFindings;
      for (const [type, count] of Object.entries(stats.heldByFindingType)) heldByType[type] = (heldByType[type] ?? 0) + count;
    }
    expect(extracted).toBeGreaterThan(20);
    expect({ extracted, heldTotal, heldByType }).toEqual({ extracted, heldTotal: 0, heldByType: {} });
  });
});

describe("Stage 27.2B §6 — the entity axis comes from the schema, not from prose", () => {
  it("a dimension header makes the row axis an entity axis", () => {
    const { schema, grids } = productTable();
    const axis = entityAxisOf(schema, grids);
    expect(axis.kind).toBe("entity");
    expect(axis.labels).toEqual(PRODUCTS);
  });

  it("an axis-noun header makes the row axis a metric axis", () => {
    const { schema, grids } = metricTable();
    const axis = entityAxisOf(schema, grids);
    expect(axis.kind).toBe("metric");
    expect(axis.labels).toEqual(METRICS);
  });

  it("no schema means no axis, and nothing is demanded", () => {
    expect(entityAxisOf(undefined).kind).toBe("none");
    expect(groundingContextOf(undefined).axis.labels).toEqual([]);
  });

  it("the two live benchmark tables classify as the live suite assumes", () => {
    const portfolio = benchmarkPortfolio();
    const portfolioAxis = entityAxisOf(portfolio.schema, portfolio.grids);
    expect(portfolioAxis.kind).toBe("entity");
    expect(portfolioAxis.labels).toContain("Ангара");
    expect(portfolioAxis.labels).toContain("Обь");

    const operations = benchmarkOperations();
    const operationsAxis = entityAxisOf(operations.schema, operations.grids);
    expect(operationsAxis.kind).toBe("metric");
    expect(operationsAxis.labels).toContain("Стоимость обработки");
  });
});

describe("Stage 27.2B §10 — buildFindings feeds narration only grounded findings", () => {
  it("an answer over a real table holds nothing back", () => {
    resetFindingIds();
    const fixture = productTable();
    const primary = result("comparison", CHANGE_FIELDS, [
      ["Ангара", "Янв", "Дек", 100, 40, -60, -0.6],
      ["Кама", "Янв", "Дек", 110, 137, 27, 0.245],
    ]);
    const supporting = result("volatility", [METRIC, NUM("score")], [
      ["Нева", 0.42],
      ["Обь", 0.11],
    ]);
    const findings = buildFindings(primary, [supporting], fixture.ctx);
    const grounded = groundFindings(findings, groundingContextOf(fixture.schema, fixture.grids));
    expect(grounded.held).toEqual([]);
    expect(grounded.visible.length).toBe(findings.length);
    for (const finding of grounded.visible) {
      expect(finding.subjectRef?.entityLabel ?? finding.subjectRef?.members?.[0]).toBeTruthy();
    }
  });

  it("a row whose subject column is empty is held, not narrated", () => {
    resetFindingIds();
    const fixture = productTable();
    const findings = extractFindings(
      result("comparison", CHANGE_FIELDS, [["", "Янв", "Дек", 100, 40, -60, -0.6]]),
      fixture.ctx,
    );
    const grounded = groundFindings(findings, groundingContextOf(fixture.schema, fixture.grids));
    expect(grounded.visible).toEqual([]);
    expect(grounded.held[0]!.reason).toBe("ENTITY_SUBJECT_REQUIRED");
  });
});
