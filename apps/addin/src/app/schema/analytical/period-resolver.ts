// ---------------------------------------------------------------------------
// Lexical date normalisation.
//
// All that survives of the Stage 24.7 PeriodResolver. Resolution itself moved
// to the one V2 owner (`resolvePeriodIntent` over `PeriodIndex`); what is left
// is the part that was never semantic — turning a written date into an ISO
// string. `period.resolve` is its only caller, and it still substitutes
// nothing: a string that is not a date returns null.
// ---------------------------------------------------------------------------

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
