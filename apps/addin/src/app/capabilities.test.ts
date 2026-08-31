import { describe, expect, it, vi } from "vitest";
import { detectCapabilities } from "./capabilities.js";

describe("detectCapabilities", () => {
  it("asks Office for each explicit requirement set", () => {
    const isSetSupported = vi.fn((name: string, version: string) => name === "ExcelApi" && version === "1.3");
    expect(detectCapabilities({ isSetSupported })).toEqual({
      excelApi12: false,
      excelApi13: true,
      excelApi14: false,
      sharedRuntime12: false,
    });
    expect(isSetSupported).toHaveBeenCalledTimes(4);
  });
});
