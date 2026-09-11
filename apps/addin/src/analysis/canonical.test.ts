import { describe, expect, it } from "vitest";
import { buildDataset } from "./dataset.js";
import { runAnalysis } from "./engine.js";
import { canonicalizeAnalysisRequest, canonicalizeExpression, canonicalKey } from "./canonical.js";
import { isAnalysisError, type AnalysisRequest, type Expression } from "./types.js";
import { salesSnapshot } from "./__fixtures__/sales-test-data.js";

const dataset = buildDataset(salesSnapshot());
if ("error" in dataset) throw new Error(dataset.error);
const ds = dataset as Exclude<typeof dataset, { error: string }>;

function group(request: AnalysisRequest): Record<string, number> {
  const outcome = runAnalysis(ds, request);
  if (isAnalysisError(outcome)) throw new Error(`${outcome.code}: ${outcome.error}`);
  return Object.fromEntries((outcome.groups ?? []).map((g) => [Object.values(g.key)[0] as string, Number(Object.values(g.metrics)[0])]));
}

describe("canonicalizeExpression — structural folding", () => {
  it("folds nested neg / abs and orders commutative operands", () => {
    const a: Expression = { kind: "neg", value: { kind: "neg", value: { kind: "column", name: "Plan" } } };
    expect(canonicalizeExpression(a)).toEqual({ kind: "column", name: "Plan" });

    const b: Expression = { kind: "abs", value: { kind: "neg", value: { kind: "column", name: "Variance" } } };
    expect(canonicalizeExpression(b)).toEqual({ kind: "abs", value: { kind: "column", name: "Variance" } });

    const left: Expression = { kind: "add", left: { kind: "column", name: "Fact" }, right: { kind: "column", name: "Plan" } };
    const right: Expression = { kind: "add", left: { kind: "column", name: "Plan" }, right: { kind: "column", name: "Fact" } };
    expect(canonicalizeExpression(left)).toEqual(canonicalizeExpression(right));
  });
});

describe("canonicalKey — equivalent phrasings collapse to one identity", () => {
  it("a bare condition and its {all:[…]} wrapper are the same request", () => {
    const bare: AnalysisRequest = { op: "count", where: { left: { column: "Region" }, operator: "=", value: "Almaty" } };
    const wrapped: AnalysisRequest = { op: "count", where: { all: [{ left: { column: "Region" }, operator: "=", value: "Almaty" }] } };
    expect(canonicalKey(bare)).toBe(canonicalKey(wrapped));
  });

  it("metric order and key order do not change identity", () => {
    const a: AnalysisRequest = {
      op: "group_by",
      by: ["Category"],
      metrics: [
        { metric: "mean", name: "avgFact", target: { kind: "column", name: "Fact" } },
        { metric: "count", name: "n" },
      ],
    };
    const b: AnalysisRequest = {
      op: "group_by",
      metrics: [
        { name: "n", metric: "count" },
        { target: { name: "Fact", kind: "column" }, name: "avgFact", metric: "mean" },
      ],
      by: ["Category"],
    };
    expect(canonicalKey(a)).toBe(canonicalKey(b));
  });
});

describe("§19A repeatability — a fixed normalized request is byte-identical across many runs", () => {
  it("Fact < Plan by Category, 25 consecutive runs", () => {
    const request = canonicalizeAnalysisRequest({
      op: "group_by",
      by: ["Category"],
      metrics: [{ metric: "count", name: "belowPlan", where: { left: { column: "Fact" }, operator: "<", value: { column: "Plan" } } }],
    });
    const first = JSON.stringify(runAnalysis(ds, request));
    for (let i = 0; i < 25; i += 1) {
      expect(JSON.stringify(runAnalysis(ds, request))).toBe(first);
    }
  });
});

describe("§1 determinism — 'Fact < Plan by Category' resolves to ONE split, however it is phrased", () => {
  const EXPECTED = { Accessories: 26, Electronics: 16, Furniture: 16 };

  it("column vs column: {left:{column:Fact}, '<', value:{column:Plan}}", () => {
    expect(
      group({ op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "n", where: { left: { column: "Fact" }, operator: "<", value: { column: "Plan" } } }] }),
    ).toEqual(EXPECTED);
  });

  it("computed expression: (Fact − Plan) < 0", () => {
    expect(
      group({
        op: "group_by",
        by: ["Category"],
        metrics: [
          {
            metric: "count",
            name: "n",
            where: { left: { kind: "subtract", left: { kind: "column", name: "Fact" }, right: { kind: "column", name: "Plan" } }, operator: "<", value: 0 },
          },
        ],
      }),
    ).toEqual(EXPECTED);
  });

  it("Variance < 0 (coincides with Fact<Plan in this fixture because Variance = Fact − Plan)", () => {
    expect(
      group({ op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "n", where: { left: { column: "Variance" }, operator: "<", value: 0 } }] }),
    ).toEqual(EXPECTED);
  });
});
