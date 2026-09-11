import { describe, expect, it } from "vitest";
import { detectAnalyticalIntent } from "./analytical-intent.js";

const op = (t: string): string => detectAnalyticalIntent(t).operation;

describe("detectAnalyticalIntent — operation classification (§56, §77)", () => {
  it("divergent argmax phrasings all converge on 'argmax'", () => {
    for (const t of [
      "Когда активы были максимальными?",
      "В каком периоде активы максимальны?",
      "Когда был максимум активов?",
      "Покажи период максимальных активов.",
    ]) {
      expect(op(t), t).toBe("argmax");
    }
  });

  it("per-metric argmax / argmin", () => {
    expect(detectAnalyticalIntent("В каком периоде каждый показатель достиг максимума?").operation).toBe("argmax");
    expect(detectAnalyticalIntent("В каком периоде каждый показатель достиг минимума?").operation).toBe("argmin");
  });

  it("ranking by growth / decline over a horizon carries direction + sign + limit", () => {
    const g = detectAnalyticalIntent("Покажи 5 показателей с наибольшим ростом за последний месяц.");
    expect(g.operation).toBe("rank");
    expect(g.direction).toBe("desc");
    expect(g.changeSign).toBe("positive");
    expect(g.limit).toBe(5);
    const d = detectAnalyticalIntent("Покажи 5 показателей с наибольшим снижением за последний месяц.");
    expect(d.direction).toBe("asc");
    expect(d.changeSign).toBe("negative");
  });

  it("threshold filters read magnitude / positive / negative", () => {
    expect(detectAnalyticalIntent("Какие показатели изменились более чем на 20%?").thresholdMode).toBe("magnitude");
    expect(detectAnalyticalIntent("Какие показатели выросли более чем на 20%?").thresholdMode).toBe("positive");
    expect(detectAnalyticalIntent("Какие показатели снизились более чем на 10%?").thresholdMode).toBe("negative");
  });

  it("volatility vs stability, trend, monotonicity, direction change", () => {
    expect(op("Какие показатели наиболее волатильны?")).toBe("volatility");
    expect(op("Какие показатели наиболее стабильны?")).toBe("stability");
    expect(op("Какие показатели имеют самый сильный восходящий тренд?")).toBe("trend");
    expect(detectAnalyticalIntent("Покажи показатели, которые росли последовательно по периодам.").monotone).toBe("strict_increasing");
    expect(detectAnalyticalIntent("Покажи показатели, которые последовательно снижались.").monotone).toBe("strict_decreasing");
    expect(detectAnalyticalIntent("Покажи показатели, которые не снижались.").monotone).toBe("non_decreasing");
    expect(op("У каких показателей направление изменения поменялось?")).toBe("direction_change");
  });

  it("time series vs compare vs change", () => {
    expect(op("Покажи динамику активов по времени.")).toBe("time_series");
    expect(op("Сравни значения на 01.01.2025 и 01.12.2025.")).toBe("compare");
    expect(op("Как изменились активы между 01.01.2024 и 01.12.2025?")).toBe("change");
  });

  it("output projection: 'когда' → period, 'какой максимум' → value, 'когда и какой' → both", () => {
    expect(detectAnalyticalIntent("Когда активы были максимальными?").outputProjection).toBe("period");
    expect(detectAnalyticalIntent("Какой был максимум активов?").outputProjection).toBe("value");
    expect(detectAnalyticalIntent("Когда и какой был максимум активов?").outputProjection).toBe("period_and_value");
  });

  it("non-analytical / schema-owned phrasings do NOT claim an operation", () => {
    for (const t of [
      "найди максимальные и минимальные значения для каждого показателя",
      "покажи пиковые значения по каждому показателю",
      "о чем эта таблица",
      "найди значения, выходящие за пределы нормы",
      "выдели их красным",
      "покажи 3 менеджеров с худшим Variance",
    ]) {
      expect(detectAnalyticalIntent(t).any, t).toBe(false);
    }
  });

  it("carries the interval / same-period phrase", () => {
    const iv = detectAnalyticalIntent("Какие показатели выросли между 01.01.2025 и 01.12.2025?");
    expect(iv.periodStartText).toBe("01.01.2025");
    expect(iv.periodEndText).toBe("01.12.2025");
    const same = detectAnalyticalIntent("Какие показатели снизились за этот же период?");
    expect(same.periodText).toMatch(/за этот же период/i);
  });
});
