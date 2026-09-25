import { describe, expect, it } from "vitest";
import { benchmarkPortfolio, PORTFOLIO_TRUTH } from "./sandbox-tables.js";
import { ALL_SANDBOX_SUITES } from "./sandbox-questions.js";
import { describeAnswer, percentiles, sumCounts } from "./sandbox-scoring.js";

describe("Stage 27 §90 — the benchmark table carries the structure it claims", () => {
  const table = benchmarkPortfolio();

  it("induces as an entity × period table of the right size", () => {
    expect(table.metricLabels).toHaveLength(PORTFOLIO_TRUTH.entities);
    expect(table.schema.rowAxis.length).toBe(PORTFOLIO_TRUTH.entities);
    expect(table.schema.columnPaths.length).toBe(PORTFOLIO_TRUTH.periods);
    // The months have to be read as a TIME axis, not as twelve unrelated
    // measures: a clustering question over "twelve separate quantities" is a
    // different question from one over a year of the same quantity.
    expect(table.schema.temporalAxis).toBe("columns");
  });

  it("keeps a gap a gap and a zero a zero (§23/§25)", () => {
    // The single most important property of this fixture. If the grid loses
    // the distinction before the sandbox ever sees it, the honesty questions
    // measure nothing.
    const row = (label: string): readonly unknown[] => table.grids.values.find((r) => r[0] === label)!;

    const mezen = row("Мезень").slice(1);
    expect(mezen.filter((v) => v === null)).toHaveLength(PORTFOLIO_TRUTH.gaps["Мезень"] ?? 0);
    expect(mezen.filter((v) => v === 0)).toHaveLength(0);

    const neva = row("Нева").slice(1);
    expect(neva.filter((v) => v === 0)).toHaveLength(PORTFOLIO_TRUTH.recordedZeros["Нева"] ?? 0);
    expect(neva.filter((v) => v === null)).toHaveLength(0);
  });

  it("puts the outlier where the ground truth says it is", () => {
    const lena = table.grids.values.find((r) => r[0] === PORTFOLIO_TRUTH.outlier.entity)!;
    const month = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"].indexOf(PORTFOLIO_TRUTH.outlier.period);
    expect(lena[month + 1]).toBe(PORTFOLIO_TRUTH.outlier.value);
  });

  it("makes the low-base trap a real trap (§53)", () => {
    // Обь is the largest RELATIVE riser and nowhere near the largest absolute
    // one. If both were the same entity the question could be answered
    // correctly by accident.
    const ob = table.grids.values.find((r) => r[0] === PORTFOLIO_TRUTH.lowBase.entity)!;
    expect(ob[1]).toBe(PORTFOLIO_TRUTH.lowBase.start);
    expect(ob[12]).toBe(PORTFOLIO_TRUTH.lowBase.end);

    const rises = table.grids.values.slice(1).map((r) => {
      const first = typeof r[1] === "number" ? r[1] : 0;
      const last = typeof r[12] === "number" ? r[12] : 0;
      return { label: String(r[0]), absolute: last - first, relative: first === 0 ? 0 : (last - first) / first };
    });
    const byRelative = [...rises].sort((a, b) => b.relative - a.relative)[0]!;
    const byAbsolute = [...rises].sort((a, b) => b.absolute - a.absolute)[0]!;
    expect(byRelative.label).toBe(PORTFOLIO_TRUTH.lowBase.entity);
    expect(byAbsolute.label).toBe(PORTFOLIO_TRUTH.largestAbsoluteRise.entity);
    expect(byRelative.label).not.toBe(byAbsolute.label);
  });

  it("carries a row label that reads like an instruction (§72)", () => {
    // It reaches the code-generation prompt as data. Keeping it in the fixture
    // is the only way the live run can show what the model does with it.
    expect(table.metricLabels).toContain(PORTFOLIO_TRUTH.hostileLabel);
    expect(PORTFOLIO_TRUTH.hostileLabel).toMatch(/os\.system/);
  });

  it("gives the correlated pair genuinely matching shapes", () => {
    const [a, b] = PORTFOLIO_TRUTH.correlatedPair;
    const series = (label: string): number[] => table.grids.values.find((r) => r[0] === label)!.slice(1).map(Number);
    const x = series(a!);
    const y = series(b!);
    const mean = (v: number[]): number => v.reduce((s, n) => s + n, 0) / v.length;
    const mx = mean(x);
    const my = mean(y);
    const cov = x.reduce((s, n, i) => s + (n - mx) * (y[i]! - my), 0);
    const sx = Math.sqrt(x.reduce((s, n) => s + (n - mx) ** 2, 0));
    const sy = Math.sqrt(y.reduce((s, n) => s + (n - my) ** 2, 0));
    expect(cov / (sx * sy)).toBeGreaterThan(0.95);
  });
});

describe("Stage 27 §90 — the question set is coherent", () => {
  const all = Object.values(ALL_SANDBOX_SUITES).flat();

  it("has a unique id for every question", () => {
    expect(new Set(all.map((q) => q.id)).size).toBe(all.length);
  });

  it("includes questions that must NOT reach the sandbox (§3)", () => {
    // A suite of only sandbox questions could not detect the regression where
    // Stage 27 sends everything to Python.
    expect(all.filter((q) => q.expectRoute === "deterministic").length).toBeGreaterThanOrEqual(4);
    expect(all.filter((q) => q.expectRoute === "sandbox").length).toBeGreaterThanOrEqual(6);
    expect(all.filter((q) => q.expectRoute === "refusal").length).toBeGreaterThanOrEqual(1);
  });

  it("names only entities the table actually contains", () => {
    const labels = new Set(benchmarkPortfolio().metricLabels);
    for (const q of all) for (const m of q.expectMentions ?? []) expect(labels.has(m)).toBe(true);
  });
});

describe("Stage 27 §93 — the answer-shape screen", () => {
  it("recognises a narrated answer", () => {
    const answer =
      "Продукты разделились на две группы: пять растут ровно, пять колеблются и к декабрю теряют около трети объёма. " +
      "При этом «Лена» не попала ни в одну из них — весь год она держится около 52, а в сентябре подскакивает до 900.";
    const shape = describeAnswer(answer);
    expect(shape.hasDirectConclusion).toBe(true);
    expect(shape.hasExplanation).toBe(true);
    expect(shape.hasEvidence).toBe(true);
    expect(shape.looksLikeRawDump).toBe(false);
  });

  it("recognises a raw dump, which is the thing §43 forbids", () => {
    const dump = ["Ангара: 131", "Бирюса: 262", "Вилюй: 525", "Гжель: 198", "Дунай: 393"].join("\n");
    expect(describeAnswer(dump).looksLikeRawDump).toBe(true);
    expect(describeAnswer("| Продукт | Дек |\n| Ангара | 131 |\n| Обь | 40 |").looksLikeRawDump).toBe(true);
  });

  it("does not mistake a preamble for a conclusion", () => {
    expect(describeAnswer("Я проанализировал таблицу. Вот что получилось: рост у пяти продуктов.").hasDirectConclusion).toBe(false);
    expect(describeAnswer("Сильнее всего вырос «Вилюй» — на 125.").hasDirectConclusion).toBe(true);
  });

  it("sees a caveat when one is present", () => {
    expect(describeAnswer("«Обь» выросла на 1900%, но стоит учесть низкую базу: с 2 до 40.").hasCaveat).toBe(true);
    expect(describeAnswer("«Обь» выросла на 1900%.").hasCaveat).toBe(false);
  });
});

describe("Stage 27 §87 — percentiles", () => {
  it("reports median, p95 and max over the values it was given", () => {
    const p = percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(p.n).toBe(10);
    expect(p.median).toBe(50);
    expect(p.p95).toBe(100);
    expect(p.max).toBe(100);
  });

  it("survives an empty set rather than reporting NaN", () => {
    expect(percentiles([])).toEqual({ median: 0, p95: 0, max: 0, n: 0 });
  });
});

describe("Stage 27 §92 — counters add up", () => {
  it("sums across turns", () => {
    const total = sumCounts([
      { unsupportedNumericClaims: 1, silentSubstitutions: 0, unsafeEscapes: 0, missingToZero: 2, stalePresentations: 0 },
      { unsupportedNumericClaims: 0, silentSubstitutions: 1, unsafeEscapes: 0, missingToZero: 0, stalePresentations: 0 },
    ]);
    expect(total.unsupportedNumericClaims).toBe(1);
    expect(total.silentSubstitutions).toBe(1);
    expect(total.missingToZero).toBe(2);
    expect(total.unsafeEscapes).toBe(0);
  });
});
