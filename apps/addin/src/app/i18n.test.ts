import { describe, expect, it } from "vitest";
import { formatProvenance, pluralCount, pluralNoun, providerErrorMessage, ruPluralIndex, t } from "./i18n.js";

describe("i18n — pluralization (Stage 21.2.5 §16)", () => {
  it("English: singular vs plural", () => {
    expect(pluralNoun("en", 1, "row")).toBe("row");
    expect(pluralNoun("en", 2, "row")).toBe("rows");
    expect(pluralNoun("en", 0, "row")).toBe("rows");
    expect(pluralCount("en", 1, "dataRow")).toBe("1 data row");
    expect(pluralCount("en", 120, "dataRow")).toBe("120 data rows");
  });

  it("Russian: one / few / many categories", () => {
    expect(ruPluralIndex(1)).toBe(0);
    expect(ruPluralIndex(2)).toBe(1);
    expect(ruPluralIndex(5)).toBe(2);
    expect(ruPluralIndex(11)).toBe(2); // 11 is 'many' despite ending in 1
    expect(ruPluralIndex(21)).toBe(0);
    expect(pluralNoun("ru", 1, "row")).toBe("строка");
    expect(pluralNoun("ru", 2, "row")).toBe("строки");
    expect(pluralNoun("ru", 5, "row")).toBe("строк");
    expect(pluralNoun("ru", 1, "point")).toBe("точка");
    expect(pluralNoun("ru", 3, "point")).toBe("точки");
    expect(pluralNoun("ru", 7, "point")).toBe("точек");
    expect(pluralNoun("ru", 1, "category")).toBe("категория");
    expect(pluralNoun("ru", 2, "category")).toBe("категории");
    expect(pluralNoun("ru", 5, "category")).toBe("категорий");
  });
});

describe("i18n — provenance keeps the sheet name, localizes the row count", () => {
  it("EN / RU", () => {
    expect(formatProvenance("en", "Sales Test Data!E1:L121", 120)).toBe("Sales Test Data!E1:L121 · 120 data rows");
    expect(formatProvenance("ru", "Sales Test Data!E1:L121", 120)).toBe("Sales Test Data!E1:L121 · 120 строк данных");
    expect(formatProvenance("ru", "Sales Test Data!E1:L121", 1)).toBe("Sales Test Data!E1:L121 · 1 строка данных");
  });
});

describe("i18n — keyed messages follow the request language, identifiers stay verbatim", () => {
  it("activity titles", () => {
    expect(t("en", "activity.groupBy", { dims: "Category" })).toBe("Grouping by Category");
    expect(t("ru", "activity.groupBy", { dims: "Category" })).toBe("Группировка по Category");
    expect(t("ru", "activity.computeMetric", { metric: "mean Fact" })).toBe("Расчёт: mean Fact");
    expect(t("ru", "activity.analysisComplete")).toBe("Анализ завершён");
    expect(t("ru", "activity.analysisFailed")).toBe("Не удалось выполнить анализ");
  });

  it("goal-status display words are localized; codes are not", () => {
    expect(t("en", "goal.status.failed")).toBe("not done");
    expect(t("ru", "goal.status.failed")).toBe("не выполнено");
    expect(t("ru", "goal.status.blocked")).toBe("заблокировано");
  });

  it("fallback headings / columns", () => {
    expect(t("ru", "fallback.heading")).toBe("## Результаты");
    expect(t("en", "fallback.heading")).toBe("## Results");
    expect(t("ru", "fallback.colMetric")).toBe("Показатель");
    expect(t("ru", "fallback.colValue")).toBe("Значение");
    expect(t("ru", "fallback.colSource")).toBe("Источник");
  });

  it("provider errors follow the UI language, codes stay stable (Stage 21.2.8 §6, items 20/21)", () => {
    expect(providerErrorMessage("en", "PROVIDER_UNAVAILABLE")).toBe("The AI provider is temporarily unavailable. Try again later.");
    expect(providerErrorMessage("ru", "PROVIDER_UNAVAILABLE")).toBe("AI-провайдер временно недоступен. Повторите попытку позже.");
    expect(providerErrorMessage("ru", "RATE_LIMITED")).toMatch(/лимит|перегружен/);
    expect(providerErrorMessage("ru", "TIMEOUT")).toMatch(/не ответил/);
    // an unknown code never leaks an English string on a RU turn
    expect(providerErrorMessage("ru", "SOMETHING_NEW", "raw english text")).not.toMatch(/[A-Za-z]{4,}/);
    expect(providerErrorMessage("ru", undefined)).toMatch(/^Не удалось/);
  });

  it("every key resolves in both languages", () => {
    const keys: Parameters<typeof t>[1][] = [
      "activity.planning", "activity.buildingChart", "activity.countRows", "activity.correlation",
      "ua.chartInserted", "ua.changesApplied", "ua.someRejected",
      "goal.status.executed", "goal.reason.columnMissing", "goal.reason.vizUnsupported",
      "fallback.note", "fallback.source", "fallback.noResults", "fallback.notCalculated",
    ];
    for (const key of keys) {
      expect(t("en", key, { column: "Region", detail: "x" }).length).toBeGreaterThan(0);
      expect(t("ru", key, { column: "Region", detail: "x" }).length).toBeGreaterThan(0);
    }
  });
});
