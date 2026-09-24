export type DateSystem = "1900" | "1904";

/** Lower/upper serials we will even consider as a date (≈ 1900-01-01 … 2149-12-31). */
const MIN_SERIAL = 1;
const MAX_SERIAL = 91_312;

/** A number-format string that means the cell is displayed as a date/time. */
export function isDateNumberFormat(format: string | null | undefined): boolean {
  if (!format) return false;
  const f = format.trim().toLowerCase();
  if (f === "" || f === "general" || f === "@") return false;
  // Strip quoted literals and locale/colour tokens so "d" inside a literal
  // doesn't count.
  const stripped = f.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  // Date/time tokens Excel uses: y m d h s, plus AM/PM. Require at least one
  // y/d token (a bare "m"/"h" alone is minutes/hours, still time — accept those
  // too) and NO currency/percent markers.
  if (/[€$£¥%]/.test(stripped)) return false;
  return /(?:\byy?y?y?\b|\bd{1,4}\b|\bm{1,5}\b|\bh{1,2}\b|\bs{1,2}\b|am\/pm|a\/p)/.test(stripped) &&
    /[ymdhs]/.test(stripped);
}

/** True when the format is a percentage format. */
export function isPercentNumberFormat(format: string | null | undefined): boolean {
  return typeof format === "string" && format.includes("%");
}

/** True when the format looks like a currency / accounting format. */
export function isCurrencyNumberFormat(format: string | null | undefined): boolean {
  if (!format) return false;
  const stripped = format.replace(/\[[^\]]*\]/g, "");
  return /[€$£¥₸₽]|\bruб?\b|\busd\b|\beur\b|\bkzt\b|\btg\b|"[^"]*[€$£¥₸₽][^"]*"/i.test(stripped);
}

export interface ExcelDate {
  readonly serial: number;
  /** ISO 8601 date (no time) or date-time when the serial has a fractional part. */
  readonly iso: string;
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

/**
 * Converts an Excel serial to a calendar date. Returns null when the serial is
 * outside the plausible window. Honours Excel's 1900 leap-year bug (serial 60 =
 * the fictitious 1900-02-29) by treating serial 60 as invalid and shifting
 * everything after it back by one day, which is what Excel actually displays.
 */
export function excelSerialToDate(serial: number, system: DateSystem = "1900"): ExcelDate | null {
  const min = system === "1904" ? 0 : MIN_SERIAL;
  if (!Number.isFinite(serial) || serial < min || serial > MAX_SERIAL) return null;
  const whole = Math.floor(serial);
  const frac = serial - whole;

  let epochUtcMs: number;
  let daysToAdd: number;
  if (system === "1904") {
    epochUtcMs = Date.UTC(1904, 0, 1);
    daysToAdd = whole;
  } else {
    // 1900 system: serial 1 = 1900-01-01. Excel wrongly counts 1900 as a leap
    // year, so for serial > 59 subtract one day to match Excel's display.
    epochUtcMs = Date.UTC(1899, 11, 31);
    daysToAdd = whole > 59 ? whole - 1 : whole;
    if (whole === 60) return null; // 1900-02-29 does not exist
  }

  const ms = epochUtcMs + daysToAdd * 86_400_000 + Math.round(frac * 86_400_000);
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const isoDate = `${year}-${pad(month)}-${pad(day)}`;
  const iso =
    frac > 1e-9
      ? `${isoDate}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
      : isoDate;
  return { serial: whole + frac, iso, year, month, day };
}

/** A short human date label, "01.11.2025" style (day-first, matches RU reports). */
export function formatDateLabel(date: ExcelDate): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.day)}.${pad(date.month)}.${date.year}`;
}

/**
 * Best-effort: interpret a header/label cell as a date. Accepts a real serial
 * (only with `formatIsDate`), an ISO-ish string, or a "dd.mm.yy(yy)" string.
 * Returns null when there is no confident date reading.
 */
export function coerceHeaderDate(
  raw: unknown,
  formatIsDate: boolean,
  system: DateSystem = "1900",
): ExcelDate | null {
  if (typeof raw === "number") {
    return formatIsDate ? excelSerialToDate(raw, system) : null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2})?$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const da = Number(m[3]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      const pad = (n: number): string => String(n).padStart(2, "0");
      return { serial: NaN, iso: `${y}-${pad(mo)}-${pad(da)}`, year: y, month: mo, day: da };
    }
  }
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const da = Number(m[1]);
    const mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      const pad = (n: number): string => String(n).padStart(2, "0");
      return { serial: NaN, iso: `${y}-${pad(mo)}-${pad(da)}`, year: y, month: mo, day: da };
    }
  }
  return null;
}
