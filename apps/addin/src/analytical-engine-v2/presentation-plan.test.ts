import { describe, expect, it } from "vitest";
import type { EngineAnalysis } from "./types.js";
import { planPresentation } from "./narration/presentation-plan.js";
import type { VerifiedFinding } from "./insight/verified-finding.js";

const intent = (shape: "direct" | "ranking" | "comparison" | "exploratory" | "grouping" | "overview", count: number | null = null) => ({
  shape, count, direction: null, subjects: [], periodIntent: { kind: "full_range" as const },
  wantsTable: false, wantsRecommendation: false, answerStyle: "concise" as const,
});

function finding(id: string, subject: string, findingType: VerifiedFinding["findingType"] = "change", extra: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    id, findingType, subject, direction: "up", values: [], materiality: [], confidence: [], caveats: [],
    provenance: { resultRef: "primary", tool: "test", sourceRange: "A1:B4", sourceVersion: "1" , periods: [] },
    statement: `${subject} grew 10.`, ...extra,
  };
}

function analysis(rows = 3): EngineAnalysis {
  return {
    primary: {
      resultId: "primary", tool: "test", type: "comparison", fields: [{ name: "subject", kind: "string" }, { name: "value", kind: "number" }, { name: "other", kind: "number" }],
      rows: Array.from({ length: rows }, (_, i) => [`S${i}`, i, i + 1]), metricKeys: [], periodCanonicals: [], parents: [],
    }, supporting: [], answerStyle: "concise",
  } as unknown as EngineAnalysis;
}

describe("PresentationPlan", () => {
  it("selects exactly the requested three ranking findings", () => {
    const plan = planPresentation(analysis(), [finding("1", "A"), finding("2", "B"), finding("3", "C"), finding("4", "D")], intent("ranking", 3));
    expect([plan.lead, ...plan.support].map((f) => f?.subject)).toEqual(["A", "B", "C"]);
  });

  it("keeps comparison ordering stable for every writer", () => {
    const findings = [finding("1", "A"), finding("2", "B"), finding("3", "C")];
    const first = planPresentation(analysis(), findings, intent("comparison"));
    const retry = planPresentation(analysis(), findings, intent("comparison"));
    expect([first.lead, ...first.support].map((f) => f?.id)).toEqual([retry.lead, ...retry.support].map((f) => f?.id));
  });

  it("demotes meta findings and deduplicates caveats once", () => {
    const caveat = { code: "low_base_percentage" as const, detail: "same" };
    const meta = finding("meta", "", "ranking", { detail: { setSize: 3 } });
    const plan = planPresentation(analysis(), [meta, finding("1", "A", "change", { caveats: [caveat] }), finding("2", "B", "change", { caveats: [caveat] })], intent("comparison"));
    expect(plan.lead?.id).toBe("1");
    expect(plan.support.map((f) => f.id)).toEqual(["2"]);
    expect(plan.caveats).toEqual([caveat]);
  });

  it("makes the evidence-table decision once", () => {
    const plan = planPresentation(analysis(), [finding("1", "A"), finding("2", "B"), finding("3", "C")], intent("ranking", 3));
    expect(plan.showEvidenceTable).toBe(true);
  });
});
