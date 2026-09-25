import { describe, expect, it } from "vitest";
import { ResultStore } from "./results/result-store.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { buildToolEnv } from "./tools/registry.js";
import { executeCall, validateCall } from "./tools/validator.js";
import { fixtureOperations, type SyntheticTable } from "./__fixtures__/synthetic-tables.js";
import { buildFindings } from "./insight/extract-findings.js";
import { groundFindings, groundingContextOf } from "./insight/finding-subject.js";
import { planPresentation } from "./narration/presentation-plan.js";
import { buildNarratorMessages, deterministicRenderEligibility, renderDeterministic } from "./narration/narrator.js";
import type { AnswerIntent, EngineAnalysis, EngineResult, ToolOutcome } from "./types.js";

function session(table: SyntheticTable) {
  const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 3000 });
  const env = buildToolEnv(table.schema, table.grids, store, EMPTY_ANALYTICAL_STATE);
  const cache = new Map<string, string>();
  const call = (tool: string, args: Record<string, unknown> = {}): ToolOutcome => {
    const validated = validateCall({ kind: "tool_call", tool, arguments: args }, env);
    if (!validated.ok) return validated.error;
    return executeCall(validated.call, env, cache).outcome;
  };
  const ok = (tool: string, args: Record<string, unknown> = {}): EngineResult => {
    const outcome = call(tool, args);
    if (!outcome.ok) throw new Error(`${tool} failed: ${outcome.error.code}: ${outcome.error.message}`);
    return outcome.result;
  };
  return { call, ok };
}

const overviewIntent: AnswerIntent = {
  shape: "overview",
  count: null,
  direction: null,
  subjects: [],
  periodIntent: { kind: "full_range" },
  wantsTable: false,
  wantsRecommendation: false,
  answerStyle: "concise",
};

describe("Stage 28H.2 — table-overview evidence", () => {
  const table = fixtureOperations();

  it("computes latest and full-range change for every metric without Python", () => {
    const s = session(table);
    const evidence = s.ok("schema.overview_evidence");
    expect(evidence.type).toBe("comparison");
    expect(evidence.rows.length).toBe(table.metricLabels.length);
    expect(evidence.metadata["overviewEvidence"]).toBe(true);
    for (const row of evidence.rows) {
      const [, fullStart, fullEnd, fullAbs, fullPct] = row;
      expect(typeof fullStart).toBe("number");
      expect(typeof fullEnd).toBe("number");
      expect(typeof fullAbs).toBe("number");
      expect(fullPct === null || typeof fullPct === "number").toBe(true);
    }
  });

  it("produces one grounded finding per metric carrying both windows of change", () => {
    const s = session(table);
    const evidence = s.ok("schema.overview_evidence");
    const analysis: EngineAnalysis = { primary: evidence, supporting: [], answerStyle: "concise" };
    const findings = buildFindings(evidence, [], { schema: table.schema, grids: table.grids, locale: "ru" }, evidence.rows.length, evidence.rows.length);
    expect(findings.length).toBe(table.metricLabels.length);
    const grounded = groundFindings(findings, groundingContextOf(table.schema, table.grids));
    expect(grounded.visible.length).toBe(table.metricLabels.length);
    for (const finding of grounded.visible) {
      const names = finding.values.map((v) => v.name);
      expect(names).toContain("fullRangeAbsoluteChange");
      expect(names).toContain("latestAbsoluteChange");
    }
    const plan = planPresentation(analysis, grounded.visible, overviewIntent);
    expect([plan.lead, ...plan.support].filter((f) => f !== null).length).toBeGreaterThan(2);
  });

  it("writer input carries the evidence, not just schema counts", () => {
    const s = session(table);
    const evidence = s.ok("schema.overview_evidence");
    const analysis: EngineAnalysis = { primary: evidence, supporting: [], answerStyle: "concise" };
    const findings = buildFindings(evidence, [], { schema: table.schema, grids: table.grids, locale: "ru" }, evidence.rows.length, evidence.rows.length);
    const grounded = groundFindings(findings, groundingContextOf(table.schema, table.grids));
    const plan = planPresentation(analysis, grounded.visible, overviewIntent);
    const messages = buildNarratorMessages({
      request: "О чем эта таблица?",
      analysis,
      answerIntent: overviewIntent,
      findings: grounded.visible,
      locale: "ru",
      presentationPlan: plan,
    });
    const userContent = messages[1]?.content ?? "";
    expect(userContent).toMatch(/изменение за (весь период|последний период)/);
    expect(userContent).not.toMatch(/^19 показателей/);
  });

  it("deterministic fallback renders more than a bare metric count when the writer is bypassed", () => {
    const s = session(table);
    const evidence = s.ok("schema.overview_evidence");
    const analysis: EngineAnalysis = { primary: evidence, supporting: [], answerStyle: "concise" };
    const findings = buildFindings(evidence, [], { schema: table.schema, grids: table.grids, locale: "ru" }, evidence.rows.length, evidence.rows.length);
    const grounded = groundFindings(findings, groundingContextOf(table.schema, table.grids));
    const plan = planPresentation(analysis, grounded.visible, overviewIntent);
    const input = { request: "О чем эта таблица?", analysis, answerIntent: overviewIntent, findings: grounded.visible, locale: "ru" as const, presentationPlan: plan };
    expect(deterministicRenderEligibility(input)).not.toBeNull();
    const text = renderDeterministic(input);
    expect(text.length).toBeGreaterThan(40);
    expect(text).not.toBe("");
  });
});
