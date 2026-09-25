// Stage 24.5 §3–§7, §12, §15 — conversational reference resolution + entity-set extraction.
import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { extractEntitySet, mentionsConversationalReference, resolveActionReference } from "./entity-reference.js";
import {
  emptySessionMemory,
  rememberChart,
  rememberDerivedResult,
  rememberResult,
  rememberRowSet,
} from "./conversation-memory.js";
import type { ResultRef, SessionMemory } from "./session-memory.js";
import type { ChartData } from "../visualization/types.js";

function grouped(
  memory: SessionMemory,
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
  extra: Partial<Parameters<typeof rememberResult>[1]> = {},
): SessionMemory {
  return rememberResult(memory, {
    turnId: `turn_${Math.random()}`,
    kind: "grouped_table",
    title: "Mean Variance by Manager",
    spec: null,
    columns,
    rows,
    rowsTruncated: false,
    sourceSheet: "Sales Test Data",
    sourceRange: "Sales Test Data!A1:L121",
    sourceVersion: "v1",
    ...extra,
  });
}

const MANAGERS: (readonly CellValue[])[] = [
  ["Aigerim", -5.12],
  ["Aruzhan", 0],
  ["Timur", 3.87],
];

describe("extractEntitySet", () => {
  it("reads the single label column + canonical values from a grouped result", () => {
    const es = extractEntitySet({ columns: ["Manager", "Mean Variance"], rows: MANAGERS });
    expect(es).toEqual({ kind: "set", column: "Manager", values: ["Aigerim", "Aruzhan", "Timur"] });
  });

  it("prefers the retained entityColumn / entityValues when present", () => {
    const es = extractEntitySet({
      columns: ["A", "B"],
      rows: [[1, 2]],
      entityColumn: "Manager",
      entityValues: ["X", "Y"],
    });
    expect(es).toEqual({ kind: "set", column: "Manager", values: ["X", "Y"] });
  });

  it("is ambiguous when two columns are equally plausible entity columns (§15)", () => {
    const es = extractEntitySet({
      columns: ["Region", "Manager", "Mean Variance"],
      rows: [
        ["Almaty", "Aigerim", -5.12],
        ["Astana", "Aruzhan", 0],
        ["Aktobe", "Timur", 3.87],
      ],
    });
    expect(es.kind).toBe("ambiguous");
    if (es.kind === "ambiguous") expect([...es.columns].sort()).toEqual(["Manager", "Region"]);
  });

  it("returns none for an all-numeric grid", () => {
    expect(extractEntitySet({ columns: ["Plan", "Fact"], rows: [[1, 2]] }).kind).toBe("none");
  });
});

describe("mentionsConversationalReference", () => {
  it.each(["выдели их", "выдели его", "построй по ним график", "highlight them", "chart those", "put this result on Summary"])(
    "detects %j",
    (t) => expect(mentionsConversationalReference(t)).toBe(true),
  );
  it("does not fire on a fresh analytical request", () => {
    expect(mentionsConversationalReference("group the sales by manager")).toBe(false);
  });
});

describe("resolveActionReference", () => {
  it("highlight → the previous grouped result, with its entity set", () => {
    const mem = grouped(emptySessionMemory(), ["Manager", "Mean Variance"], MANAGERS);
    const r = resolveActionReference("выдели их", mem, "highlight", "ru");
    expect(r.kind).toBe("result");
    if (r.kind === "result") {
      expect(r.ref.columns).toEqual(["Manager", "Mean Variance"]);
      expect(r.entitySet).toEqual({ kind: "set", column: "Manager", values: ["Aigerim", "Aruzhan", "Timur"] });
    }
  });

  it("highlight → a strictly newer derived result wins over an older RowSetRef (§12)", () => {
    let mem = grouped(emptySessionMemory(), ["Manager", "Mean Variance"], [
      ["Aigerim", -5.12], ["Aruzhan", 0], ["Timur", 3.87], ["Madina", 8], ["Dias", 9],
    ]);
    mem = rememberRowSet(mem, {
      turnId: "t_rs",
      sourceSheet: "Sales Test Data",
      sourceRange: "Sales Test Data!A1:L121",
      sourceVersion: "v1",
      sheetRows: [2, 3],
      describe: "some rows",
      count: 2,
      truncated: false,
    });
    const parent = mem.recentResults[mem.recentResults.length - 1]!;
    mem = rememberDerivedResult(mem, parent, {
      columns: ["Manager", "Mean Variance"],
      rows: [["Aigerim", -5.12], ["Aruzhan", 0]],
      kind: "ranking",
      title: "bottom 2",
      transform: { kind: "bottom_n", n: 2 },
    });
    const r = resolveActionReference("выдели их", mem, "highlight", "ru");
    expect(r.kind).toBe("result");
    if (r.kind === "result") expect(r.ref.rows.length).toBe(2);
  });

  it("24.5.3 — picks the NEWEST compatible result created after the RowSet, not the first", () => {
    let mem = grouped(emptySessionMemory(), ["Manager", "Mean Variance"], [
      ["Aigerim", -5.12], ["Aruzhan", 0], ["Timur", 3.87], ["Madina", 8], ["Dias", 9],
    ]);
    // a RowSet built from that result ("выдели его" on the single worst)
    mem = rememberRowSet(mem, {
      turnId: "t_rs",
      sourceSheet: "Sales Test Data",
      sourceRange: "Sales Test Data!A1:L121",
      sourceVersion: "v1",
      sheetRows: [11, 15, 16],
      describe: "Manager IN (Aigerim)",
      count: 3,
      truncated: false,
    });
    // then TWO newer derived results — the second one is what "их" must mean.
    const parent = mem.recentResults[mem.recentResults.length - 1]!;
    mem = rememberDerivedResult(mem, parent, {
      columns: ["Manager", "Mean Variance"], rows: [["Aigerim", -5.12], ["Aruzhan", 0], ["Timur", 3.87]],
      kind: "ranking", title: "bottom 3", transform: { kind: "bottom_n", n: 3 },
    });
    const midResult = mem.recentResults[mem.recentResults.length - 1]!;
    mem = rememberDerivedResult(mem, midResult, {
      columns: ["Manager", "Mean Variance"], rows: [["Aigerim", -5.12], ["Aruzhan", 0]],
      kind: "ranking", title: "bottom 2", transform: { kind: "bottom_n", n: 2 },
    });
    const r = resolveActionReference("выдели их", mem, "highlight", "ru");
    expect(r.kind).toBe("result");
    if (r.kind === "result") {
      expect(r.ref.rows.length).toBe(2);
      expect(r.entitySet).toEqual({ kind: "set", column: "Manager", values: ["Aigerim", "Aruzhan"] });
    }
  });

  it("highlight → the active RowSetRef when there is no compatible newer result (§13)", () => {
    let mem: SessionMemory = emptySessionMemory();
    mem = rememberRowSet(mem, {
      turnId: "t_rs",
      sourceSheet: "Sales Test Data",
      sourceRange: "Sales Test Data!A1:L121",
      sourceVersion: "v1",
      sheetRows: [2, 5, 9],
      describe: "Fact < Plan",
      count: 3,
      truncated: false,
    });
    const r = resolveActionReference("выдели их красным", mem, "highlight", "ru");
    expect(r.kind).toBe("rowset");
    if (r.kind === "rowset") expect(r.ref.count).toBe(3);
  });

  it("highlight after (result → chart of it) resolves to the RESULT, not the chart (§3)", () => {
    let mem = grouped(emptySessionMemory(), ["Manager", "Mean Variance"], MANAGERS);
    const chart: ChartData = { type: "bar", title: "c", series: [], categories: [] } as unknown as ChartData;
    mem = rememberChart(mem, { turnId: "t_c", data: chart, fromResultId: mem.lastResultId! });
    const r = resolveActionReference("выдели их", mem, "highlight", "ru");
    expect(r.kind).toBe("result");
  });

  it("insert_chart resolves to the last chart even when a result is newer", () => {
    let mem = grouped(emptySessionMemory(), ["Manager", "Mean Variance"], MANAGERS);
    const chart: ChartData = { type: "bar", title: "c", series: [], categories: [] } as unknown as ChartData;
    mem = rememberChart(mem, { turnId: "t_c", data: chart });
    mem = grouped(mem, ["Manager", "Mean Variance"], MANAGERS);
    expect(resolveActionReference("вставь его", mem, "insert_chart", "ru").kind).toBe("chart");
  });

  it("highlight on a two-entity-column result asks which column (§15)", () => {
    const mem = grouped(emptySessionMemory(), ["Region", "Manager", "Mean Variance"], [
      ["Almaty", "Aigerim", -5.12],
      ["Astana", "Aruzhan", 0],
    ]);
    const r = resolveActionReference("выдели их", mem, "highlight", "ru");
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") expect([...r.candidates].sort()).toEqual(["Manager", "Region"]);
  });

  it("highlight with nothing in memory → none / evicted", () => {
    expect(resolveActionReference("выдели их", emptySessionMemory(), "highlight", "ru")).toEqual({
      kind: "none",
      reason: "no_object",
    });
  });

  it("write / chart / sort resolve to the last result", () => {
    const mem = grouped(emptySessionMemory(), ["Manager", "Mean Variance"], MANAGERS);
    for (const a of ["write", "chart", "sort", "filter"] as const) {
      expect(resolveActionReference("запиши это на Summary", mem, a, "ru").kind).toBe("result");
    }
  });
});

// keep ResultRef import meaningful for the type-only checker
export type _Ref = ResultRef;
