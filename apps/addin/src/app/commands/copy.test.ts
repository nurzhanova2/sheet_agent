import { describe, expect, it } from "vitest";
import type { SelectionSnapshot } from "../workbook-context.js";
import { buildCopyProposal, copyDestRange, isCopyError, MAX_COPY_CELLS, parseCopySpec } from "./copy.js";

function snap(values: (string | number | null)[][], address: string): SelectionSnapshot {
  return {
    sheetName: address.slice(0, address.indexOf("!")),
    address,
    rowCount: values.length,
    columnCount: values[0]?.length ?? 0,
    totalRowCount: values.length,
    totalColumnCount: values[0]?.length ?? 0,
    totalCellCount: values.length * (values[0]?.length ?? 0),
    values,
    formulas: values.map((r) => r.map(() => null)),
    numberFormats: values.map((r) => r.map(() => "General")),
    truncated: false,
    isEmpty: false,
  } as unknown as SelectionSnapshot;
}

describe("parseCopySpec", () => {
  it("parses `<Sheet>!<range> to <Sheet>!<cell>` incl. spaced sheet names and RU keyword", () => {
    expect(parseCopySpec("Sales Test Data!A1:L20 to Summary!A1")).toEqual({
      source: { sheet: "Sales Test Data", range: "A1:L20" },
      dest: { sheet: "Summary", anchor: "A1" },
    });
    expect(parseCopySpec("Data!A1:C3 в Свод!B2")).toEqual({
      source: { sheet: "Data", range: "A1:C3" },
      dest: { sheet: "Свод", anchor: "B2" },
    });
  });

  it("rejects a non-cell destination or a missing sheet prefix", () => {
    expect(parseCopySpec("Data!A1:C3 to Summary!A1:C3")).toBeNull();
    expect(parseCopySpec("A1:C3 to Summary!A1")).toBeNull();
    expect(parseCopySpec("nonsense")).toBeNull();
  });
});

describe("copyDestRange", () => {
  it("sizes the destination from the source, anchored at the cell", () => {
    expect(copyDestRange("A1:C3", "E5")).toBe("E5:G7");
    expect(copyDestRange("A1", "B2")).toBe("B2");
  });
});

describe("buildCopyProposal", () => {
  const spec = { source: { sheet: "Src", range: "A1:B2" }, dest: { sheet: "Dst", anchor: "A1" } };
  const source = snap([["a", 1], ["b", 2]], "Src!A1:B2");

  it("builds one set_values action for the sized destination range", () => {
    const built = buildCopyProposal(spec, "Src", "Dst", source, snap([["", ""], ["", ""]], "Dst!A1:B2"), "en");
    if (isCopyError(built)) throw new Error(built.error);
    expect(built.actions).toHaveLength(1);
    expect(built.actions[0]).toMatchObject({ type: "set_values", sheetName: "Dst", range: "A1:B2", payload: { values: [["a", 1], ["b", 2]] } });
    expect(built.text).toMatch(/Approve the change/);
    expect(built.text).not.toMatch(/overwrite/i);
  });

  it("warns (but still proposes) when the destination already has data", () => {
    const built = buildCopyProposal(spec, "Src", "Dst", source, snap([["old", null], [null, "x"]], "Dst!A1:B2"), "en");
    if (isCopyError(built)) throw new Error(built.error);
    expect(built.text).toMatch(/⚠ The destination already contains data \(2 non-empty cells\)/);
    expect(built.actions).toHaveLength(1);
  });

  it("fails closed for an over-large source range", () => {
    const big = { source: { sheet: "Src", range: "A1:Z2000" }, dest: { sheet: "Dst", anchor: "A1" } };
    const built = buildCopyProposal(big, "Src", "Dst", source, snap([[""]], "Dst!A1"), "en");
    expect(isCopyError(built)).toBe(true);
    if (isCopyError(built)) expect(built.error).toMatch(new RegExp(`${MAX_COPY_CELLS}`));
  });
});
