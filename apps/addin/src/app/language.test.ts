import { describe, expect, it } from "vitest";
import { detectLanguage, isLanguageMismatch, languageDirective, uiText } from "./language.js";

describe("detectLanguage", () => {
  it("detects Russian for a Russian sentence", () => {
    expect(detectLanguage("Какой регион встречается чаще всего?")).toBe("ru");
  });

  it("detects English for an English sentence", () => {
    expect(detectLanguage("Which region appears most often?")).toBe("en");
  });

  it("stays Russian when a Russian instruction embeds English identifiers", () => {
    expect(detectLanguage("Построй scatter plot Plan vs Fact")).toBe("ru");
    expect(detectLanguage("Посчитай Pearson correlation между Plan и Fact")).toBe("ru");
  });

  it("falls back to English for digits/punctuation only", () => {
    expect(detectLanguage("42 %?")).toBe("en");
    expect(detectLanguage("")).toBe("en");
  });
});

describe("isLanguageMismatch", () => {
  it("flags an English answer to a Russian turn", () => {
    expect(isLanguageMismatch("Based on the analysis, there are 120 data rows in the selection.", "ru")).toBe(true);
  });

  it("accepts a Russian answer that keeps English column headers", () => {
    expect(
      isLanguageMismatch("Проанализировано 120 строк данных. По столбцу Fact среднее равно 250.", "ru"),
    ).toBe(false);
  });

  it("does not flag short strings", () => {
    expect(isLanguageMismatch("OK", "ru")).toBe(false);
  });
});

describe("localized UI + directives", () => {
  it("returns a Russian directive that protects column headers", () => {
    expect(languageDirective("ru")).toMatch(/русск/);
    expect(languageDirective("ru")).toMatch(/Plan/);
  });

  it("localizes activity labels", () => {
    expect(uiText("ru", "calculating")).toBe("Вычисление");
    expect(uiText("en", "calculating")).toBe("Calculating");
    expect(uiText("ru", "analysisComplete")).toBe("Расчёт завершён");
  });
});
