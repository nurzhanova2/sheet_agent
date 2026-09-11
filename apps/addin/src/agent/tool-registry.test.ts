import { describe, expect, it } from "vitest";
import { createAgentToolRegistry, defaultAgentTools } from "./tool-registry.js";
import type { AgentObservation, AgentTool, AgentToolContext } from "./types.js";
import { financialStabilityDeps } from "./__fixtures__/financial-stability.js";

const EXPECTED_TOOLS = [
  "workbook_overview", "list_sheets", "inspect_table", "read_range", "find_column",
  "summarize", "group_by", "filter_rows", "sort_rows", "top_n",
  "compare_aggregates", "compare_results", "derive_metric", "describe_result", "chart_result",
];

function ctx(priorResults: readonly AgentObservation[] = []): AgentToolContext {
  return { deps: financialStabilityDeps(), language: "en", priorResults };
}

function run(tool: AgentTool, input: Record<string, unknown>, context = ctx()): Promise<AgentObservation> {
  const validated = tool.validate(input);
  if (!validated.ok) return Promise.resolve({ tool: tool.name, ok: false, kind: "error", error: validated.error });
  return tool.execute(validated.value, context);
}

describe("agent tool registry", () => {
  it("registers exactly the Stage 24.4 read/analysis tools, all non-mutating", () => {
    const registry = createAgentToolRegistry();
    expect(registry.names()).toEqual(EXPECTED_TOOLS);
    for (const schema of registry.schemas()) {
      expect(schema.mutating).toBe(false);
      expect(typeof schema.description).toBe("string");
      expect(schema.readCost).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects a duplicate tool name", () => {
    const one = defaultAgentTools()[0]!;
    expect(() => createAgentToolRegistry([one, one])).toThrow(/duplicate/);
  });

  it("fails closed on malformed input", async () => {
    const registry = createAgentToolRegistry();
    const groupBy = registry.get("group_by")!;
    expect(groupBy.validate({ sheet: "Portfolio 2025", by: ["Sector"], metrics: [] }).ok).toBe(false);
    expect(groupBy.validate({ sheet: "Portfolio 2025", by: [], metrics: [{ metric: "mean", column: "PD" }] }).ok).toBe(false);
    expect(groupBy.validate({ sheet: "Portfolio 2025", by: ["Sector"], metrics: [{ metric: "bogus" }] }).ok).toBe(false);
    expect(groupBy.validate({ sheet: "Portfolio 2025", by: ["Sector"], metrics: [{ metric: "mean", column: "PD" }], junk: 1 }).ok).toBe(false);

    const readRange = registry.get("read_range")!;
    expect(readRange.validate({ address: "A1:B2" }).ok).toBe(false); // not sheet-qualified
    expect(readRange.validate({ address: "Portfolio 2025!A1:ZZ100000" }).ok).toBe(false); // oversized
    expect(readRange.validate({ address: "Portfolio 2025!A1:I25" }).ok).toBe(true);
  });

  it("resolves references deterministically — unknown and ambiguous sheets are not guessed", async () => {
    const registry = createAgentToolRegistry();
    const inspect = registry.get("inspect_table")!;
    expect((await run(inspect, { sheet: "Ledger" })).error).toMatch(/no sheet resolves/i);
    const ambiguous = await run(inspect, { sheet: "Portfolio" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/more than one sheet/i);
    expect(ambiguous.error).toMatch(/Portfolio 2024/);
  });

  it("group_by wraps the analysis engine and shapes the grouped grid", async () => {
    const registry = createAgentToolRegistry();
    const obs = await run(registry.get("group_by")!, {
      sheet: "Portfolio 2025",
      by: ["Sector"],
      metrics: [{ metric: "mean", column: "NPL Rate", name: "Mean NPL Rate" }],
    });
    expect(obs.ok).toBe(true);
    expect(obs.columns).toEqual(["Sector", "Mean NPL Rate"]);
    const bySector = new Map((obs.rows ?? []).map((row) => [String(row[0]), Number(row[1])]));
    expect(bySector.get("Corporate")!).toBeGreaterThan(bySector.get("Retail")!);
    expect(bySector.get("Corporate")!).toBeGreaterThan(bySector.get("Mortgage")!);
  });

  it("group_by surfaces an unknown-column rejection instead of guessing", async () => {
    const registry = createAgentToolRegistry();
    const obs = await run(registry.get("group_by")!, { sheet: "Portfolio 2025", by: ["Nope"], metrics: [{ metric: "count" }] });
    expect(obs.ok).toBe(false);
    expect(obs.kind).toBe("error");
  });

  it("compare_aggregates costs two reads and reports the year-over-year change", async () => {
    const registry = createAgentToolRegistry();
    const tool = registry.get("compare_aggregates")!;
    expect(tool.readCost).toBe(2);
    const obs = await run(tool, { sheetA: "Portfolio 2024", sheetB: "Portfolio 2025", column: "NPL Rate", metric: "mean" });
    expect(obs.ok).toBe(true);
    const change = Number((obs.rows ?? []).find((r) => r[0] === "Change")?.[1]);
    expect(change).toBeGreaterThan(0);
  });

  it("top_n can operate on an earlier result with zero workbook reads", async () => {
    const registry = createAgentToolRegistry();
    const prior: AgentObservation = {
      tool: "group_by",
      ok: true,
      kind: "table",
      resultId: "t-r1",
      columns: ["Sector", "Mean NPL Rate"],
      rows: [
        ["Retail", 0.031],
        ["Corporate", 0.061],
        ["SME", 0.071],
        ["Mortgage", 0.02],
      ],
    };
    const tool = registry.get("top_n")!;
    expect(tool.readCost).toBe(0);
    const obs = await run(tool, { result: "t-r1", by: "Mean NPL Rate", n: 2 }, ctx([prior]));
    expect(obs.ok).toBe(true);
    expect((obs.rows ?? []).map((r) => r[0])).toEqual(["SME", "Corporate"]);
  });

  it("describe_result / chart_result need a known result id", async () => {
    const registry = createAgentToolRegistry();
    expect((await run(registry.get("describe_result")!, { result: "missing" })).ok).toBe(false);
    expect((await run(registry.get("chart_result")!, { result: "missing" })).ok).toBe(false);
  });

  // ----- Increment 4.3 additions -----------------------------------------
  const grouped2024: AgentObservation = {
    tool: "group_by", ok: true, kind: "table", resultId: "t-r1", operation: "group_by Sector",
    columns: ["Sector", "Mean NPL Rate"],
    rows: [["Corporate", 0.04], ["Retail", 0.03], ["SME", 0.06]],
  };
  const grouped2025: AgentObservation = {
    tool: "group_by", ok: true, kind: "table", resultId: "t-r2", operation: "group_by Sector",
    columns: ["Sector", "Mean NPL Rate"],
    rows: [["Corporate", 0.061], ["Retail", 0.0314], ["Furniture", 0.01]],
  };

  it("derive_metric computes a column over a prior result (0 workbook reads) and records lineage", async () => {
    const registry = createAgentToolRegistry();
    const obs = await run(
      registry.get("derive_metric")!,
      { result: "t-r1", left: "Mean NPL Rate", operator: "divide", scalar: 2, output: "half" },
      ctx([grouped2024]),
    );
    expect(obs.ok).toBe(true);
    expect(obs.columns).toEqual(["Sector", "Mean NPL Rate", "half"]);
    expect(obs.derivedFrom).toEqual(["t-r1"]);
    expect(obs.rows![0]![2]).toBeCloseTo(0.02, 6);
  });

  it("compare_results aligns two grouped results on a key and keeps one-sided keys explicit", async () => {
    const registry = createAgentToolRegistry();
    const obs = await run(
      registry.get("compare_results")!,
      { result_a: "t-r1", result_b: "t-r2", key: "Sector", value: "Mean NPL Rate", label_a: "2024", label_b: "2025" },
      ctx([grouped2024, grouped2025]),
    );
    expect(obs.ok).toBe(true);
    expect(obs.columns).toEqual(["Sector", "Mean NPL Rate 2024", "Mean NPL Rate 2025", "Δ Mean NPL Rate", "%Δ Mean NPL Rate"]);
    expect(obs.derivedFrom).toEqual(["t-r1", "t-r2"]);
    const bySector = new Map((obs.rows ?? []).map((r) => [String(r[0]), r]));
    expect(Number(bySector.get("Corporate")![3])).toBeCloseTo(0.021, 6); // Δ
    expect(bySector.get("SME")![2]).toBeNull(); // present only in 2024
    expect(bySector.get("Furniture")![1]).toBeNull(); // present only in 2025
  });

  it("compare_aggregates multi-metric form returns one row per column and skips the uncomparable", async () => {
    const registry = createAgentToolRegistry();
    const obs = await run(registry.get("compare_aggregates")!, {
      sheetA: "Portfolio 2024",
      sheetB: "Portfolio 2025",
      columns: ["NPL Rate", "PD", "Exposure", "Bogus"],
      metric: "mean",
    });
    expect(obs.ok).toBe(true);
    expect(obs.columns).toEqual(["Metric", "Portfolio 2024", "Portfolio 2025", "Change", "Change %"]);
    const metrics = (obs.rows ?? []).map((r) => r[0]);
    expect(metrics).toEqual(["NPL Rate", "PD", "Exposure"]);
    expect(obs.note).toMatch(/skipped/i);
  });

  it("group_by can aggregate a prior result's own rows (0 workbook reads)", async () => {
    const registry = createAgentToolRegistry();
    const rowLevel: AgentObservation = {
      tool: "read_range", ok: true, kind: "table", resultId: "t-r9",
      columns: ["Sector", "NPL Rate"],
      rows: [["Corporate", 0.04], ["Corporate", 0.06], ["Retail", 0.02]],
    };
    const obs = await run(
      registry.get("group_by")!,
      { result: "t-r9", by: ["Sector"], metrics: [{ metric: "mean", column: "NPL Rate", name: "Mean NPL Rate" }] },
      ctx([rowLevel]),
    );
    expect(obs.ok).toBe(true);
    expect(obs.derivedFrom).toEqual(["t-r9"]);
    const corp = (obs.rows ?? []).find((r) => r[0] === "Corporate");
    expect(Number(corp![1])).toBeCloseTo(0.05, 6);
  });

  // ----- Increment 4.4: filter_rows(result) -----------------------------
  const comparison: AgentObservation = {
    tool: "compare_results", ok: true, kind: "table", resultId: "t-c1", operation: "compare",
    columns: ["Sector", "Mean NPL Rate 2024", "Mean NPL Rate 2025", "Δ Mean NPL Rate"],
    rows: [
      ["Accessories", 0.03, 0.031, 0.001],
      ["Corporate", 0.04, 0.061, 0.021],
      ["Mortgage", 0.02, null, null],
      ["SME", 0.06, 0.0714, 0.0114],
    ],
  };

  it("filter_rows over a result: numeric / abs / is_null predicates, 0 reads, lineage", async () => {
    const registry = createAgentToolRegistry();
    const tool = registry.get("filter_rows")!;
    expect(tool.readCost).toBe(1); // sheet form still costs a read; the executor below adds none

    const gt = await run(tool, { result: "t-c1", column: "Δ Mean NPL Rate", op: "gt", value: 0.01 }, ctx([comparison]));
    expect(gt.ok).toBe(true);
    expect(gt.derivedFrom).toEqual(["t-c1"]);
    expect((gt.rows ?? []).map((r) => r[0])).toEqual(["Corporate", "SME"]);

    const absLt = await run(tool, { result: "t-c1", column: "Δ Mean NPL Rate", op: "abs_lt", value: 0.005 }, ctx([comparison]));
    expect((absLt.rows ?? []).map((r) => r[0])).toEqual(["Accessories"]);

    const nul = await run(tool, { result: "t-c1", column: "Mean NPL Rate 2025", op: "is_null" }, ctx([comparison]));
    expect((nul.rows ?? []).map((r) => r[0])).toEqual(["Mortgage"]);

    const eq = await run(tool, { result: "t-c1", column: "Sector", op: "eq", value: "Corporate" }, ctx([comparison]));
    expect((eq.rows ?? []).length).toBe(1);
  });

  it("filter_rows over a result fails closed on a bad op / unknown column / missing value", async () => {
    const registry = createAgentToolRegistry();
    const tool = registry.get("filter_rows")!;
    expect(tool.validate({ result: "t-c1", column: "Δ Mean NPL Rate", op: "regex", value: 1 }).ok).toBe(false);
    expect(tool.validate({ result: "t-c1", column: "Δ Mean NPL Rate", op: "gt" }).ok).toBe(false); // no value
    expect((await run(tool, { result: "t-c1", column: "Nope", op: "gt", value: 1 }, ctx([comparison]))).ok).toBe(false);
  });
});
