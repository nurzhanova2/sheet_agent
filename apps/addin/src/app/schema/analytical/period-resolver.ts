// ---------------------------------------------------------------------------
// Stage 24.7 — the PeriodResolver (§8–§13, §26).
//
// NON-NEGOTIABLE (§2): NO SILENT SUBSTITUTION. A requested date resolves to
// EXACTLY that date or the resolution fails / clarifies. A nearby / nearest /
// latest / first period is never substituted.
// ---------------------------------------------------------------------------

import type { CanonicalPeriod, ChangeHorizon, ResolvedInterval } from "./types.js";
import type { PeriodIndex } from "./period-index.js";

const RU_MONTHS: Readonly<Record<string, number>> = {
  январ: 1, феврал: 2, март: 3, апрел: 4, мая: 5, май: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
};
const EN_MONTHS: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Normalises a date literal to ISO (YYYY-MM-DD). Returns null when the text is
 *  not a confident single calendar date. Does NOT infer nearby dates. */
export function normalizeDateText(text: string): string | null {
  const s = text.trim().toLowerCase().replace(/\s*г\.?\s*$/u, "").trim();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  // "1 января 2025" / "1 янв 2025"
  m = /^(\d{1,2})\s+([а-яё]+)\.?\s+(\d{4})$/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const y = Number(m[3]);
    const key = Object.keys(RU_MONTHS).find((k) => m![2]!.startsWith(k));
    if (key && d >= 1 && d <= 31) return `${y}-${pad(RU_MONTHS[key]!)}-${pad(d)}`;
  }
  // "January 1 2025" / "January 1, 2025" / "1 January 2025"
  m = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && EN_MONTHS[m[1]!]) {
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (d >= 1 && d <= 31) return `${y}-${pad(EN_MONTHS[m[1]!]!)}-${pad(d)}`;
  }
  m = /^(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})$/.exec(s);
  if (m && EN_MONTHS[m[2]!]) {
    const d = Number(m[1]);
    const y = Number(m[3]);
    if (d >= 1 && d <= 31) return `${y}-${pad(EN_MONTHS[m[2]!]!)}-${pad(d)}`;
  }
  return null;
}

const HORIZON_RE: readonly (readonly [RegExp, ChangeHorizon])[] = [
  [/за\s+предыдущ[а-яё]*\s+год|за\s+прошл[а-яё]*\s+год|prior\s+year|previous\s+year|год\s+к\s+году|\byoy\b/i, "prior_year"],
  [/с\s+начала\s+(?:20\d\d\s+)?года|с\s+нач[а-яё]*\.?\s*года|year[-\s]?to[-\s]?date|\bytd\b|нарастающ/i, "ytd"],
  [/за\s+(?:послед[а-яё]*\s+)?12\s+месяц[а-яё]*|last\s+12\s+months|за\s+(?:послед[а-яё]*\s+)?год\b/i, "last_12_months"],
  [/за\s+(?:послед[а-яё]*\s+)?месяц[а-яё]*|за\s+1\s+месяц[а-яё]*|last\s+month|past\s+month|over\s+the\s+(?:last\s+)?month|monthly\s+change|\bmom\b/i, "last_month"],
  [/за\s+(?:послед[а-яё]*\s+)?квартал[а-яё]*|last\s+quarter|\bqoq\b/i, "last_quarter"],
];

/** "с начала 2025 года" → the YTD horizon, but only when the year is present. */
function ytdYear(text: string): number | null {
  const m = /с\s+начала\s+(20\d\d)\s+года|с\s+нач[а-яё]*\.?\s*(20\d\d)/i.exec(text);
  return m ? Number(m[1] ?? m[2]) : null;
}

const SAME_PERIOD_RE =
  /за\s+(?:этот|тот)\s+же\s+период|(?:в|за)\s+(?:этот|тот)\s+же\s+интервал|(?:в|за)\s+этот\s+период|тот\s+же\s+период|между\s+ними|в\s+тот\s+же\s+момент|same\s+period|that\s+(?:same\s+)?period|between\s+them|during\s+that\s+(?:same\s+)?(?:period|interval)/i;

const INTERVAL_RE =
  /(?:между|с)\s+(.+?)\s+(?:и|по|по\s+состоянию\s+на|and|to|through|–|—|-)\s+(.+?)[.?!]*$|(?:на|as\s+of|at)\s+(.+?)\s+(?:и|and)\s+(.+?)[.?!]*$|from\s+(.+?)\s+to\s+(.+?)[.?!]*$/i;

export type PeriodResolution =
  | { readonly kind: "none" }
  | { readonly kind: "point"; readonly period: CanonicalPeriod }
  | { readonly kind: "horizon"; readonly period: CanonicalPeriod }
  | { readonly kind: "interval"; readonly interval: ResolvedInterval; readonly inherited: boolean }
  | { readonly kind: "unresolved"; readonly requested: string; readonly detail: string }
  | { readonly kind: "ambiguous"; readonly requested: string; readonly candidates: readonly string[] };

/** A remembered interval carried across turns (§11/§12). */
export interface InheritedPeriod {
  readonly start: CanonicalPeriod;
  readonly end: CanonicalPeriod;
}

function matchPoint(index: PeriodIndex, iso: string): PeriodResolution {
  const hit = index.points.find((p) => p.canonical === iso);
  if (hit) return { kind: "point", period: hit };
  return {
    kind: "unresolved",
    requested: iso,
    detail: `the table has no period ${iso}`,
  };
}

function matchYear(index: PeriodIndex, year: number): PeriodResolution {
  const yr = String(year);
  const exact = index.points.find((p) => p.kind === "year" && p.canonical === yr);
  if (exact) return { kind: "point", period: exact };
  const inYear = index.points.filter((p) => p.kind === "point" && p.canonical.startsWith(`${yr}-`));
  if (inYear.length === 1) return { kind: "point", period: inYear[0]! };
  if (inYear.length > 1) {
    return { kind: "ambiguous", requested: yr, candidates: inYear.map((p) => p.headerPath) };
  }
  return { kind: "unresolved", requested: yr, detail: `the table has no period for ${yr}` };
}

/**
 * Resolves a period phrase. `inherited` supplies the last remembered interval
 * for "за этот же период". Never substitutes a different date for a requested
 * one — a miss returns `unresolved`.
 */
export function resolvePeriod(
  text: string,
  index: PeriodIndex,
  inherited?: InheritedPeriod,
): PeriodResolution {
  const t = text.trim();

  // 1 — "за этот же период" → inherit exactly.
  if (SAME_PERIOD_RE.test(t)) {
    if (inherited) {
      return { kind: "interval", interval: { start: inherited.start, end: inherited.end }, inherited: true };
    }
    return { kind: "unresolved", requested: t, detail: "no earlier period to reuse" };
  }

  // 2 — an explicit interval.
  const im = INTERVAL_RE.exec(t);
  if (im) {
    const rawStart = (im[1] ?? im[3] ?? im[5] ?? "").trim();
    const rawEnd = (im[2] ?? im[4] ?? im[6] ?? "").trim();
    const sIso = normalizeDateText(rawStart) ?? yearToken(rawStart);
    const eIso = normalizeDateText(rawEnd) ?? yearToken(rawEnd);
    if (!sIso || !eIso) {
      return { kind: "unresolved", requested: `${rawStart} … ${rawEnd}`, detail: "one of the interval endpoints is not a date" };
    }
    const sRes = /^\d{4}$/.test(sIso) ? matchYear(index, Number(sIso)) : matchPoint(index, sIso);
    const eRes = /^\d{4}$/.test(eIso) ? matchYear(index, Number(eIso)) : matchPoint(index, eIso);
    if (sRes.kind === "unresolved") return sRes;
    if (eRes.kind === "unresolved") return eRes;
    if (sRes.kind === "ambiguous") return sRes;
    if (eRes.kind === "ambiguous") return eRes;
    if (sRes.kind === "point" && eRes.kind === "point") {
      return { kind: "interval", interval: { start: sRes.period, end: eRes.period }, inherited: false };
    }
    return { kind: "unresolved", requested: t, detail: "interval endpoints did not resolve" };
  }

  // 3 — a relative change horizon.
  const ytd = ytdYear(t);
  for (const [re, horizon] of HORIZON_RE) {
    if (!re.test(t)) continue;
    const target: ChangeHorizon = ytd !== null ? "ytd" : horizon;
    const hit = index.horizons.find((h) => h.horizon === target);
    if (hit) return { kind: "horizon", period: hit };
    return {
      kind: "unresolved",
      requested: t,
      detail: `the table has no precomputed "${target}" change column`,
    };
  }

  // 4 — a single explicit date.
  const iso = normalizeDateText(t) ?? firstDateInside(t);
  if (iso) return matchPoint(index, iso);

  // 5 — a bare year.
  const yr = yearToken(t);
  if (yr) return matchYear(index, Number(yr));

  return { kind: "none" };
}

function yearToken(text: string): string | null {
  const m = /(?:^|\s)((?:19|20)\d{2})(?:\s|$|\s+год)/.exec(text.trim());
  return m ? m[1]! : null;
}

function firstDateInside(text: string): string | null {
  const m = /(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})/.exec(text);
  return m ? normalizeDateText(m[1]!) : null;
}
