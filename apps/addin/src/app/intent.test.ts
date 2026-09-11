import { describe, expect, it } from "vitest";
import { classifyIntent } from "./intent.js";

describe("classifyIntent", () => {
  it("flags English analytical requests", () => {
    for (const prompt of [
      "how many rows have a negative variance?",
      "what is the average Fact by Region?",
      "show the top 10 rows by absolute Fact minus Plan",
      "rank managers by total Revenue",
      "what percentage of rows are strong?",
      "correlation between Plan and Fact",
      "find the outliers in Variance %",
    ]) {
      expect(classifyIntent(prompt).analytical, prompt).toBe(true);
    }
  });

  it("flags Russian analytical requests", () => {
    for (const prompt of [
      "Сколько строк имеют отрицательное отклонение?",
      "Посчитай среднее Fact по каждому Region",
      "Найди топ-10 строк по модулю Fact минус Plan",
      "Отсортируй по значению Revenue",
      "Какой процент строк сильные?",
      "Посчитай корреляцию между Plan и Fact",
      "Покажи выбросы в Variance %",
    ]) {
      expect(classifyIntent(prompt).analytical, prompt).toBe(true);
    }
  });

  it("flags visualization requests in both languages", () => {
    expect(classifyIntent("построй scatter plot Plan vs Fact").visualization).toBe(true);
    expect(classifyIntent("Построй столбчатый график среднего Fact по Region").visualization).toBe(true);
    expect(classifyIntent("draw a histogram of Variance %").visualization).toBe(true);
    expect(classifyIntent("show a pie chart of Revenue by Category").visualization).toBe(true);
    // visualization implies analytical (needs computed data)
    expect(classifyIntent("построй график Revenue по датам").analytical).toBe(true);
  });

  it("does NOT flag qualitative questions", () => {
    for (const prompt of [
      "what columns are in this table?",
      "explain these fields",
      "объясни, какие столбцы есть в таблице",
      "what does this sheet contain?",
    ]) {
      expect(classifyIntent(prompt).analytical, prompt).toBe(false);
      expect(classifyIntent(prompt).visualization, prompt).toBe(false);
    }
  });
});
