import { describe, expect, it } from "vitest";
import { induceTableSchema } from "../schema-induction.js";
import { fixtureBalanceLike } from "../__fixtures__/tables.js";
import { buildPeriodIndex } from "./period-index.js";
import { normalizeDateText, resolvePeriod } from "./period-resolver.js";

const fx = fixtureBalanceLike();
const schema = induceTableSchema({
  values: fx.values,
  numberFormats: fx.numberFormats,
  formulas: fx.formulas,
  sheetName: fx.sheetName,
  sourceRange: fx.address,
  sourceVersion: `v@${fx.address}`,
});
const index = buildPeriodIndex(schema, { values: fx.values, numberFormats: fx.numberFormats });
// available point dates: 2024-01-01, 2024-11-01, 2025-01-01, 2025-10-01, 2025-11-01

describe("normalizeDateText", () => {
  it("normalises equivalent forms to one ISO date", () => {
    for (const s of ["01.01.2025", "01/01/2025", "2025-01-01", "1 января 2025", "January 1 2025", "1 January 2025"]) {
      expect(normalizeDateText(s), s).toBe("2025-01-01");
    }
    expect(normalizeDateText("01.01.25")).toBe("2025-01-01");
  });
  it("returns null for a non-date", () => {
    expect(normalizeDateText("за последний месяц")).toBeNull();
    expect(normalizeDateText("норма")).toBeNull();
  });
});

describe("resolvePeriod — exact points, NO silent substitution (§2, §58, §59)", () => {
  it("resolves an in-table date to exactly that date even though the raw header is a serial", () => {
    const r = resolvePeriod("01.01.2025", index);
    expect(r.kind).toBe("point");
    if (r.kind === "point") expect(r.period.canonical).toBe("2025-01-01");
  });
  it("an unknown date is UNRESOLVED — never the nearest period", () => {
    const r = resolvePeriod("03.03.2023", index);
    expect(r.kind).toBe("unresolved");
    if (r.kind === "unresolved") expect(r.detail).toMatch(/no period 2023-03-03/);
  });
  it("a comparison with a missing endpoint fails, naming the missing one", () => {
    const r = resolvePeriod("между 01.01.2023 и 01.12.2025", index);
    expect(r.kind).toBe("unresolved");
    if (r.kind === "unresolved") expect(r.requested).toBe("2023-01-01");
  });
  it("an interval where both endpoints resolve returns exactly those two", () => {
    const r = resolvePeriod("между 01.01.2024 и 01.11.2025", index);
    expect(r.kind).toBe("interval");
    if (r.kind === "interval") {
      expect(r.interval.start.canonical).toBe("2024-01-01");
      expect(r.interval.end.canonical).toBe("2025-11-01");
      expect(r.inherited).toBe(false);
    }
  });
  it('"на 01.01.2025 и 01.11.2025" is an interval of exactly those dates', () => {
    const r = resolvePeriod("сравни значения на 01.01.2025 и 01.11.2025", index);
    expect(r.kind).toBe("interval");
    if (r.kind === "interval") {
      expect([r.interval.start.canonical, r.interval.end.canonical]).toEqual(["2025-01-01", "2025-11-01"]);
    }
  });
});

describe("resolvePeriod — change horizons (§26)", () => {
  it('"за последний месяц" → the one-month change column', () => {
    const r = resolvePeriod("за последний месяц", index);
    expect(r.kind).toBe("horizon");
    if (r.kind === "horizon") expect(r.period.horizon).toBe("last_month");
  });
  it('"с начала 2025 года" → the YTD change column', () => {
    const r = resolvePeriod("с начала 2025 года", index);
    expect(r.kind).toBe("horizon");
    if (r.kind === "horizon") expect(r.period.horizon).toBe("ytd");
  });
  it('"за предыдущий год" → the prior-year change column', () => {
    const r = resolvePeriod("за предыдущий год", index);
    expect(r.kind).toBe("horizon");
    if (r.kind === "horizon") expect(r.period.horizon).toBe("prior_year");
  });
});

describe("resolvePeriod — inherited period (§12, §35, §60)", () => {
  const inherited = {
    start: index.points.find((p) => p.canonical === "2025-01-01")!,
    end: index.points.find((p) => p.canonical === "2025-11-01")!,
  };
  it('"за этот же период" reuses the remembered interval exactly', () => {
    const r = resolvePeriod("какие показатели снизились за этот же период?", index, inherited);
    expect(r.kind).toBe("interval");
    if (r.kind === "interval") {
      expect(r.inherited).toBe(true);
      expect([r.interval.start.canonical, r.interval.end.canonical]).toEqual(["2025-01-01", "2025-11-01"]);
    }
  });
  it('"за этот же период" with nothing remembered is unresolved (not a guess)', () => {
    const r = resolvePeriod("за этот же период", index);
    expect(r.kind).toBe("unresolved");
  });
});
