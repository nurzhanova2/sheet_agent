import type { NumberLocale } from "../../analysis/format-number.js";
import { measureWord, type MeasureWord } from "./measure-words.js";
import { valueOf, type FindingValue, type VerifiedFinding } from "./verified-finding.js";

const DIRECTION_WORD: Record<NumberLocale, Record<"up" | "down" | "flat", string>> = {
  ru: { up: "рост", down: "снижение", flat: "без изменений" },
  en: { up: "up", down: "down", flat: "unchanged" },
};

function quoted(subject: string, locale: NumberLocale): string {
  if (subject === "") return locale === "ru" ? "показатель" : "the indicator";
  return locale === "ru" ? `«${subject}»` : `"${subject}"`;
}

/**
 * Which figure leads a change sentence.
 *
 * For an amount, the relative move is the headline and the absolute is the
 * detail. For a percentage-like metric the order inverts: an analyst says
 * "снижение на 0,70 п.п." first, because that is the move, and the relative
 * form is a second reading of the same fact (§53).
 */
function leadAndDetail(finding: VerifiedFinding): { readonly lead: string | null; readonly detail: string | null } {
  const abs = valueOf(finding, "absoluteChange");
  const pct = valueOf(finding, "percentageChange");
  if (abs?.unit.kind === "percent_point_delta") return { lead: abs.text, detail: pct?.text ?? null };
  return { lead: pct?.text ?? abs?.text ?? null, detail: pct ? (abs?.text ?? null) : null };
}

export function periodSpanSentence(finding: VerifiedFinding, locale: NumberLocale): string {
  const from = valueOf(finding, "startValue")?.at ?? "";
  const to = valueOf(finding, "endValue")?.at ?? "";
  if (from === "" || to === "" || from === to) return "";
  return locale === "ru" ? `Период сравнения — с ${from} по ${to}.` : `The comparison runs from ${from} to ${to}.`;
}

function changeStatement(finding: VerifiedFinding, locale: NumberLocale, options: StatementOptions = {}): string {
  const subject = quoted(finding.subject, locale);
  const start = valueOf(finding, "startValue");
  const end = valueOf(finding, "endValue");
  const { lead, detail } = leadAndDetail(finding);
  const when = periodSpanSentence(finding, locale);

  const span =
    start && end
      ? locale === "ru"
        ? `: с ${start.text} до ${end.text}`
        : `: from ${start.text} to ${end.text}`
      : "";

  if (finding.direction === "flat" || lead === null) {
    const head = locale === "ru" ? `${subject} — без изменений${span}.` : `${subject} did not change${span}.`;
    return when === "" ? head : `${head} ${when}`;
  }

  const magnitude = lead.startsWith("+") || lead.startsWith("-") ? lead.slice(1) : lead;
  const inline = options.expand === true || detail === null ? "" : ` (${detail})`;
  const head =
    locale === "ru"
      ? finding.direction === "up"
        ? `Рост ${subject} составил ${magnitude}${span}${inline}.`
        : `Снижение ${subject} составило ${magnitude}${span}${inline}.`
      : finding.direction === "up"
        ? `${subject} rose by ${magnitude}${span}${inline}.`
        : `${subject} fell by ${magnitude}${span}${inline}.`;
  const absolute =
    options.expand !== true || detail === null
      ? ""
      : locale === "ru"
        ? `В абсолютном выражении изменение составило ${detail}.`
        : `In absolute terms the change was ${detail}.`;
  return [head, absolute, when].filter((s) => s !== "").join(" ");
}

function periodOf(finding: VerifiedFinding, role: "startValue" | "endValue"): string {
  return valueOf(finding, role)?.at ?? "";
}

function eventStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  const from = periodOf(finding, "startValue");
  const to = periodOf(finding, "endValue");
  const base = changeStatement(finding, locale);
  if (from === "" || to === "") return base;
  const when = locale === "ru" ? `Сильнее всего — между ${from} и ${to}. ` : `The sharpest move came between ${from} and ${to}. `;
  return `${when}${base}`;
}

function valueStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  const value = valueOf(finding, "value");
  if (!value) return "";
  const subject = quoted(finding.subject, locale);
  if (!value.at) return locale === "ru" ? `${subject} — ${value.text}.` : `${subject} is ${value.text}.`;
  return locale === "ru" ? `${subject} на ${value.at} — ${value.text}.` : `${subject} at ${value.at} is ${value.text}.`;
}

function trendStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  const start = valueOf(finding, "startValue");
  const end = valueOf(finding, "endValue");
  const lo = valueOf(finding, "min");
  const hi = valueOf(finding, "max");
  const subject = quoted(finding.subject, locale);
  const dir = finding.direction === "up" ? DIRECTION_WORD[locale].up : finding.direction === "down" ? DIRECTION_WORD[locale].down : DIRECTION_WORD[locale].flat;

  if (start && end) {
    const range =
      lo && hi
        ? locale === "ru"
          ? ` Минимум — ${lo.text} (${lo.at}), максимум — ${hi.text} (${hi.at}).`
          : ` Low ${lo.text} (${lo.at}), high ${hi.text} (${hi.at}).`
        : "";
    const head = locale === "ru" ? `${subject}: ${dir} с ${start.text} (${start.at}) до ${end.text} (${end.at}).` : `${subject}: ${dir} from ${start.text} (${start.at}) to ${end.text} (${end.at}).`;
    return `${head}${range}`;
  }
  const periods = valueOf(finding, "periods");
  const over = periods ? (locale === "ru" ? ` на ${periods.text} периодах` : ` over ${periods.text} periods`) : "";
  return locale === "ru" ? `${subject}: ${dir}${over}.` : `${subject}: ${dir}${over}.`;
}

function volatilityStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  const score = finding.values[0];
  const rank = finding.materiality.find((s) => s.kind === "rank");
  const subject = quoted(finding.subject, locale);
  const steadiest = finding.findingType === "stability";
  const measure = steadiest
    ? locale === "ru"
      ? "оценка разброса"
      : "the spread score"
    : locale === "ru"
      ? "оценка волатильности"
      : "the volatility score";
  // §51 — the score is meaningless on its own, so it is stated as a POSITION
  // among its peers and only then as a number.
  if (rank && rank.kind === "rank" && rank.position === 1) {
    const head = steadiest
      ? locale === "ru"
        ? `Самый ровный показатель — ${subject}.`
        : `The steadiest indicator is ${subject}.`
      : locale === "ru"
        ? `Самый волатильный показатель — ${subject}.`
        : `The most volatile indicator is ${subject}.`;
    if (!score) return head;
    const extreme = steadiest
      ? locale === "ru"
        ? "наименьшее значение среди сравниваемых показателей"
        : "the lowest of the indicators compared"
      : locale === "ru"
        ? "максимальное значение среди сравниваемых показателей"
        : "the highest of the indicators compared";
    return locale === "ru"
      ? `${head} По используемой метрике его ${measure} — ${score.text}: это ${extreme}.`
      : `${head} On the measure used, ${measure} is ${score.text} — ${extreme}.`;
  }
  if (!score) return "";
  return locale === "ru" ? `У ${subject} ${measure} — ${score.text}.` : `For ${subject}, ${measure} is ${score.text}.`;
}

function monotonicityStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  const run = valueOf(finding, "runLength");
  const periods = valueOf(finding, "periods");
  const subject = quoted(finding.subject, locale);
  if (!run || run.value <= 0) return locale === "ru" ? `${subject}: непрерывного движения в одну сторону нет.` : `${subject}: no sustained run in one direction.`;
  const dir = finding.direction === "up" ? (locale === "ru" ? "роста" : "of growth") : locale === "ru" ? "снижения" : "of decline";
  const outOf = periods ? (locale === "ru" ? ` из ${periods.text}` : ` of ${periods.text}`) : "";
  return locale === "ru" ? `${subject}: ${run.text}${outOf} периодов подряд ${dir}.` : `${subject}: ${run.text}${outOf} consecutive periods ${dir}.`;
}

function reversalStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  const count = valueOf(finding, "directionChangeCount");
  const subject = quoted(finding.subject, locale);
  if (!count) return "";
  if (count.value === 0) return locale === "ru" ? `${subject}: направление не менялось.` : `${subject}: direction never reversed.`;
  return locale === "ru" ? `${subject}: направление менялось ${count.text} раз.` : `${subject}: direction reversed ${count.text} times.`;
}

function rankingStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  const named = (finding.detail?.["named"] as readonly string[] | undefined) ?? finding.counterparts ?? [];
  const setSize = finding.detail?.["setSize"];
  if (named.length === 0) return "";
  const list = named.map((n) => quoted(n, locale)).join(", ");
  if (typeof setSize === "number" && setSize > named.length) {
    return locale === "ru" ? `Всего показателей: ${setSize}; в ответе названы ${list}.` : `${setSize} indicators in total; named here: ${list}.`;
  }
  return locale === "ru" ? `Порядок: ${list}.` : `Order: ${list}.`;
}

function extremumStatement(finding: VerifiedFinding, locale: NumberLocale, options: StatementOptions = {}): string {
  const change = valueOf(finding, "percentageChange") ?? valueOf(finding, "absoluteChange");
  const value = valueOf(finding, "value");
  const subject = quoted(finding.subject, locale);
  if (change) return changeStatement(finding, locale, options);
  if (value) return locale === "ru" ? `Наибольшее значение — у ${subject}: ${value.text}.` : `The largest value is ${subject}: ${value.text}.`;
  return locale === "ru" ? `Подходит ${subject}.` : `That is ${subject}.`;
}

/**
 * §77 — a short, natural description of the table: what it holds, how wide it
 * is in subjects and in time. Deliberately a sentence and not a spec sheet.
 */
function overviewStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  const metrics = valueOf(finding, "metricCount");
  const periods = valueOf(finding, "periodCount");
  const names = (finding.detail?.["metricNames"] as readonly string[] | undefined) ?? [];
  const sheet = finding.subject;
  const head = locale === "ru"
    ? sheet !== "" ? `Лист «${sheet}»` : "Таблица"
    : sheet !== "" ? `Sheet "${sheet}"` : "The table";
  const size =
    metrics && periods
      ? locale === "ru"
        ? `: ${metrics.text} показателей по ${periods.text} периодам`
        : `: ${metrics.text} indicators across ${periods.text} periods`
      : "";
  const sample =
    names.length > 0
      ? locale === "ru"
        ? `. Среди них ${names.slice(0, 4).map((n) => `«${n}»`).join(", ")}`
        : `. Among them ${names.slice(0, 4).map((n) => `"${n}"`).join(", ")}`
      : "";
  return `${head}${size}${sample}.`;
}

/**
 * Stage 27 §40 — a segment, described by what is IN it.
 *
 * A cluster label on its own ("segment 1") tells a reader nothing, so the
 * sentence leads with its members and size. The profile numbers follow only
 * when the analysis produced some: an unexplained centroid coordinate is the
 * unexplained score §51 rules out.
 */
function clusterStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  const members = (finding.detail?.["members"] as readonly string[] | undefined) ?? [];
  const size = valueOf(finding, "clusterSize");
  const subject = finding.subject === "" ? (locale === "ru" ? "Группа" : "A group") : quoted(finding.subject, locale);
  const named = members.slice(0, 4).map((m) => quoted(m, locale)).join(", ");
  const rest = members.length > 4 ? (locale === "ru" ? ` и ещё ${members.length - 4}` : ` and ${members.length - 4} more`) : "";
  const count = size ? size.text : String(members.length);
  if (members.length === 0) return locale === "ru" ? `${subject}: ${count} показателей.` : `${subject}: ${count} indicators.`;
  return locale === "ru" ? `${subject} — ${count}: ${named}${rest}.` : `${subject} — ${count}: ${named}${rest}.`;
}

// --- Stage 27 §36/§37/§58: the exploration templates -----------------------

/**
 * The first value the sentence can actually name, and its phrase.
 *
 * Skips measures this system has no word for, rather than printing their keys
 * (§43). A finding whose every value is unrecognised falls back to stating the
 * number alone — thin, but it never puts `iqr_robust_v2` in front of a reader.
 */
function namedValue(finding: VerifiedFinding, prefer: readonly string[], locale: NumberLocale): { value: FindingValue; word: MeasureWord } | null {
  const ordered = [...prefer.map((n) => valueOf(finding, n)).filter((v): v is FindingValue => v !== undefined), ...finding.values];
  for (const value of ordered) {
    const word = measureWord(value.name, locale);
    if (word) return { value, word };
  }
  return null;
}

/** A measure reported as zero, meaning the dimension found nothing. */
function foundNothing(finding: VerifiedFinding): boolean {
  if (finding.values.length === 0) return true;
  return finding.subject === "" && finding.values.every((v) => v.value === 0);
}

/**
 * §37 — completeness.
 *
 * "Пропусков нет" is stated, never left to silence: a dimension that was
 * checked and came back clean is information, and omitting it is
 * indistinguishable from not having looked (§23/§25).
 */
function dataQualityStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  if (foundNothing(finding)) {
    return locale === "ru" ? "Пропусков и повторов в данных нет." : "There are no gaps or duplicates in the data.";
  }
  const subject = quoted(finding.subject, locale);
  const named = namedValue(finding, ["missingCount", "duplicateCount", "share"], locale);
  if (!named) {
    return locale === "ru" ? `${subject} — есть замечания к заполнению.` : `${subject} — there are problems with how it is filled in.`;
  }
  const { value, word } = named;
  if (word.needsNoun) return `${subject}: ${word.noun} — ${value.text}.`;
  return `${subject}: ${value.text} ${word.noun}.`;
}

/**
 * §37/§49 — something stands apart.
 *
 * "Выделяется" and never "выброс, который надо убрать": the table shows
 * that a value is far from the others and shows nothing about whether it is an
 * error, a real event, or the most important row in the sheet.
 */
function anomalyStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  if (foundNothing(finding)) {
    return locale === "ru" ? "Значений, резко выпадающих из общей картины, нет." : "Nothing falls far outside the general picture.";
  }
  const subject = quoted(finding.subject, locale);
  const named = namedValue(finding, ["zScore", "iqrDistance", "madDistance", "distance"], locale);
  if (!named) {
    return locale === "ru" ? `${subject} заметно отличается от остальных.` : `${subject} is noticeably unlike the rest.`;
  }
  const { value, word } = named;
  return locale === "ru"
    ? `${subject} заметно отличается от остальных: ${word.noun} — ${value.text}.`
    : `${subject} stands apart from the rest: ${word.noun} — ${value.text}.`;
}

/**
 * §37/§49/§94 — two indicators move together.
 *
 * The sentence is built so that no wording of it can become a cause.
 * "Движутся вместе" describes the shape of two columns; "влияет на"
 * describes a mechanism the table does not contain. The §56 verifier would
 * reject the second anyway — but a template that produced it would be
 * generating the very text the verifier exists to catch.
 */
function relationshipStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  if (foundNothing(finding)) {
    return locale === "ru" ? "Заметных связей между показателями не видно." : "No notable relationships between the indicators are visible.";
  }
  const pair =
    finding.counterparts && finding.counterparts.length > 0
      ? `${quoted(finding.subject, locale)} ${locale === "ru" ? "и" : "and"} ${quoted(finding.counterparts[0]!, locale)}`
      : quoted(finding.subject, locale);
  const named = namedValue(finding, ["correlation", "pearson", "spearman", "r"], locale);
  if (!named) return locale === "ru" ? `${pair} меняются согласованно.` : `${pair} move in step.`;
  const { value, word } = named;
  const together =
    value.value < 0
      ? locale === "ru"
        ? "меняются в противоположных направлениях"
        : "move in opposite directions"
      : locale === "ru"
        ? "меняются в одну сторону"
        : "move in the same direction";
  const strength =
    Math.abs(value.value) < 0.3
      ? locale === "ru"
        ? "слабо "
        : "weakly "
      : Math.abs(value.value) > 0.8
        ? locale === "ru"
          ? "устойчиво "
          : "consistently "
        : "";
  return locale === "ru"
    ? `${pair} ${strength}${together} — ${word.noun} ${value.text}. Это совпадение в данных, а не установленная зависимость.`
    : `${pair} ${strength}${together} — ${word.noun} ${value.text}. That is a co-movement in the data, not an established dependency.`;
}

/** §37 — the shape of the values, described rather than classified. */
function distributionStatement(finding: VerifiedFinding, locale: NumberLocale): string {
  if (foundNothing(finding)) {
    return locale === "ru" ? "Распределение значений ничем не выделяется." : "The distribution of the values is unremarkable.";
  }
  const subject = quoted(finding.subject, locale);
  const skew = valueOf(finding, "skewness");
  const named = namedValue(finding, ["median", "iqr", "range", "std"], locale);
  const tail = named === null ? "" : ` (${named.word.noun} — ${named.value.text})`;
  if (skew && Math.abs(skew.value) >= 0.5) {
    const side =
      skew.value > 0
        ? locale === "ru"
          ? "в сторону больших значений"
          : "towards the larger values"
        : locale === "ru"
          ? "в сторону меньших значений"
          : "towards the smaller values";
    return locale === "ru" ? `Значения ${subject} смещены ${side}${tail}.` : `The values of ${subject} are skewed ${side}${tail}.`;
  }
  return locale === "ru" ? `Значения ${subject} распределены довольно ровно${tail}.` : `The values of ${subject} are spread fairly evenly${tail}.`;
}

function emptySetStatement(locale: NumberLocale): string {
  // Stage 26.3 §16 — "nothing matched" is an analytical answer, not a failure.
  return locale === "ru" ? "Ни один показатель не удовлетворяет заданному условию." : "No indicator matches that condition.";
}

/**
 * §58 — the deterministic sentence for one finding.
 *
 * Total over `FindingType`: a type with no template would reach the user as a
 * raw table, which is the thing §43 forbids, so the switch has no default that
 * silently returns "".
 */
export interface StatementOptions {
  readonly expand?: boolean;
}

export function statementFor(finding: VerifiedFinding, locale: NumberLocale, options: StatementOptions = {}): string {
  switch (finding.findingType) {
    case "change":
      return changeStatement(finding, locale, options);
    case "event":
      return eventStatement(finding, locale);
    case "value":
      return valueStatement(finding, locale);
    case "trend":
      return trendStatement(finding, locale);
    case "volatility":
    case "stability":
      return volatilityStatement(finding, locale);
    case "monotonicity":
      return monotonicityStatement(finding, locale);
    case "direction_change":
      return reversalStatement(finding, locale);
    case "ranking":
      return rankingStatement(finding, locale);
    case "extremum":
      return extremumStatement(finding, locale, options);
    case "empty_set":
      return emptySetStatement(locale);
    case "table_overview":
      return overviewStatement(finding, locale);
    case "comparison":
      return changeStatement(finding, locale, options);
    case "cluster":
      return clusterStatement(finding, locale);
    case "data_quality":
      return dataQualityStatement(finding, locale);
    case "anomaly":
      return anomalyStatement(finding, locale);
    case "relationship":
      return relationshipStatement(finding, locale);
    case "distribution":
      return distributionStatement(finding, locale);
  }
}
