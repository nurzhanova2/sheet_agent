// Stage 24.5.4 — deterministic compilation of "N <entities> with worst/best <metric>".
import { describe, expect, it } from "vitest";
import { detectGroupedRanking, planGroupedRanking } from "./grouped-ranking.js";

const HEADERS = [
  "Date", "Region", "Manager", "Product", "Category",
  "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue",
] as const;
const NUMERIC = new Set(["Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue"]);

describe("detectGroupedRanking", () => {
  it("reads the canonical RU request", () => {
    expect(detectGroupedRanking("покажи 3 менеджеров с худшим Variance")).toEqual({
      n: 3, entityNoun: "менеджеров", metricPhrase: "Variance", direction: "asc",
    });
  });

  it("reads best/highest as descending (EN + RU)", () => {
    expect(detectGroupedRanking("5 regions with the highest Revenue")).toMatchObject({ n: 5, direction: "desc" });
    expect(detectGroupedRanking("покажи 3 менеджеров с лучшим Variance")).toMatchObject({ direction: "desc" });
    expect(detectGroupedRanking("2 региона с наибольшей Revenue")).toMatchObject({ n: 2, entityNoun: "региона", metricPhrase: "Revenue", direction: "desc" });
    expect(detectGroupedRanking("2 категории с наименьшим Fact")).toMatchObject({ n: 2, entityNoun: "категории", metricPhrase: "Fact", direction: "asc" });
  });

  it("strips a leading aggregate word from the metric phrase", () => {
    expect(detectGroupedRanking("3 менеджеров с наихудшим средним Variance")).toMatchObject({ metricPhrase: "Variance" });
    expect(detectGroupedRanking("3 managers with the worst average Variance")).toMatchObject({ metricPhrase: "Variance" });
  });

  it("does NOT match raw-value ranking (no 'с <superlative> <metric>' structure)", () => {
    expect(detectGroupedRanking("покажи 3 худших значения Variance")).toBeNull();
    expect(detectGroupedRanking("3 наибольших значения Revenue")).toBeNull();
    expect(detectGroupedRanking("топ 3 по Variance")).toBeNull();
    expect(detectGroupedRanking("сгруппируй по менеджеру")).toBeNull();
  });
});

describe("planGroupedRanking", () => {
  it("compiles manager + Variance (worst) into a bottom mean pipeline", () => {
    const req = detectGroupedRanking("покажи 3 менеджеров с худшим Variance")!;
    expect(planGroupedRanking(req, HEADERS, NUMERIC)).toEqual({
      kind: "plan", entityColumn: "Manager", metricColumn: "Variance", aggregation: "mean", direction: "asc", n: 3,
    });
  });

  it("prefers the exact 'Variance' column over 'Variance %'", () => {
    const req = detectGroupedRanking("покажи 3 менеджеров с худшим Variance")!;
    expect((planGroupedRanking(req, HEADERS, NUMERIC) as { metricColumn: string }).metricColumn).toBe("Variance");
  });

  it("resolves region / category / product entity nouns (EN + RU)", () => {
    expect(planGroupedRanking(detectGroupedRanking("2 региона с наибольшей Revenue")!, HEADERS, NUMERIC)).toMatchObject({ entityColumn: "Region", metricColumn: "Revenue", direction: "desc" });
    expect(planGroupedRanking(detectGroupedRanking("2 категории с наименьшим Fact")!, HEADERS, NUMERIC)).toMatchObject({ entityColumn: "Category", metricColumn: "Fact", direction: "asc" });
    expect(planGroupedRanking(detectGroupedRanking("3 products with the best Variance")!, HEADERS, NUMERIC)).toMatchObject({ entityColumn: "Product", metricColumn: "Variance", direction: "desc" });
  });

  it("reports an unknown entity column", () => {
    expect(planGroupedRanking(detectGroupedRanking("3 salespeople with the worst Variance")!, HEADERS, NUMERIC).kind).toBe("unknown_entity");
  });

  it("reports an unknown / non-numeric metric", () => {
    expect(planGroupedRanking(detectGroupedRanking("3 менеджеров с худшим Product")!, HEADERS, NUMERIC).kind).toBe("unknown_metric");
  });

  it("reports an ambiguous entity noun (two manager-ish columns)", () => {
    const req = detectGroupedRanking("покажи 3 менеджеров с худшим Variance")!;
    const p = planGroupedRanking(req, [...HEADERS, "Manager Name"], NUMERIC);
    expect(p.kind).toBe("ambiguous_entity");
    if (p.kind === "ambiguous_entity") expect([...p.candidates].sort()).toEqual(["Manager", "Manager Name"]);
  });
});
