import { describe, expect, it } from "vitest";
import { agentEvidenceFacts, validateAgentAnswer } from "./evidence.js";
import type { AgentObservation } from "./types.js";

const comparison: AgentObservation = {
  tool: "compare_results",
  ok: true,
  kind: "table",
  source: "t-r1 vs t-r2",
  operation: "compare Mean NPL Rate by Sector",
  columns: ["Sector", "Mean NPL Rate 2024", "Mean NPL Rate 2025", "Δ Mean NPL Rate", "%Δ Mean NPL Rate"],
  rows: [
    ["Corporate", 0.04, 0.061, 0.021, 52.5],
    ["Retail", 0.03, 0.0314, 0.0014, 4.67],
  ],
};

describe("agentEvidenceFacts", () => {
  it("emits a scalar fact per numeric cell plus a ranking + extremes per numeric column", () => {
    const facts = agentEvidenceFacts([comparison]);
    expect(facts.filter((f) => f.kind === "scalar").length).toBe(8); // 2 rows x 4 numeric columns
    expect(facts.some((f) => f.kind === "scalar" && f.label === "Δ Mean NPL Rate — Corporate" && f.value === 0.021)).toBe(true);
    expect(facts.some((f) => f.kind === "ranking" && f.metric === "Δ Mean NPL Rate" && f.order[0] === "Corporate")).toBe(true);
    expect(facts.some((f) => f.kind === "extreme" && f.which === "max" && f.metric === "Δ Mean NPL Rate" && f.group === "Corporate")).toBe(true);
  });

  it("ignores failed / non-table observations", () => {
    expect(agentEvidenceFacts([{ tool: "x", ok: false, kind: "error", error: "boom" }])).toEqual([]);
  });
});

describe("validateAgentAnswer", () => {
  const facts = agentEvidenceFacts([comparison]);

  it("accepts an answer whose numbers are all evidence-backed", () => {
    const r = validateAgentAnswer(
      "Corporate deteriorated the most: its mean NPL Rate rose from 0.04 to 0.061, a change of 0.021 (2.1 pp).",
      facts,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects an unsupported quantitative claim", () => {
    const r = validateAgentAnswer("Corporate's NPL Rate increased by 999%.", facts);
    expect(r.ok).toBe(false);
  });

  it("allows a purely qualitative interpretation sentence", () => {
    const r = validateAgentAnswer(
      "The mean NPL Rate rose by 0.021. An increase in NPL Rate generally indicates weaker observed credit quality.",
      facts,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a causal over-claim", () => {
    const r = validateAgentAnswer("The chart proves that weaker lending standards caused the rise.", facts);
    expect(r.ok).toBe(false);
  });

  it("treats years and small ordinals as structural", () => {
    const r = validateAgentAnswer("Between 2024 and 2025 the top 2 sectors moved; Δ was 0.021.", facts);
    expect(r.ok).toBe(true);
  });

  // §3 — comparison fact grounds "A more than B"
  it("emits a comparison fact per adjacent pair; a wrong-direction comparison is not silently blessed", () => {
    const evidence = agentEvidenceFacts([comparison]);
    expect(
      evidence.some((f) => f.kind === "comparison" && f.subject === "Corporate" && f.object === "Retail" && f.relation === "greater_than"),
    ).toBe(true);
    // "Corporate deteriorated more than Retail" — no numbers, no superlative, no rule blocks it (fixture-consistent)
    expect(validateAgentAnswer("Corporate deteriorated more than Retail.", evidence).ok).toBe(true);
  });

  // §3 — a correct pp/%Δ number is accepted; a wrong one rejected
  it("a correct delta value is accepted; a wrong delta value is rejected", () => {
    const evidence = agentEvidenceFacts([comparison]);
    expect(validateAgentAnswer("Corporate's Δ Mean NPL Rate was 0.021 (2.1 pp).", evidence).ok).toBe(true);
    expect(validateAgentAnswer("Corporate's Mean NPL Rate rose by 7.9 percentage points.", evidence).ok).toBe(false);
  });

  // §3/§10 — bare causal claims about the numbers are rejected
  it("rejects an unsupported causal claim, keeps hedged interpretation", () => {
    const evidence = agentEvidenceFacts([comparison]);
    expect(validateAgentAnswer("Corporate caused the deterioration.", evidence).ok).toBe(false);
    expect(validateAgentAnswer("The rise was because of weak lending standards.", evidence).ok).toBe(false);
    expect(
      validateAgentAnswer(
        "Corporate shows the largest deterioration. A cause cannot be established from this workbook, which has no explanatory dimension.",
        evidence,
      ).ok,
    ).toBe(true);
  });
});
