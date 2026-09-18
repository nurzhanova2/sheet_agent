// Stage 25.1.2 §7/§8/§10–§12 — forbidden legacy-engine strings and raw
// planner JSON must never reach the user for schema-aware analytics.
import { describe, expect, it } from "vitest";
import type { AgentObservation } from "../agent/types.js";
import { appendClauseCoverage, buildNarratorMessages, containsForbiddenLeak, gateNarratorAnswer, renderObservationsFallback } from "./narrator.js";

describe("Stage 25.1.2 §7 — containsForbiddenLeak: legacy-engine strings", () => {
  it.each([
    "EXECUTION STATUS: FAILED — 1 of 1 requested operation(s) could not be executed.",
    "ANALYSIS RESULT #1 (rejected)",
    "1 requested operation(s) could not be executed.",
    "Анализ недоступен для этого диапазона.",
  ])("flags %s", (text) => {
    expect(containsForbiddenLeak(text)).toBe(true);
  });

  it("does not flag a clean answer", () => {
    expect(containsForbiddenLeak("Сравнение выполнено: Активы выросли на 0.54%.")).toBe(false);
  });
});

describe("Stage 25.1.2 §8/§10 — containsForbiddenLeak: raw planner JSON", () => {
  it("flags a raw tool_call decision", () => {
    expect(containsForbiddenLeak('{"kind":"tool_call","tool":"period.select","input":{"selector":"last"}}')).toBe(true);
  });

  it("flags a raw clarify/final decision shape", () => {
    expect(containsForbiddenLeak('{"kind":"final","answer":"ok"}')).toBe(true);
  });

  it("flags text that merely starts with a brace", () => {
    expect(containsForbiddenLeak('{ leaked internal state }')).toBe(true);
  });

  it("does not flag prose that happens to mention numbers in braces-free text", () => {
    expect(containsForbiddenLeak("Показатель вырос на 5.2% между P4 и P5.")).toBe(false);
  });
});

describe("Stage 25.1.2 §10 — gateNarratorAnswer falls back cleanly when the draft is raw planner JSON", () => {
  it("a JSON-shaped draft never reaches the user; the clean fallback table does", () => {
    const observations: AgentObservation[] = [
      { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "startValue", "endValue", "absoluteChange", "percentageChange"], rows: [["Активы", 100, 110, 10, 0.1]] },
    ];
    const draft = '{"kind":"tool_call","tool":"period.select","input":{"selector":"last"}}';
    const gated = gateNarratorAnswer(draft, observations, "ru");
    expect(gated.usedFallback).toBe(true);
    expect(gated.text).not.toMatch(/"kind"|tool_call|period\.select|\{/);
  });

  it("a clean narrator draft passes through unchanged", () => {
    const observations: AgentObservation[] = [
      { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "startValue", "endValue", "absoluteChange", "percentageChange"], rows: [["Активы", 100, 110, 10, 0.1]] },
    ];
    const gated = gateNarratorAnswer("Сравнение выполнено.", observations, "ru");
    expect(gated.usedFallback).toBe(false);
    expect(gated.text).toBe("Сравнение выполнено.");
  });
});

describe("Stage 25.1.3b §12/§13/§19 — internal canonical fields never reach the narrator's own input", () => {
  it("startPeriodCanonical/endPeriodCanonical are dropped from the FACTS block sent to the model", () => {
    const observations: AgentObservation[] = [
      {
        tool: "event.max_adjacent_change",
        ok: true,
        kind: "table",
        columns: ["metric", "startPeriod", "endPeriod", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell", "startPeriodCanonical", "endPeriodCanonical"],
        rows: [["обратное РЕПО", "01.12.2024", "01.11.2025", 38.6024, 317.1601, 278.5577, 7.2161, "A1", "A2", "2024-12-01", "2025-11-01"]],
      },
    ];
    const messages = buildNarratorMessages("Покажи наибольшее изменение.", "ru", observations);
    const userMessage = messages.find((m) => m.role === "user")!.content;
    expect(userMessage).not.toMatch(/startPeriodCanonical|endPeriodCanonical/i);
    expect(userMessage).not.toMatch(/2024-12-01|2025-11-01/); // the canonical VALUES too, not just the field names
    // the friendly display values remain present.
    expect(userMessage).toContain("01.12.2024");
    expect(userMessage).toContain("01.11.2025");
  });

  it("containsForbiddenLeak flags a literal mention of the canonical field names as defense in depth", () => {
    expect(containsForbiddenLeak("startPeriodCanonical: 2024-12-01")).toBe(true);
    expect(containsForbiddenLeak("endPeriodCanonical: 2025-11-01")).toBe(true);
    expect(containsForbiddenLeak("Период: 01.12.2024 → 01.11.2025")).toBe(false);
  });
});

describe("Stage 25.1.3b §14 — appendClauseCoverage renders a period PAIR as one range, not two raw fields", () => {
  it("combines startPeriod/endPeriod into 'Период: X → Y', never separate canonical columns", () => {
    const observations: AgentObservation[] = [
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value", "sourceCell"], rows: [["обратное РЕПО", "01.12.2024", 38.6024, "A1"]] },
      {
        tool: "event.max_adjacent_change",
        ok: true,
        kind: "table",
        columns: ["metric", "startPeriod", "endPeriod", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell", "startPeriodCanonical", "endPeriodCanonical"],
        rows: [["обратное РЕПО", "01.12.2024", "01.11.2025", 38.6024, 317.1601, 278.5577, 7.2161, "A1", "A2", "2024-12-01", "2025-11-01"]],
      },
    ];
    const appended = appendClauseCoverage("Готово.", observations, 2, "ru");
    expect(appended).toMatch(/Период:\s*01\.12\.2024\s*→\s*01\.11\.2025/);
    expect(appended).not.toMatch(/startPeriodCanonical|endPeriodCanonical|sourceCell/i);
  });
});

describe("Stage 25.1.3d §3/§6/§15/§16 — buildNarratorMessages narrows FACTS to the primary answer for a single-clause request", () => {
  it("a filter request's FACTS contain ONLY the filtered rows, never the upstream unfiltered compare table", () => {
    const observations: AgentObservation[] = [
      { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["Активы", 0.0054], ["обратное РЕПО", -0.1379], ["Обязательства", 0.0022]] },
      { tool: "set.filter", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["обратное РЕПО", -0.1379]] },
    ];
    const messages = buildNarratorMessages("Теперь покажи только показатели, которые снизились.", "ru", observations, 1);
    const userMessage = messages.find((m) => m.role === "user")!.content;
    expect(userMessage).not.toMatch(/Активы/);
    expect(userMessage).not.toMatch(/Обязательства/);
    expect(userMessage).toContain("обратное РЕПО");
  });

  it("a superlative request's FACTS contain ONLY the single winner row, never the full ranked/candidate set", () => {
    const observations: AgentObservation[] = [
      { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["Вклады клиентов", -0.0256], ["обратное РЕПО", -0.1379]] },
      { tool: "set.sort", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["обратное РЕПО", -0.1379], ["Вклады клиентов", -0.0256]] },
    ];
    const messages = buildNarratorMessages("Из них какой изменился сильнее всего?", "ru", observations, 1);
    const userMessage = messages.find((m) => m.role === "user")!.content;
    expect(userMessage).not.toMatch(/Вклады клиентов/);
    expect(userMessage).toContain("обратное РЕПО");
  });

  it("a genuinely compound (>=2 clause) request keeps FULL facts — never loses a clause's own data", () => {
    const observations: AgentObservation[] = [
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value"], rows: [["обратное РЕПО", "01.12.2024", 38.6], ["обратное РЕПО", "01.11.2025", 317.16]] },
      { tool: "event.max_adjacent_change", ok: true, kind: "table", columns: ["metric", "startPeriod", "endPeriod"], rows: [["обратное РЕПО", "01.12.2024", "01.11.2025"]] },
    ];
    const messages = buildNarratorMessages("Покажи его динамику и объясни, за счёт какого периода произошло наибольшее изменение.", "ru", observations, 2);
    const userMessage = messages.find((m) => m.role === "user")!.content;
    expect(userMessage).toMatch(/series\.get/);
    expect(userMessage).toMatch(/event\.max_adjacent_change/);
  });
});

describe("Stage 25.1.3d §15 — renderObservationsFallback and outcome.primary agree via the SAME determinePrimaryAnswer selection", () => {
  it("the fallback table shows the filtered result, not the upstream unfiltered compare table", () => {
    const observations: AgentObservation[] = [
      { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["Активы", 0.0054], ["обратное РЕПО", -0.1379]] },
      { tool: "set.filter", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["обратное РЕПО", -0.1379]] },
    ];
    const text = renderObservationsFallback(observations, "ru", "Теперь покажи только показатели, которые снизились.");
    expect(text).not.toMatch(/Активы/);
    expect(text).toContain("обратное РЕПО");
  });

  it("a superlative ask's fallback table shows exactly one winner row", () => {
    const observations: AgentObservation[] = [
      { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["Вклады клиентов", -0.0256], ["обратное РЕПО", -0.1379]] },
      { tool: "set.sort", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["обратное РЕПО", -0.1379], ["Вклады клиентов", -0.0256]] },
    ];
    const text = renderObservationsFallback(observations, "ru", "Из них какой изменился сильнее всего?");
    expect(text).not.toMatch(/Вклады клиентов/);
    expect(text).toContain("обратное РЕПО");
    // exactly one data row rendered (header + separator + 1 row).
    const lines = text.split("\n").filter((l) => l.startsWith("|"));
    expect(lines).toHaveLength(3);
  });
});

describe("Stage 25.1.3c §16 — renderObservationsFallback prefers the last ANSWER-SHAPED result over a trailing lookup step", () => {
  it("a change.compare_periods result stays the rendered table even when a period.select ran afterward (never a duplicated 'Дата | Дата' table)", () => {
    const observations: AgentObservation[] = [
      { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "startValue", "endValue", "absoluteChange", "percentageChange"], rows: [["Активы", 100, 110, 10, 0.1]] },
      // a trailing plumbing step — e.g. the model double-checking a date —
      // must never displace the real comparison table above.
      { tool: "period.select", ok: true, kind: "table", columns: ["period", "headerPath"], rows: [["2025-11-01", "01.11.2025"]] },
    ];
    const text = renderObservationsFallback(observations, "ru");
    expect(text).toMatch(/Было/);
    expect(text).toMatch(/Стало/);
    expect(text).not.toMatch(/\|\s*Дата\s*\|\s*Дата\s*\|/);
  });

  it("still falls back to the last table when no answer-shaped result exists at all (never regresses to 'no result')", () => {
    const observations: AgentObservation[] = [{ tool: "metric.list", ok: true, kind: "table", columns: ["metric", "semanticClass"], rows: [["Активы", "amount"]] }];
    const text = renderObservationsFallback(observations, "ru");
    expect(text).toMatch(/Показатель/);
    expect(text).not.toMatch(/Не удалось получить результат/);
  });
});
