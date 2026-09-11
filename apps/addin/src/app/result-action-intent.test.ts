import { describe, expect, it } from "vitest";
import { detectResultAction } from "./result-action-intent.js";

describe("detectResultAction", () => {
  it("reads 'chart that' / 'построй график по этому' as a chart action", () => {
    expect(detectResultAction("chart that")?.kind).toBe("chart");
    expect(detectResultAction("now plot that result")?.kind).toBe("chart");
    expect(detectResultAction("построй график по этому")?.kind).toBe("chart");
  });

  it("reads 'highlight those' / 'выдели их' as a highlight action", () => {
    expect(detectResultAction("highlight those")?.kind).toBe("highlight");
    expect(detectResultAction("highlight them")?.kind).toBe("highlight");
    expect(detectResultAction("выдели их")?.kind).toBe("highlight");
  });

  it("reads 'copy those rows to Review' with the destination sheet", () => {
    const a = detectResultAction("copy those rows to Review");
    expect(a?.kind).toBe("copy");
    expect(a?.sheetName).toBe("Review");
    expect(detectResultAction("скопируй их в Review")?.sheetName).toBe("Review");
  });

  it("reads 'put that table on Summary' / 'on a new Summary sheet'", () => {
    const plain = detectResultAction("put that table on Summary");
    expect(plain?.kind).toBe("write");
    expect(plain?.sheetName).toBe("Summary");
    expect(plain?.newSheet).toBe(false);

    const fresh = detectResultAction("put that on a new Summary sheet");
    expect(fresh?.kind).toBe("write");
    expect(fresh?.sheetName).toBe("Summary");
    expect(fresh?.newSheet).toBe(true);

    expect(detectResultAction("вынеси это на новый лист Summary")?.newSheet).toBe(true);
  });

  it("reads 'insert that chart'", () => {
    expect(detectResultAction("insert that chart")?.kind).toBe("insert_chart");
    expect(detectResultAction("вставь этот график")?.kind).toBe("insert_chart");
  });

  it("does NOT fire for an ordinary analytical request with no demonstrative", () => {
    expect(detectResultAction("put the average Plan in a new column")).toBeNull();
    expect(detectResultAction("highlight rows where Fact is below Plan")).toBeNull();
    expect(detectResultAction("chart the average Fact by Region")).toBeNull();
  });
});
