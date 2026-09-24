/** A parsed "N <entities> with worst/best <metric>" request (pre-column-resolution). */
export interface GroupedRankingRequest {
  readonly n: number;
  /** The raw noun after N ("менеджеров" / "regions"). */
  readonly entityNoun: string;
  /** The raw metric phrase after the superlative ("Variance" / "средним Variance"). */
  readonly metricPhrase: string;
  /** asc = worst / lowest / smallest; desc = best / highest / largest. */
  readonly direction: "asc" | "desc";
}

export type GroupedRankingPlan =
  | {
      readonly kind: "plan";
      readonly entityColumn: string;
      readonly metricColumn: string;
      readonly aggregation: "mean";
      readonly direction: "asc" | "desc";
      readonly n: number;
    }
  | { readonly kind: "ambiguous_entity"; readonly noun: string; readonly candidates: readonly string[] }
  | { readonly kind: "unknown_entity"; readonly noun: string }
  | { readonly kind: "unknown_metric"; readonly phrase: string };

// --- direction words ----------------------------------------------------

const ASC_WORD =
  /^(?:worst|lowest|smallest|weakest|poorest|least|bottom|худш|наименьш|наихудш|минимальн|низк|наимень|меньш|мал|слаб)/i;
const DESC_WORD =
  /^(?:best|highest|largest|biggest|strongest|most|top|лучш|наибольш|наилучш|максимальн|высок|наибол|больш|сильн)/i;

const SUPERLATIVE =
  "(?:worst|lowest|smallest|weakest|poorest|least|biggest|best|highest|largest|strongest|most|top|bottom" +
  "|худш[а-яё]*|лучш[а-яё]*|наименьш[а-яё]*|наибольш[а-яё]*|наихудш[а-яё]*|наилучш[а-яё]*|минимальн[а-яё]*" +
  "|максимальн[а-яё]*|низк[а-яё]*|высок[а-яё]*|наибол[а-яё]*|больш[а-яё]*|мал[а-яё]*|меньш[а-яё]*|слаб[а-яё]*|сильн[а-яё]*)";

// RU: "3 менеджеров с [самым] худшим Variance"
const RU_RE = new RegExp(
  `(?:^|\\s)(\\d{1,3})\\s+([а-яё]+)\\s+с\\s+(?:(?:самой|самым|самое|самого|наиболее|наименее)\\s+)?(${SUPERLATIVE})\\s+([A-Za-zА-Яа-яё][A-Za-zА-Яа-яё0-9 %]*?)\\s*[.!?]*\\s*$`,
  "iu",
);
// EN: "3 managers with the worst Variance"
const EN_RE = new RegExp(
  `(?:^|\\s)(\\d{1,3})\\s+([A-Za-z]+)\\s+(?:with|by|having|that\\s+have)\\s+(?:the\\s+)?(${SUPERLATIVE})\\s+([A-Za-z][A-Za-z0-9 %]*?)\\s*[.!?]*\\s*$`,
  "iu",
);

const MAX_N = 50;

/** Reads a grouped-ranking request from the message, or null when it is not one. */
export function detectGroupedRanking(text: string): GroupedRankingRequest | null {
  const m = RU_RE.exec(text) ?? EN_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const superl = (m[3] ?? "").toLowerCase();
  const direction: "asc" | "desc" = DESC_WORD.test(superl) ? "desc" : ASC_WORD.test(superl) ? "asc" : "asc";
  const metricPhrase = (m[4] ?? "")
    .trim()
    // drop a leading aggregate word — "средним Variance" → "Variance".
    .replace(/^(?:сред[а-яё]*|averag[a-z]*|mean|avg|суммарн[а-яё]*|общ[а-яё]*|итогов[а-яё]*|total)\s+/iu, "")
    .trim();
  if (metricPhrase === "") return null;
  return { n: Math.min(n, MAX_N), entityNoun: (m[2] ?? "").trim(), metricPhrase, direction };
}

// --- column resolution ------------------------------------------------

/** Entity noun → candidate header names (lower-case), EN + RU. */
const ENTITY_KEYS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/^manager|^менедж/i, ["manager"]],
  [/^region|^регион|^област|^район/i, ["region"]],
  [/^categor|^категор/i, ["category"]],
  [/^product|^продукт|^товар|^издели/i, ["product"]],
  [/^date|^дата|^дат[аыеу]|^числ|^день|^дн/i, ["date"]],
  [/^client|^customer|^клиент|^покупател|^заказчик/i, ["client", "customer", "account"]],
  [/^segment|^сегмент/i, ["segment"]],
  [/^channel|^канал/i, ["channel"]],
];

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveEntityColumn(noun: string, headers: readonly string[]): GroupedRankingPlan | { readonly column: string } {
  const nl = norm(noun);
  const keyEntry = ENTITY_KEYS.find(([re]) => re.test(nl));
  const aliases = keyEntry ? keyEntry[1] : [];
  const hit = new Set<string>();
  for (const h of headers) {
    const hl = norm(h);
    if (aliases.some((a) => hl === a || hl.startsWith(a) || (a.length >= 4 && a.startsWith(hl)))) {
      hit.add(h);
      continue;
    }
    // Fuzzy fallback: the noun stem and the header share a >=4-char prefix.
    const stem = nl.replace(/(?:ов|ев|ами|ями|ах|ях|ам|ям|ий|ей|ы|и|а|я|у|ю|е|ой|s|es)$/iu, "");
    if (stem.length >= 4 && (hl.startsWith(stem) || stem.startsWith(hl))) hit.add(h);
  }
  const matched = [...hit];
  if (matched.length === 0) return { kind: "unknown_entity", noun };
  if (matched.length > 1) return { kind: "ambiguous_entity", noun, candidates: matched };
  return { column: matched[0]! };
}

/** Metric phrase → alias base word (for a loose header match). */
const METRIC_KEYS: readonly (readonly [RegExp, string])[] = [
  [/^variance|^отклонени|^дельт|^разниц/i, "variance"],
  [/^revenue|^выручк|^доход|^оборот|^продаж/i, "revenue"],
  [/^fact|^факт/i, "fact"],
  [/^plan|^план/i, "plan"],
  [/^units?|^количеств|^штук|^объ[её]м/i, "units"],
  [/^price|^цен|^стоимост/i, "price"],
  [/^margin|^маржа|^маржинальност/i, "margin"],
];

function resolveMetricColumn(
  phrase: string,
  headers: readonly string[],
  numeric: ReadonlySet<string>,
): GroupedRankingPlan | { readonly column: string } {
  const pl = norm(phrase);
  const numericHeaders = headers.filter((h) => numeric.has(h));
  const byLen = (a: string, b: string): number => a.length - b.length;

  // 1. exact case-insensitive match (numeric preferred).
  const exact = headers.filter((h) => norm(h) === pl);
  const exactNum = exact.filter((h) => numeric.has(h));
  if (exactNum.length > 0) return { column: [...exactNum].sort(byLen)[0]! };
  if (exact.length === 1 && numeric.size === 0) return { column: exact[0]! };

  // 2. alias base word → header whose name equals / starts with the base.
  const key = METRIC_KEYS.find(([re]) => re.test(pl));
  const base = key ? key[1] : pl.split(" ")[0] ?? pl;
  const aliasHits = numericHeaders.filter((h) => {
    const hl = norm(h);
    return hl === base || hl.startsWith(base) || (base.length >= 4 && base.startsWith(hl));
  });
  if (aliasHits.length > 0) return { column: [...aliasHits].sort(byLen)[0]! };

  // 3. substring either way, numeric only.
  const sub = numericHeaders.filter((h) => {
    const hl = norm(h);
    return hl.includes(pl) || pl.includes(hl);
  });
  if (sub.length > 0) return { column: [...sub].sort(byLen)[0]! };

  return { kind: "unknown_metric", phrase };
}

/**
 * Resolves a detected request against the real headers. `numeric` is the set of
 * headers that hold numbers (the metric must be one of them).
 */
export function planGroupedRanking(
  req: GroupedRankingRequest,
  headers: readonly string[],
  numeric: ReadonlySet<string>,
): GroupedRankingPlan {
  const ent = resolveEntityColumn(req.entityNoun, headers);
  if ("kind" in ent) return ent;
  const met = resolveMetricColumn(req.metricPhrase, headers, numeric);
  if ("kind" in met) return met;
  if (ent.column === met.column) return { kind: "unknown_metric", phrase: req.metricPhrase };
  return {
    kind: "plan",
    entityColumn: ent.column,
    metricColumn: met.column,
    aggregation: "mean",
    direction: req.direction,
    n: req.n,
  };
}
