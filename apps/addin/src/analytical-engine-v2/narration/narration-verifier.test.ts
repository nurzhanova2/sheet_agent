import { describe, expect, it } from "vitest";
import { scanPresented } from "./presented-claims.js";
import { verifyNarration, type VerificationInput } from "./narration-verifier.js";
import type { NarrationFactSet } from "./narration-facts.js";
import type { VerifiedFinding } from "../insight/verified-finding.js";

function facts(...values: number[]): NarrationFactSet {
  return {
    entityLabels: ["Revenue"],
    facts: values.map((value, i) => ({
      factId: `f${i}`,
      entity: "Revenue",
      metric: "value",
      value,
      semanticUnit: "unknown" as const,
      displayValue: String(value),
      precision: 2,
      sourceResultRef: "result_1",
      provenance: "result" as const,
    })),
  };
}

function input(overrides: Partial<VerificationInput> = {}): VerificationInput {
  return {
    draft: "Revenue increased.",
    findings: [],
    locale: "en",
    request: "Describe the result.",
    hasResults: true,
    ...overrides,
  };
}

function finding(overrides: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    id: "f1",
    findingType: "trend",
    subject: "Revenue",
    direction: "up",
    values: [],
    materiality: [],
    confidence: [],
    caveats: [],
    provenance: { resultRef: "result_1" as never, tool: "test", sourceRange: "A1:B2", sourceVersion: "v1", periods: [] },
    statement: "Revenue increased.",
    ...overrides,
  } as VerifiedFinding;
}

describe("Stage 28D — one V2 narration verifier", () => {
  it("rejects unsupported numbers and accepts grounded numbers", () => {
    expect(verifyNarration(input({ draft: "Revenue increased to 999.", facts: facts(42) })).ok).toBe(false);
    expect(verifyNarration(input({ draft: "Revenue increased to 42.", facts: facts(42) })).reasons).not.toContain(expect.stringContaining("unsupported numeric claim"));
  });

  it("keeps percentage-point semantics distinct from percentages", () => {
    const pp = finding({ values: [{ name: "delta", value: 0.8, unit: { kind: "percent_point_delta", scaled: true }, text: "0.8 pp" }] as never });
    expect(verifyNarration(input({ draft: "Revenue rose by 0.8%.", findings: [pp] })).ok).toBe(false);
    expect(verifyNarration(input({ draft: "Revenue rose by 0.8 percentage points.", findings: [pp] })).ok).toBe(true);
  });

  it("rejects unsupported causal language but preserves a hedged hypothesis", () => {
    expect(verifyNarration(input({ draft: "Revenue increased because of demand." })).ok).toBe(false);
    expect(verifyNarration(input({ draft: "Revenue increased; this may indicate stronger demand." })).reasons).not.toContain(expect.stringContaining("cause"));
  });

  it("checks ranked superlatives against verified rank", () => {
    const ranked = finding({ materiality: [{ kind: "rank", position: 2, outOf: 3 }] as never });
    expect(verifyNarration(input({ draft: "Revenue was the largest.", findings: [ranked] })).ok).toBe(false);
    const winner = finding({ materiality: [{ kind: "rank", position: 1, outOf: 3 }] as never });
    expect(verifyNarration(input({ draft: "Revenue was the largest.", findings: [winner] })).ok).toBe(true);
  });

  it("rejects internal handles, raw dumps, and unrequested recommendations", () => {
    const withFinding = [finding()];
    expect(verifyNarration(input({ draft: "See result_1.", findings: withFinding })).ok).toBe(false);
    expect(verifyNarration(input({ draft: "Revenue | 42 | 43\nCost | 11 | 12", findings: withFinding })).ok).toBe(false);
    expect(verifyNarration(input({ draft: "You should check the demand next.", findings: withFinding })).ok).toBe(false);
    expect(verifyNarration(input({ draft: "You should check Revenue next.", findings: withFinding, request: "What should we do next?" })).ok).toBe(true);
  });

  it("rejects factual prose when there are no findings", () => {
    expect(verifyNarration(input({ draft: "Revenue increased." })).ok).toBe(false);
  });

  it("rescans the actual presented text after draft evaluation", () => {
    const result = scanPresented({
      text: "Revenue increased because of demand.",
      findings: [finding()],
      request: "Describe the result.",
      locale: "en",
      hasResults: true,
    });
    expect(result.unsupportedCausalClaimsPresented).toBe(1);
  });
});
