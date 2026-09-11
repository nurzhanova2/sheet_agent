import { describe, expect, it } from "vitest";
import { assertPngBase64, dataUrlToBase64 } from "./image.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("dataUrlToBase64", () => {
  it("strips a data-URL prefix and whitespace", () => {
    expect(dataUrlToBase64(`data:image/png;base64,${PNG_B64}`)).toBe(PNG_B64);
    expect(dataUrlToBase64(`data:image/jpeg;base64,${PNG_B64}`)).toBe(PNG_B64);
    expect(dataUrlToBase64(`  ${PNG_B64.slice(0, 10)}\n${PNG_B64.slice(10)}  `)).toBe(PNG_B64);
  });

  it("passes raw base64 through unchanged", () => {
    expect(dataUrlToBase64(PNG_B64)).toBe(PNG_B64);
  });

  it("throws on empty / prefix-only input", () => {
    expect(() => dataUrlToBase64("")).toThrow();
    expect(() => dataUrlToBase64("data:image/png;base64,")).toThrow(/empty/i);
  });
});

describe("assertPngBase64", () => {
  it("accepts a PNG payload", () => {
    expect(() => assertPngBase64(PNG_B64)).not.toThrow();
  });
  it("rejects a non-PNG payload", () => {
    expect(() => assertPngBase64("/9j/4AAQSkZJRgABAQ")).toThrow(/PNG/i); // JPEG magic
    expect(() => assertPngBase64("bm90IGFuIGltYWdl")).toThrow(/PNG/i);
  });
});
