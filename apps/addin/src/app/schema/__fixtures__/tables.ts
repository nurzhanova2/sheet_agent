// Stage 24.6 — a structurally diverse fixture family. Deterministic, synthetic.
// NO production logic may key off these exact strings.
import type { CellValue } from "@sheet-agent/application";

export interface FixtureSnapshot {
  readonly sheetName: string;
  readonly address: string;
  readonly values: readonly (readonly CellValue[])[];
  readonly numberFormats: readonly (readonly string[])[];
  readonly formulas: readonly (readonly (string | null)[])[];
  readonly startsBelowRow1: boolean;
}

function mk(
  sheetName: string,
  address: string,
  values: readonly (readonly CellValue[])[],
  fmt?: readonly (readonly string[])[],
  formulas?: readonly (readonly (string | null)[])[],
  startsBelowRow1 = false,
): FixtureSnapshot {
  const cols = values.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    sheetName,
    address,
    values,
    numberFormats: fmt ?? values.map(() => Array.from({ length: cols }, () => "General")),
    formulas: formulas ?? values.map(() => Array.from({ length: cols }, () => null)),
    startsBelowRow1,
  };
}

// A — flat records ---------------------------------------------------------
export function fixtureRecords(): FixtureSnapshot {
  const rows: CellValue[][] = [["Date", "City", "Owner", "Plan", "Fact"]];
  for (let i = 0; i < 24; i += 1) {
    rows.push([`2025-0${(i % 9) + 1}-01`, ["A", "B", "C"][i % 3]!, ["x", "y"][i % 2]!, 100 + i, 90 + i * 2]);
  }
  const fmt = rows.map((_, r) => (r === 0 ? ["General", "General", "General", "General", "General"] : ["yyyy-mm-dd", "General", "General", "#,##0", "#,##0"]));
  return mk("Flat", "Flat!A1:E25", rows, fmt);
}

// B — two-level hierarchical report --------------------------------------
export function fixtureHierarchical(): FixtureSnapshot {
  const values: CellValue[][] = [
    ["", "2024", "", "2025", ""],
    ["Indicator", "abs", "%", "abs", "%"],
    ["Revenue", 1000, 0.12, 1200, 0.2],
    ["Expense", 700, 0.08, 640, -0.086],
    ["Net", 300, 0.3, 560, 0.87],
  ];
  const fmt = [
    ["General", "General", "General", "General", "General"],
    ["General", "General", "General", "General", "General"],
    ["General", "#,##0", "0.0%", "#,##0", "0.0%"],
    ["General", "#,##0", "0.0%", "#,##0", "0.0%"],
    ["General", "#,##0", "0.0%", "#,##0", "0.0%"],
  ];
  return mk("Report", "Report!A1:E5", values, fmt);
}

// C — cross-tab Region × Year ------------------------------------------
export function fixtureCrossTab(): FixtureSnapshot {
  const values: CellValue[][] = [
    ["Region", "2024", "2025"],
    ["North", 10, 20],
    ["South", 15, 12],
    ["East", 8, 30],
    ["West", 22, 19],
  ];
  return mk("Xtab", "Xtab!A1:C5", values);
}

// D — time-series matrix (metrics down, months across) -----------------
export function fixtureTimeSeriesMatrix(): FixtureSnapshot {
  const values: CellValue[][] = [
    ["Metric", "Jan", "Feb", "Mar", "Apr"],
    ["A", 10, 20, 30, 25],
    ["B", 15, 25, 35, 40],
    ["C", 5, 4, 6, 90],
  ];
  return mk("TSM", "TSM!A1:E4", values);
}

// E — transposed time series (dates down rows, metric columns) ---------
export function fixtureTransposed(): FixtureSnapshot {
  const values: CellValue[][] = [["Date", "Revenue", "Cost", "Profit"]];
  const serials = [45658, 45689, 45717, 45748, 45778, 45809];
  const rev = [100, 140, 120, 160, 150, 210];
  for (let i = 0; i < serials.length; i += 1) {
    values.push([serials[i]!, rev[i]!, rev[i]! - 40, 40]);
  }
  const fmt = values.map((_, r) => (r === 0 ? ["General", "General", "General", "General"] : ["dd.mm.yyyy", "#,##0", "#,##0", "#,##0"]));
  return mk("Trans", "Trans!A1:D7", values, fmt);
}

// F — merged hierarchical headers (2024 spans Q1..Q4) -----------------
export function fixtureMergedHeaders(): FixtureSnapshot {
  const values: CellValue[][] = [
    ["", "2024", "", "", "", "2025", "", "", ""],
    ["Metric", "Q1", "Q2", "Q3", "Q4", "Q1", "Q2", "Q3", "Q4"],
    ["Revenue", 10, 12, 11, 15, 13, 14, 16, 20],
    ["Cost", 6, 7, 6, 8, 7, 7, 9, 10],
  ];
  return mk("Merged", "Merged!A1:I4", values);
}

// G — mixed amount / percent / count columns -------------------------
export function fixtureMixedUnits(): FixtureSnapshot {
  const values: CellValue[][] = [
    ["Item", "Amount", "Share", "Accounts"],
    ["Alpha", 1_000_000, 0.25, 17],
    ["Beta", 2_000_000, 0.5, 40],
    ["Gamma", 1_000_000, 0.25, 12],
  ];
  const fmt = [
    ["General", "General", "General", "General"],
    ["General", "#,##0 \"KZT\"", "0.0%", "#,##0"],
    ["General", "#,##0 \"KZT\"", "0.0%", "#,##0"],
    ["General", "#,##0 \"KZT\"", "0.0%", "#,##0"],
  ];
  return mk("Mixed", "Mixed!A1:D4", values, fmt);
}

// H — totals / subtotals -------------------------------------------
export function fixtureTotals(): FixtureSnapshot {
  const values: CellValue[][] = [
    ["Line", "2024", "2025"],
    ["Item 1", 10, 12],
    ["Item 2", 20, 25],
    ["Total A", 30, 37],
    ["Item 3", 5, 7],
    ["Item 4", 8, 9],
    ["Total B", 13, 16],
    ["Grand Total", 43, 53],
  ];
  const formulas = values.map((row) =>
    row.map((_, c) => (c > 0 && /total/i.test(String(row[0])) ? "=SUM(X)" : null)),
  );
  return mk("Totals", "Totals!A1:C8", values, undefined, formulas);
}

// I — partial: a numeric block that starts below the real header ------
export function fixturePartialHeaders(): FixtureSnapshot {
  const values: CellValue[][] = [];
  for (let r = 0; r < 12; r += 1) {
    values.push([100 + r, 200 + r * 2, 300 - r, 0.1 + r / 100]);
  }
  const fmt = values.map(() => ["#,##0", "#,##0", "#,##0", "0.0%"]);
  return mk("Balance", "Balance!B5:E16", values, fmt, undefined, true);
}

// J — unknown labels (no business semantics) -------------------------
export function fixtureUnknownLabels(): FixtureSnapshot {
  const values: CellValue[][] = [
    ["Alpha", "X1", "X2", "X3"],
    ["Beta", 3, 9, 2],
    ["Gamma", 7, 1, 8],
    ["Delta", 4, 6, 5],
  ];
  return mk("Unk", "Unk!A1:D4", values);
}

// Stage 24.7 — synthetic time-series with a KNOWN volatility ordering (§62).
// Dates down the rows; A: flat, B: wild swings, C: smooth steady climb.
export function fixtureVolatilitySeries(): FixtureSnapshot {
  const serials = [45658, 45689, 45717, 45748, 45778]; // 5 monthly snapshots in 2025
  const a = [100, 101, 99, 100, 101];
  const b = [100, 150, 70, 180, 60];
  const c = [100, 110, 120, 130, 140];
  const values: CellValue[][] = [["Date", "A", "B", "C"]];
  for (let i = 0; i < serials.length; i += 1) values.push([serials[i]!, a[i]!, b[i]!, c[i]!]);
  const fmt = values.map((_, r) => (r === 0 ? ["General", "General", "General", "General"] : ["dd.mm.yyyy", "#,##0", "#,##0", "#,##0"]));
  return mk("Vol", "Vol!A1:D6", values, fmt);
}

// Stage 24.7 — synthetic monotonicity fixture (§63).
// A: strictly up, B: non-decreasing (a repeat), C: strictly down, D: zig-zag.
export function fixtureMonotonicSeries(): FixtureSnapshot {
  const serials = [45658, 45689, 45717, 45748];
  const a = [1, 2, 3, 4];
  const b = [1, 2, 2, 3];
  const c = [4, 3, 2, 1];
  const d = [1, 3, 2, 4];
  const values: CellValue[][] = [["Date", "A", "B", "C", "D"]];
  for (let i = 0; i < serials.length; i += 1) values.push([serials[i]!, a[i]!, b[i]!, c[i]!, d[i]!]);
  const fmt = values.map((_, r) => (r === 0 ? ["General", "General", "General", "General", "General"] : ["dd.mm.yyyy", "#,##0", "#,##0", "#,##0", "#,##0"]));
  return mk("Mono", "Mono!A1:E5", values, fmt);
}

// Stage 24.7.1 §44 — a synthetic fixture with a KNOWN percent-change
// distribution (dates down rows, metrics across columns): A +30%, B +10%,
// C -25%, D -5% between the first and last date.
export function fixtureKnownPercentChanges(): FixtureSnapshot {
  const serials = [45658, 45689, 45717, 45748, 45778]; // 01.2025 .. 05.2025
  const a = [100, 105, 110, 120, 130];
  const b = [100, 102, 105, 108, 110];
  const c = [100, 95, 90, 82, 75];
  const d = [100, 99, 98, 97, 95];
  const values: CellValue[][] = [["Date", "A", "B", "C", "D"]];
  for (let i = 0; i < serials.length; i += 1) values.push([serials[i]!, a[i]!, b[i]!, c[i]!, d[i]!]);
  const fmt = values.map((_, r) => (r === 0 ? ["General", "General", "General", "General", "General"] : ["dd.mm.yyyy", "#,##0", "#,##0", "#,##0", "#,##0"]));
  return mk("Thr", "Thr!A1:E6", values, fmt);
}

// Stage 24.7.1 §45 — a synthetic fixture where the percentage-change ranking
// diverges from the absolute-change ranking of the SAME "за месяц, Δ" horizon:
// A: abs +100 / pct +1%. B: abs +50 / pct +10%. B must outrank A by percent.
export function fixtureRankBasisDivergence(): FixtureSnapshot {
  const level0: CellValue[] = ["", "за месяц, Δ", ""];
  const level1: CellValue[] = ["Показатель", "абс.", "%"];
  const rows: CellValue[][] = [
    level0,
    level1,
    ["A", 100, 0.01],
    ["B", 50, 0.1],
  ];
  const fmt = rows.map((_, r) => (r < 2 ? level1.map(() => "General") : ["General", "#,##0", "0.0%"]));
  return mk("Rnk", "Rnk!A1:C4", rows, fmt);
}

// Stage 24.7.1 (final metric-resolution correction) — reproduces the real
// production defect where a LONGER label that merely CONTAINS the requested
// metric's words ("доля ликвидных активов в активах") wrongly outranked the
// exact / morphologically exact shorter metric ("Активы", "Ликвидные
// активы") in metric resolution. Also carries English synthetic equivalents
// (Revenue / Net Revenue / Revenue Share) to prove the same precedence rule
// language-agnostically. Values are deterministic synthetic numbers chosen
// to exercise the acceptance test's exact expected time series — not
// derived from any real bank data.
export function fixtureMetricPrecedence(): FixtureSnapshot {
  const periodSerials = [45292, 45627, 45658, 45962, 45992]; // 01.01.2024, 01.12.2024, 01.01.2025, 01.11.2025, 01.12.2025
  const level0: CellValue[] = [""];
  const level1: CellValue[] = ["Наименование показателя"];
  for (const s of periodSerials) {
    level0.push(s, "");
    level1.push("абс.", "%");
  }
  const series: Record<string, readonly number[]> = {
    "Активы": [14943.2642, 17394.2726, 17941.7418, 19764.2831, 19871.5449],
    "Ликвидные активы": [4765.723, 5495.0094, 5573.5638, 6029.0632, 6044.5546],
    "доля ликвидных активов в активах": [0.3189, 0.3159, 0.3106, 0.305, 0.3042],
    Revenue: [1000, 1050, 1100, 1150, 1200],
    "Net Revenue": [900, 940, 980, 1010, 1040],
    "Revenue Share": [0.62, 0.63, 0.64, 0.65, 0.66],
  };
  // "доля ..." / "... Share" rows are ratio-only metrics: both data columns
  // for that row are percent-formatted (there is no separate "abs" figure),
  // so a time-series read renders "31.89%" rather than the raw "0.3189".
  const percentOnlyRows = new Set(["доля ликвидных активов в активах", "Revenue Share"]);
  const rows: CellValue[][] = [level0, level1];
  for (const [name, abs] of Object.entries(series)) {
    const row: CellValue[] = [name];
    abs.forEach((v, i) => {
      row.push(v, Number(((i + 1) * 0.01).toFixed(4)));
    });
    rows.push(row);
  }
  const fmt = rows.map((_, r) => {
    if (r === 0) return level0.map((v, c) => (c === 0 ? "General" : typeof v === "number" ? "dd.mm.yyyy" : "General"));
    if (r === 1) return level1.map(() => "General");
    const rowName = String(rows[r]![0]);
    if (percentOnlyRows.has(rowName)) return level1.map((_v, c) => (c === 0 ? "General" : "0.0%"));
    return level1.map((v, c) => (c === 0 ? "General" : String(v) === "%" ? "0.0%" : "#,##0.0000"));
  });
  return mk("Prec", "Prec!A1:K8", rows, fmt);
}

// Stage 24.8 §31–§36 — explicit-interval derived ranking (dates down rows,
// metrics across columns — the same proven `column_metrics` shape as
// `fixtureKnownPercentChanges`). Two dates only (01.01.2024 .. 01.12.2025);
// A/C are the strongest grower / decliner by PERCENTAGE, B has the largest
// absolute change despite a modest percentage — deliberately divergent so
// percentage-vs-absolute-basis ranking tests have an unambiguous, distinct
// expected order either way.
export function fixtureIntervalRanking(): FixtureSnapshot {
  const serials = [45292, 45992]; // 01.01.2024, 01.12.2025
  const a = [100, 140]; // +40%,  Δabs +40
  const b = [1_000_000, 1_100_000]; // +10%,  Δabs +100,000 (largest absolute)
  const c = [200, 130]; // -35%,  Δabs -70
  const d = [500, 475]; // -5%,   Δabs -25
  const values: CellValue[][] = [["Date", "A", "B", "C", "D"]];
  for (let i = 0; i < serials.length; i += 1) values.push([serials[i]!, a[i]!, b[i]!, c[i]!, d[i]!]);
  const fmt = values.map((_, r) => (r === 0 ? ["General", "General", "General", "General", "General"] : ["dd.mm.yyyy", "#,##0", "#,##0", "#,##0", "#,##0"]));
  return mk("IntRank", "IntRank!A1:E3", values, fmt);
}

// Stage 24.8 §37/§38/§39/§53/§54 — two independently-signed sub-intervals
// (01.01.2024 → 01.01.2025 → 01.12.2025) AND, via the same 3 dates, the
// adjacent-period event engine (same proven `column_metrics` shape). A grew
// then declined; B declined then grew; C grew in both (control — excluded
// from either two-interval predicate combination). B's second adjacent event
// (+50%) is the unambiguous global largest adjacent change, distinct from any
// single-interval endpoint change.
export function fixtureTwoIntervalAndEvents(): FixtureSnapshot {
  const serials = [45292, 45658, 45992]; // 01.01.2024, 01.01.2025, 01.12.2025
  const a = [100, 140, 100]; // +40% then -28.57%
  const b = [100, 80, 120]; // -20% then +50% (largest single adjacent swing)
  const c = [100, 110, 125]; // +10% then +13.64%
  const values: CellValue[][] = [["Date", "A", "B", "C"]];
  for (let i = 0; i < serials.length; i += 1) values.push([serials[i]!, a[i]!, b[i]!, c[i]!]);
  const fmt = values.map((_, r) => (r === 0 ? ["General", "General", "General", "General"] : ["dd.mm.yyyy", "#,##0", "#,##0", "#,##0"]));
  return mk("TwoInt", "TwoInt!A1:D4", values, fmt);
}

// Stage 24.9 — direction-change / monotonic-symmetry / semantic-class-filter
// / multi-metric fixture. Row-metrics orientation, the SAME proven 2-level
// header shape as `fixtureBalanceLike` / `fixtureMetricPrecedence` (dates +
// "абс./%" sub-header) — the real Баланс!B2:Q25 shape. 5 canonical points.
//
//   Активы:        1000 → 1100 → 1200 → 1300 → 1400   (never decreased, low volatility)
//   Обязательства:   500 →  480 →  460 →  440 →  420   (never increased, low volatility)
//   Ликвидные активы: 200 →  220 →  210 →  230 →  225   (3 direction reversals — the
//                                                         unique direction-change winner;
//                                                         moderate volatility, ~0.0764)
//   доля ликвидных активов в активах (share, %): 0.20→0.21→0.22→0.23→0.24 (never
//                                                 decreased; ~zero volatility)
//   уровень долларизации вкладов физлиц (rate, %): 0.45→0.40→0.35→0.50→0.55 (1
//     reversal; the LARGEST raw volatility score of all 5 — the unfiltered
//     volatility winner, and the metric a percentage-exclusion filter must remove)
export function fixtureDirectionAndSets(): FixtureSnapshot {
  const periodSerials = [45292, 45383, 45474, 45566, 45658]; // 01.01/01.04/01.07/01.10.2024, 01.01.2025
  const level0: CellValue[] = [""];
  const level1: CellValue[] = ["Наименование показателя"];
  for (const s of periodSerials) {
    level0.push(s, "");
    level1.push("абс.", "%");
  }
  const series: Record<string, readonly number[]> = {
    "Активы": [1000, 1100, 1200, 1300, 1400],
    "Обязательства": [500, 480, 460, 440, 420],
    "Ликвидные активы": [200, 220, 210, 230, 225],
    "доля ликвидных активов в активах": [0.2, 0.21, 0.22, 0.23, 0.24],
    "уровень долларизации вкладов физлиц": [0.45, 0.4, 0.35, 0.5, 0.55],
  };
  // percent-only rows (share/rate): BOTH data columns are percent-formatted —
  // there is no separate "abs" figure (same convention as `fixtureMetricPrecedence`).
  const percentOnlyRows = new Set(["доля ликвидных активов в активах", "уровень долларизации вкладов физлиц"]);
  const rows: CellValue[][] = [level0, level1];
  for (const [name, abs] of Object.entries(series)) {
    const row: CellValue[] = [name];
    abs.forEach((v, i) => {
      row.push(v, Number(((i + 1) * 0.01).toFixed(4)));
    });
    rows.push(row);
  }
  const fmt = rows.map((_, r) => {
    if (r === 0) return level0.map((v, c) => (c === 0 ? "General" : typeof v === "number" ? "dd.mm.yyyy" : "General"));
    if (r === 1) return level1.map(() => "General");
    const rowName = String(rows[r]![0]);
    if (percentOnlyRows.has(rowName)) return level1.map((_v, c) => (c === 0 ? "General" : "0.00%"));
    return level1.map((v, c) => (c === 0 ? "General" : String(v) === "%" ? "0.0%" : "#,##0"));
  });
  return mk("Баланс9", "Баланс9!A1:K7", rows, fmt);
}

// Balance-like acceptance fixture (§38) -----------------------------
export function fixtureBalanceLike(): FixtureSnapshot {
  const periodSerials = [45292, 45597, 45658, 45931, 45962]; // 5 dated snapshots
  const changeHorizons = ["за 1 месяц, Δ", "с нач. года, Δ 2025", "за пред. год, Δ (2024)"];
  const level0: CellValue[] = [""];
  const level1: CellValue[] = ["Наименование показателя"];
  for (const s of periodSerials) {
    level0.push(s, "");
    level1.push("абс.", "%");
  }
  for (const h of changeHorizons) {
    level0.push(h, "");
    level1.push("абс.", "%");
  }
  const dataCols = level1.length - 1;
  const indicators = ["Активы", "Ликвидные активы", "Обязательства", "Капитал", "Ссудный портфель", "Депозиты"];
  const rows: CellValue[][] = [level0, level1];
  indicators.forEach((name, i) => {
    const row: CellValue[] = [name];
    for (let c = 0; c < dataCols; c += 1) {
      const isPct = c % 2 === 1;
      row.push(isPct ? Number(((i + 1) * 0.013 - c / 1000).toFixed(4)) : (i + 1) * 1_000_000 + c * 25_000);
    }
    rows.push(row);
  });
  const fmt = rows.map((_, r) => {
    if (r === 0) return level0.map((v, c) => (c === 0 ? "General" : typeof v === "number" ? "dd.mm.yyyy" : "General"));
    if (r === 1) return level1.map(() => "General");
    return level1.map((v, c) => (c === 0 ? "General" : String(v) === "%" ? "0.0%" : "#,##0"));
  });
  const lastColLetter = String.fromCharCode(65 + Math.min(25, dataCols)); // rough
  void lastColLetter;
  return mk("Баланс", "Баланс!B1:Q25", rows, fmt);
}
