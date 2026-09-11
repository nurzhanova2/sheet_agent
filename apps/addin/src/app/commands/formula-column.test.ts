import { describe, expect, it } from "vitest";
import { buildFormulaColumn, isFormulaColumnError } from "./formula-column.js";
import type { SelectionSnapshot } from "../workbook-context.js";

/** A minimal table snapshot: `headers` + `rows` data rows, anchored at `address`. */
function table(headers: string[], rows: (string | number)[][], address = "Agent Test!A1"): SelectionSnapshot {
  const startRow = 1;
  const lastRow = startRow + rows.length; // header + data
  const local = `A${startRow}:${String.fromCharCode(64 + headers.length)}${lastRow}`;
  const values = [headers, ...rows];
  return {
    sheetName: address.split("!")[0] ?? "Sheet1",
    address: address.includes(":") ? address : `${address.split("!")[0]}!${local}`,
    rowCount: values.length,
    columnCount: headers.length,
    totalRowCount: values.length,
    totalColumnCount: headers.length,
    totalCellCount: values.length * headers.length,
    values,
    formulas: values.map((r) => r.map(() => null)),
    numberFormats: values.map((r) => r.map(() => "General")),
    headers,
    truncated: false,
    isEmpty: false,
  } as unknown as SelectionSnapshot;
}

const AGENT = ["Company", "Plan", "Fact", "Variance"];
const AGENT_ROWS = [
  ["Alpha", 100, 120, 20],
  ["Beta", 200, 150, -50],
  ["Gamma", 300, 300, 0],
];
const IF_ARGS = 'в Comment добавь формулу: если Fact > Plan "Above Plan" иначе "Below Plan"';

describe("buildFormulaColumn (Stage 22.3 — deterministic /formula)", () => {
  it("1 — A1:D4 + new Comment → header D... wait E1 + E2:E4, formula from ACTUAL header positions", () => {
    const built = buildFormulaColumn(table(AGENT, AGENT_ROWS), IF_ARGS, "en");
    if (isFormulaColumnError(built)) throw new Error(built.error);
    expect(built.actions).toHaveLength(2);
    expect(built.actions[0]).toMatchObject({ type: "set_values", range: "E1:E1", payload: { values: [["Comment"]] } });
    // Fact = C, Plan = B in this table (NOT the assumed G/F)
    expect(built.actions[1]).toMatchObject({
      type: "fill_formula",
      range: "E2:E4",
      payload: { formula: '=IF(C2>B2,"Above Plan","Below Plan")', direction: "down" },
    });
    expect(built.text).not.toMatch(/added|applied|written/i); // proposed, not done
  });

  it("2 — an existing Comment column is reused, no second header is created", () => {
    const built = buildFormulaColumn(table([...AGENT, "Comment"], AGENT_ROWS.map((r) => [...r, ""])), IF_ARGS, "en");
    if (isFormulaColumnError(built)) throw new Error(built.error);
    expect(built.actions).toHaveLength(1);
    expect(built.actions[0]).toMatchObject({ type: "fill_formula", range: "E2:E4" });
    expect(built.actions[0]).not.toMatchObject({ type: "set_values" });
  });

  it("3 — a one-cell selection with no table context proposes NOTHING", () => {
    const oneCell = table(["Company"], [], "Agent Test!A1") as SelectionSnapshot;
    const built = buildFormulaColumn({ ...oneCell, headers: [], values: [["x"]], rowCount: 1, totalRowCount: 1, address: "Agent Test!A1" } as SelectionSnapshot, IF_ARGS, "en");
    expect(isFormulaColumnError(built)).toBe(true);
    if (isFormulaColumnError(built)) expect(built.error).toMatch(/Select the table\/range/i);
  });

  it("4 — a referenced column that is absent proposes NOTHING", () => {
    // table has no Fact/Plan
    const built = buildFormulaColumn(table(["Company", "Region"], [["Alpha", "N"], ["Beta", "S"]]), IF_ARGS, "en");
    expect(isFormulaColumnError(built)).toBe(true);
    if (isFormulaColumnError(built)) expect(built.error).toMatch(/Fact|Plan/);
  });

  it("5 — a cross-worksheet target is refused; user is asked to select that range", () => {
    const built = buildFormulaColumn(
      table(AGENT, AGENT_ROWS, "Sales Test Data!A1:D4"),
      `${IF_ARGS} на Agent Test`,
      "en",
    );
    expect(isFormulaColumnError(built)).toBe(true);
    if (isFormulaColumnError(built)) expect(built.error).toMatch(/Agent Test/);
  });

  it("5b — the same 'на <sheet>' when it IS the current sheet is allowed", () => {
    const built = buildFormulaColumn(table(AGENT, AGENT_ROWS, "Agent Test!A1:D4"), `${IF_ARGS} на Agent Test`, "en");
    expect(isFormulaColumnError(built)).toBe(false);
  });

  it("6 — a part that fails validation fails the WHOLE proposal (no partial actions)", () => {
    // ~5000-row selection → the fill range exceeds the per-action cell cap;
    // validateAction rejects it, so the (otherwise valid) header action is
    // dropped too and nothing is proposed.
    const rows = Array.from({ length: 4999 }, () => [1, 1]);
    const built = buildFormulaColumn(table(["Plan", "Fact"], rows, "Big!A1"), IF_ARGS, "en");
    expect(isFormulaColumnError(built)).toBe(true);
    if (isFormulaColumnError(built)) expect(built.error).toMatch(/No change was proposed/i);
  });

  it("8 — an arithmetic column compiles refs from real header positions", () => {
    const built = buildFormulaColumn(table(["Company", "Plan", "Fact", "Revenue"], AGENT_ROWS.map((r) => [...r, 9])), "добавь колонку Diff = Fact - Plan", "en");
    if (isFormulaColumnError(built)) throw new Error(built.error);
    expect(built.actions[0]).toMatchObject({ type: "set_values", range: "E1:E1", payload: { values: [["Diff"]] } });
    expect(built.actions[1]).toMatchObject({ type: "fill_formula", range: "E2:E4", payload: { formula: "=C2-B2" } });
  });

  it("RU output stays Russian", () => {
    const built = buildFormulaColumn(table([...AGENT, "Comment"], AGENT_ROWS.map((r) => [...r, ""])), IF_ARGS, "ru");
    if (isFormulaColumnError(built)) throw new Error(built.error);
    expect(built.text).toMatch(/Подтвердите изменение/);
  });
});
