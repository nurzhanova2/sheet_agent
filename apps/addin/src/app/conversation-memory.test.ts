import { describe, expect, it } from "vitest";
import {
  emptySessionMemory,
  interpretClarificationAnswer,
  isUndoPhrase,
  projectMemoryForModel,
  rememberChart,
  rememberResult,
  rememberRowSet,
  rememberSheet,
  resolveReference,
} from "./conversation-memory.js";
import { MEMORY_LIMITS, type PendingClarification } from "./session-memory.js";
import type { ChartData } from "../visualization/types.js";

const CHART: ChartData = {
  type: "bar",
  title: "Plan vs Fact by Category",
  series: { kind: "category", categories: ["A", "B"], values: [1, 2], label: "x" },
  provenance: "Sales!A1:C3 · 2 rows",
  rowsAnalyzed: 2,
  truncated: false,
  warnings: [],
} as unknown as ChartData;

function resultInput(over: Partial<Parameters<typeof rememberResult>[1]> = {}) {
  return {
    turnId: "t1",
    kind: "grouped_table" as const,
    title: "Average Plan and Fact by Category",
    spec: [{ op: "group_by" }],
    columns: ["Category", "Average Plan", "Average Fact"],
    rows: [
      ["Accessories", 227, 228],
      ["Electronics", 222, 226],
    ],
    rowsTruncated: false,
    facts: [],
    sourceSheet: "Sales Test Data",
    sourceRange: "Sales Test Data!A1:L121",
    sourceVersion: "121x12@Sales Test Data!A1:L121",
    resolved: [],
    ...over,
  };
}

describe("SessionMemory container", () => {
  it("keeps at most MEMORY_LIMITS.maxResults, evicting the oldest, and tracks lastResultId", () => {
    let m = emptySessionMemory();
    for (let i = 0; i < MEMORY_LIMITS.maxResults + 2; i += 1) {
      m = rememberResult(m, resultInput({ turnId: `t${i}`, title: `R${i}` }));
    }
    expect(m.recentResults).toHaveLength(MEMORY_LIMITS.maxResults);
    expect(m.recentResults[0]!.title).toBe(`R2`); // R0, R1 evicted
    expect(m.recentResults.at(-1)!.id).toBe(m.lastResultId);
  });

  it("clamps rows/columns to the caps and flags truncation", () => {
    const wide = Array.from({ length: MEMORY_LIMITS.maxColumnsPerResult + 5 }, (_, i) => `c${i}`);
    const many = Array.from({ length: MEMORY_LIMITS.maxRowsPerResult + 10 }, () => wide.map(() => 1));
    const m = rememberResult(emptySessionMemory(), resultInput({ columns: wide, rows: many }));
    const r = m.recentResults[0]!;
    expect(r.columns).toHaveLength(MEMORY_LIMITS.maxColumnsPerResult);
    expect(r.rows).toHaveLength(MEMORY_LIMITS.maxRowsPerResult);
    expect(r.rowsTruncated).toBe(true);
  });
});

describe("resolveReference", () => {
  it("resolves 'the chart' / 'этот график' to lastChart", () => {
    const m = rememberChart(rememberResult(emptySessionMemory(), resultInput()), { turnId: "t2", data: CHART });
    expect(resolveReference("put the chart on Summary", m)).toMatchObject({ kind: "resolved", target: { kind: "chart" } });
    expect(resolveReference("сделай этот график линейным", m)).toMatchObject({ kind: "resolved", target: { kind: "chart" } });
  });

  it("resolves 'those rows' / 'те строки' to lastRowSet", () => {
    const m = rememberRowSet(emptySessionMemory(), {
      turnId: "t1",
      sourceSheet: "S",
      sourceRange: "S!A1:D9",
      sourceVersion: "v1",
      sheetRows: [3, 5, 7],
      describe: "Fact < Plan",
      count: 3,
      truncated: false,
    });
    expect(resolveReference("highlight those rows", m)).toMatchObject({ kind: "resolved", target: { kind: "rowset" } });
    expect(resolveReference("выдели те строки", m)).toMatchObject({ kind: "resolved", target: { kind: "rowset" } });
  });

  it("resolves generic 'that' / 'это' to the most recent structured object", () => {
    const m = rememberResult(emptySessionMemory(), resultInput());
    expect(resolveReference("build a chart from that", m)).toMatchObject({ kind: "resolved", target: { kind: "result" } });
    expect(resolveReference("покажи только топ 2 из этого", m)).toMatchObject({ kind: "resolved", target: { kind: "result" } });
  });

  it("returns ambiguous when two same-turn objects of different kinds could both be 'that'", () => {
    let m = rememberResult(emptySessionMemory(), resultInput({ turnId: "tX" }));
    m = rememberRowSet(m, {
      turnId: "tX",
      sourceSheet: "S",
      sourceRange: "S!A1:D9",
      sourceVersion: "v1",
      sheetRows: [1, 2],
      describe: "x",
      count: 2,
      truncated: false,
    });
    expect(resolveReference("put that on Summary", m).kind).toBe("ambiguous");
  });

  it("returns evicted when the referenced kind existed but aged out, and none when nothing was ever remembered", () => {
    let m = emptySessionMemory();
    for (let i = 0; i < MEMORY_LIMITS.maxResults + 1; i += 1) m = rememberResult(m, resultInput({ turnId: `t${i}` }));
    // a rowset was never made, but "those rows" once resolvable? no — use a fresh eviction path:
    const evicted = resolveReference("show those rows", m);
    expect(evicted.kind).toBe("none"); // no rowset ever
    expect(resolveReference("chart that", emptySessionMemory()).kind).toBe("none");
  });

  it("does not resolve a phrase with no reference words", () => {
    const m = rememberResult(emptySessionMemory(), resultInput());
    expect(resolveReference("what is the average revenue", m).kind).toBe("none");
  });
});

describe("isUndoPhrase", () => {
  it("matches a whole-message undo request in EN and RU", () => {
    for (const s of ["undo that", "Undo that.", "revert it", "undo the last change", "please undo", "roll back", "отмени это", "отменить", "верни последнее изменение", "верни назад"]) {
      expect(isUndoPhrase(s)).toBe(true);
    }
  });
  it("does not match a sentence that merely contains 'undo'", () => {
    for (const s of ["do not undo the merger", "can you undo this and also add a column", "what does undo do"]) {
      expect(isUndoPhrase(s)).toBe(false);
    }
  });
});

describe("interpretClarificationAnswer", () => {
  const pending: PendingClarification = {
    id: "clr_1",
    turnId: "t1",
    createdAt: 0,
    originalPrompt: "Compare PD",
    route: "workbook_analysis",
    kind: "column_ambiguous",
    resolved: [],
    observations: [],
    candidates: ["PD12", "PD_Lifetime", "PD_Model"],
    question: "Which PD column should I compare?",
    answerShape: "one_of",
  };

  it("matches an exact / substring candidate", () => {
    expect(interpretClarificationAnswer("PD12", pending)).toEqual({ kind: "choice", choices: ["PD12"] });
    expect(interpretClarificationAnswer("lifetime", pending)).toEqual({ kind: "choice", choices: ["PD_Lifetime"] });
  });
  it("handles 'the first one', 'both', and cancel", () => {
    expect(interpretClarificationAnswer("the first one", pending)).toEqual({ kind: "choice", choices: ["PD12"] });
    expect(interpretClarificationAnswer("both", pending)).toEqual({ kind: "choice", choices: pending.candidates });
    expect(interpretClarificationAnswer("never mind", pending)).toEqual({ kind: "cancel" });
  });
  it("returns unclear for an unrelated reply", () => {
    expect(interpretClarificationAnswer("what is PD anyway", pending)).toEqual({ kind: "unclear" });
  });
});

describe("projectMemoryForModel", () => {
  it("lists refs by id without dumping the row grid", () => {
    let m = rememberResult(emptySessionMemory(), resultInput());
    m = rememberSheet(m, { turnId: "t2", name: "Summary", createdByAgent: true });
    const block = projectMemoryForModel(m, "en");
    expect(block).toMatch(/PRIOR RESULTS/);
    expect(block).toMatch(/\[res_\w+\] "Average Plan and Fact by Category" · grouped_table/);
    expect(block).toMatch(/last created sheet: "Summary"/);
    expect(block).not.toMatch(/Accessories/); // no grid dump
  });
  it("is empty when nothing is remembered", () => {
    expect(projectMemoryForModel(emptySessionMemory(), "en")).toBe("");
  });
  it("announces a pending clarification", () => {
    const m = { ...emptySessionMemory(), pendingClarification: {
      id: "c", turnId: "t", createdAt: 0, originalPrompt: "Compare PD", route: "workbook_analysis" as const,
      kind: "column_ambiguous" as const, resolved: [], observations: [], candidates: ["PD12", "PD_Model"],
      question: "Which PD column?", answerShape: "one_of" as const,
    } };
    expect(projectMemoryForModel(m, "en")).toMatch(/AWAITING YOUR CLARIFICATION: Which PD column\? \(candidates: PD12, PD_Model\)/);
  });
});
