// Stage 24.5 §11 — natural-language highlight colour intent.
import { describe, expect, it } from "vitest";
import { DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_PALETTE, parseHighlightColor } from "./highlight-color.js";

describe("parseHighlightColor", () => {
  it("maps EN colour words to the fixed palette", () => {
    expect(parseHighlightColor("highlight them red")).toEqual({ name: "red", hex: HIGHLIGHT_PALETTE.red });
    expect(parseHighlightColor("mark him green")).toEqual({ name: "green", hex: HIGHLIGHT_PALETTE.green });
    expect(parseHighlightColor("highlight those yellow")).toEqual({ name: "yellow", hex: HIGHLIGHT_PALETTE.yellow });
  });

  it("maps RU colour words (incl. instrumental case) to the fixed palette", () => {
    expect(parseHighlightColor("выдели их красным")).toEqual({ name: "red", hex: HIGHLIGHT_PALETTE.red });
    expect(parseHighlightColor("подсвети их жёлтым")).toEqual({ name: "yellow", hex: HIGHLIGHT_PALETTE.yellow });
    expect(parseHighlightColor("выдели его зеленым")).toEqual({ name: "green", hex: HIGHLIGHT_PALETTE.green });
  });

  it("returns null when no approved colour word is present", () => {
    expect(parseHighlightColor("выдели их")).toBeNull();
    expect(parseHighlightColor("highlight them")).toBeNull();
    expect(parseHighlightColor("highlight them in cyan")).toBeNull();
  });

  it("every palette value is a valid hex fill and the default is yellow", () => {
    for (const hex of Object.values(HIGHLIGHT_PALETTE)) expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(DEFAULT_HIGHLIGHT_COLOR).toBe(HIGHLIGHT_PALETTE.yellow);
  });
});
