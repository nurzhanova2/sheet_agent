import { describe, expect, it } from "vitest";
import { runAnalysisBatch } from "./index.js";
import { deriveVerifiedFacts, validateClaimsAgainstFacts, type ShareFact, type PairFact, type RankingFact, type ComparisonFact, type VerifiedFact } from "./facts.js";
import { salesSnapshot } from "./__fixtures__/sales-test-data.js";

const snapshot = salesSnapshot();
const STRUCTURAL = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 100, 120, 121]);

function facts(request: unknown): readonly VerifiedFact[] {
  return runAnalysisBatch(snapshot, [request]).facts;
}
const byKind = <K extends VerifiedFact["kind"]>(list: readonly VerifiedFact[], kind: K) =>
  list.filter((fact): fact is Extract<VerifiedFact, { kind: K }> => fact.kind === kind);

describe("§4 — Revenue shares are engine-produced and sum to 100%", () => {
  const revenueFacts = facts({
    op: "group_by",
    by: ["Category"],
    metrics: [{ metric: "sum", name: "revenue", target: { kind: "column", name: "Revenue" } }],
  });
  const shares = byKind(revenueFacts, "share") as ShareFact[];

  it("emits one share per Category, summing to 1 within tolerance", () => {
    const revenueShares = shares.filter((fact) => fact.ofWhat === "revenue");
    expect(revenueShares).toHaveLength(3);
    const total = revenueShares.reduce((sum, fact) => sum + fact.value, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("matches the recorded canonical percentages", () => {
    const pct = Object.fromEntries(shares.filter((f) => f.ofWhat === "revenue").map((f) => [f.group, f.value * 100]));
    expect(pct["Accessories"]).toBeCloseTo(10.0642, 3);
    expect(pct["Electronics"]).toBeCloseTo(65.9605, 3);
    expect(pct["Furniture"]).toBeCloseTo(23.9753, 3);
  });

  it("the model may NOT restate a hand-divided share that is not a fact", () => {
    // 434805308 / 2849711102 = 0.1526 → 15.26% is derivable from two scalar facts but is NOT a share fact
    const reasons = validateClaimsAgainstFacts("Accessories revenue is 15.26% of Electronics revenue.", revenueFacts, STRUCTURAL);
    expect(reasons.join(" ")).toMatch(/not VERIFIED FACTS/i);
  });

  it("the model MAY restate an engine share verbatim", () => {
    const reasons = validateClaimsAgainstFacts("Electronics holds a 65.96% share of Revenue; Accessories 10.06%.", revenueFacts, STRUCTURAL);
    expect(reasons).toHaveLength(0);
  });
});

describe("§21.2.6 — filtered group counts include a deterministic overall percentage", () => {
  const filtered = facts({
    op: "group_by",
    by: ["Category"],
    metrics: [{
      metric: "count",
      name: "above20",
      where: { left: { kind: "abs", value: { kind: "column", name: "Variance %" } }, operator: ">", value: { kind: "percent", value: 20 } },
    }],
  });

  it("emits 45 / 120 = 37.50% without model arithmetic", () => {
    const overallScalars = byKind(filtered, "scalar").filter((fact) => fact.group === "Overall");
    expect(overallScalars.map((fact) => fact.value)).toEqual([45, 120]);
    const overallShare = byKind(filtered, "share").find((fact) => fact.group === "Overall");
    expect(overallShare?.value).toBe(0.375);
    expect(overallShare?.formatted).toBe("37.50%");
  });
});

describe("§15 — the leading count group vs the rest combined is an engine comparison fact", () => {
  const countFacts = facts({ op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "records" }] });
  const comparison = byKind(countFacts, "comparison")[0] as ComparisonFact;

  it("Accessories (48) is LESS than the other categories combined (72)", () => {
    expect(comparison.subject).toBe("Accessories");
    expect(comparison.subjectValue).toBe(48);
    expect(comparison.objectValue).toBe(72);
    expect(comparison.relation).toBe("less_than");
  });

  it("an answer claiming Accessories > the others combined is rejected", () => {
    const reasons = validateClaimsAgainstFacts(
      "Accessories has 48 records, more than Electronics and Furniture combined.",
      countFacts,
      STRUCTURAL,
    );
    expect(reasons.join(" ")).toMatch(/combined/i);
  });

  it("an answer that just calls Accessories the largest category passes", () => {
    const reasons = validateClaimsAgainstFacts("Accessories is the largest category with 48 records.", countFacts, STRUCTURAL);
    expect(reasons).toHaveLength(0);
  });
});

describe("§7 — closest average-Fact pair", () => {
  const avgFacts = facts({
    op: "group_by",
    by: ["Category"],
    metrics: [{ metric: "mean", name: "avgFact", target: { kind: "column", name: "Fact" } }],
  });
  const closest = byKind(avgFacts, "pair").find((fact): fact is PairFact => fact.which === "closest") as PairFact;

  it("is Accessories & Electronics with Δ = 2.3125", () => {
    expect([...closest.groups].sort()).toEqual(["Accessories", "Electronics"]);
    expect(closest.delta).toBeCloseTo(2.3125, 6);
  });

  it("an answer naming a different closest pair is rejected", () => {
    const reasons = validateClaimsAgainstFacts(
      "The closest pair by average Fact is Electronics and Furniture.",
      avgFacts,
      STRUCTURAL,
    );
    expect(reasons.join(" ")).toMatch(/closest/i);
  });
});

describe("§7 — ranking / superlative facts", () => {
  const revenueFacts = facts({
    op: "group_by",
    by: ["Category"],
    metrics: [{ metric: "sum", name: "revenue", target: { kind: "column", name: "Revenue" } }],
  });
  const ranking = byKind(revenueFacts, "ranking")[0] as RankingFact;

  it("ranks Revenue Electronics > Furniture > Accessories", () => {
    expect(ranking.order).toEqual(["Electronics", "Furniture", "Accessories"]);
  });

  it("calling Accessories the highest by Revenue is rejected; Electronics is accepted", () => {
    expect(
      validateClaimsAgainstFacts("Accessories has the highest Revenue.", revenueFacts, STRUCTURAL).join(" "),
    ).toMatch(/not the top/i);
    expect(validateClaimsAgainstFacts("Electronics has the highest Revenue.", revenueFacts, STRUCTURAL)).toHaveLength(0);
  });
});

describe("unsupported numeric transformations fail even when derivable from two facts", () => {
  const revenueFacts = facts({
    op: "group_by",
    by: ["Category"],
    metrics: [{ metric: "sum", name: "revenue", target: { kind: "column", name: "Revenue" } }],
  });

  it("a difference of two scalar facts is not a fact", () => {
    // 2,849,711,102 − 1,035,812,162 = 1,813,898,940
    const reasons = validateClaimsAgainstFacts(
      "Electronics revenue exceeds Furniture revenue by 1,813,898,940.",
      revenueFacts,
      STRUCTURAL,
    );
    expect(reasons.join(" ")).toMatch(/not VERIFIED FACTS/i);
  });

  it("a 'times' multiple that is not a ratio fact is rejected", () => {
    const withoutRatio = revenueFacts.filter((fact) => fact.kind !== "ratio");
    const reasons = validateClaimsAgainstFacts("Electronics revenue is 6.56 times Accessories revenue.", withoutRatio, STRUCTURAL);
    expect(reasons.join(" ")).toMatch(/ratio|not VERIFIED/i);
  });

  it("the engine DOES emit a max:min ratio, which the model may quote", () => {
    const ratio = byKind(revenueFacts, "ratio").find((fact) => Math.abs(fact.value - 2849711102 / 434805308) < 0.05);
    expect(ratio).toBeDefined();
    const reasons = validateClaimsAgainstFacts(`Electronics revenue is ${ratio?.formatted} Accessories revenue.`, revenueFacts, STRUCTURAL);
    expect(reasons).toHaveLength(0);
  });
});

describe("deriveVerifiedFacts — provenance", () => {
  it("every fact carries a source operation id and the workbook range", () => {
    const batch = runAnalysisBatch(snapshot, [{ op: "count" }]);
    expect(batch.facts.length).toBeGreaterThan(0);
    for (const fact of batch.facts) {
      expect(fact.sourceOperationId).toMatch(/^op#\d+$/);
      expect(fact.sourceRange).toContain("Sales Test Data!A1:L121");
    }
  });

  it("does not derive facts from a rejected operation", () => {
    const batch = runAnalysisBatch(snapshot, [{ op: "aggregate", metric: "mean", target: { kind: "column", name: "Nope" } }]);
    expect(batch.facts).toHaveLength(0);
    expect(deriveVerifiedFacts(batch.outcomes, [{ op: "aggregate", metric: "mean", target: { kind: "column", name: "Nope" } }])).toHaveLength(0);
  });
});
