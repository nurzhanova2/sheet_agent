import type { FindingType } from "../insight/verified-finding.js";
import type { SandboxResult } from "./types.js";

/** §37 — the dimensions an exploration may look along. */
export type ExplorationDimension =
  | "data_quality"
  | "changes"
  | "trends"
  | "volatility"
  | "anomalies"
  | "relationships"
  | "distributions"
  | "unusual_entities";

export const EXPLORATION_DIMENSIONS: readonly ExplorationDimension[] = [
  "data_quality",
  "changes",
  "trends",
  "volatility",
  "anomalies",
  "relationships",
  "distributions",
  "unusual_entities",
];

const DIMENSION_SET: ReadonlySet<string> = new Set<string>(EXPLORATION_DIMENSIONS);

/** §38 — how far an exploration may go. */
export const EXPLORATION_BOUNDS = {
  /** Below this the exploration is thin, but it is not refused. */
  suggestedMin: 3,
  /** Above this it is refused: §38's "do not run arbitrary endless exploration". */
  max: 4,
} as const;

const DIMENSION_ALIASES: Readonly<Record<string, ExplorationDimension>> = {
  structure: "data_quality",
  quality: "data_quality",
  missing: "data_quality",
  completeness: "data_quality",
  change: "changes",
  major_changes: "changes",
  growth: "changes",
  trend: "trends",
  direction: "trends",
  variability: "volatility",
  instability: "volatility",
  anomaly: "anomalies",
  outliers: "anomalies",
  correlation: "relationships",
  relationship: "relationships",
  distribution: "distributions",
  spread: "distributions",
  unusual: "unusual_entities",
  outlier_entities: "unusual_entities",
};

export function readDimension(value: unknown): ExplorationDimension | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (DIMENSION_SET.has(key)) return key as ExplorationDimension;
  return DIMENSION_ALIASES[key] ?? null;
}

/**
 * §37/§58 — which kind of observation a dimension produces.
 *
 * Every one of these already has a narration template, because the insight
 * layer's `FindingType` vocabulary was written from the same list of things a
 * table can show. Exploration therefore adds no new way of SAYING anything —
 * it adds new ways of finding something to say, which is the right split.
 */
export function dimensionFindingType(dimension: ExplorationDimension): FindingType {
  switch (dimension) {
    case "data_quality":
      return "data_quality";
    case "changes":
      return "change";
    case "trends":
      return "trend";
    case "volatility":
      return "volatility";
    case "anomalies":
    case "unusual_entities":
      return "anomaly";
    case "relationships":
      return "relationship";
    case "distributions":
      return "distribution";
  }
}

/** §37 — the dimension in words, for the trace and for "что я проверил". */
export function dimensionLabel(dimension: ExplorationDimension, locale: "ru" | "en"): string {
  const ru: Record<ExplorationDimension, string> = {
    data_quality: "полнота и качество данных",
    changes: "заметные изменения",
    trends: "направление динамики",
    volatility: "нестабильность",
    anomalies: "аномальные значения",
    relationships: "связи между показателями",
    distributions: "форма распределения",
    unusual_entities: "выделяющиеся объекты",
  };
  const en: Record<ExplorationDimension, string> = {
    data_quality: "completeness and data quality",
    changes: "notable changes",
    trends: "direction of movement",
    volatility: "instability",
    anomalies: "anomalous values",
    relationships: "relationships between indicators",
    distributions: "the shape of the distribution",
    unusual_entities: "entities that stand apart",
  };
  return locale === "ru" ? ru[dimension] : en[dimension];
}

/**
 * §14/§37 — what the generated code should actually DO for a dimension.
 *
 * Concrete enough to produce comparable numbers, loose enough not to become
 * the benchmark-specific script §98 rules out: these say what to measure, not
 * which library call to make or what counts as a notable result. The value
 * NAMES are prescribed where the insight layer already knows how to read them
 * (`absoluteChange` and friends), because a change reported under a name
 * nothing recognises narrates as a bare number.
 */
export function dimensionBrief(dimension: ExplorationDimension): string {
  switch (dimension) {
    case "data_quality":
      return 'empty cells, constant columns and duplicated rows. One finding per affected column: values {"missingCount": n, "share": 0..1}. Say so explicitly when nothing is missing.';
    case "changes":
      return 'movement from the first period to the last, per entity. Values MUST be named {"startValue","endValue","absoluteChange","percentageChange"} — percentageChange as a fraction, and omitted when the start is zero.';
    case "trends":
      return 'direction over the whole span, per entity: values {"slope": float, "rSquared": 0..1}. Report the sign of the slope, not a forecast.';
    case "volatility":
      return 'how unsteady each entity is: values {"coefficientOfVariation": float} or {"standardDeviation": float}, plus the mean it is relative to.';
    case "anomalies":
      return 'observations far from the rest: values {"zScore": float} or {"iqrDistance": float} with the value itself. State the rule you used in the finding\'s values, not in words.';
    case "relationships":
      return 'pairwise association between numeric indicators: values {"correlation": -1..1, "n": int}. Report the pair as the subject. Do NOT call it cause.';
    case "distributions":
      return 'shape per numeric indicator: values {"skewness": float, "median": float, "iqr": float}. Note concentration, not normality verdicts.';
    case "unusual_entities":
      return 'entities whose overall profile is unlike the rest: values {"distance": float} from the typical profile, with the feature that separates them.';
  }
}

/**
 * §29/§37 — did the exploration look where it said it would?
 *
 * A dimension that produced nothing is not acceptable as silence. The contract
 * asks for a finding per dimension EVEN WHEN NOTHING WAS FOUND, so that
 * "пропусков нет" is a statement the analysis made rather than a gap the
 * reader has to infer from its absence. That is the same instinct as §25: an
 * empty result and an unexamined one look identical once they reach prose, and
 * only one of them is an answer.
 */
export function validateExplorationCoverage(dimensions: readonly ExplorationDimension[], result: SandboxResult): readonly string[] {
  if (dimensions.length === 0) return [];
  const covered = new Set<ExplorationDimension>();
  for (const candidate of result.findingsCandidates) {
    const dimension = readDimension(candidate.kind);
    if (dimension) covered.add(dimension);
  }
  const missing = dimensions.filter((d) => !covered.has(d));
  if (missing.length === 0) return [];
  return [
    `the exploration was asked to cover ${dimensions.join(", ")} but returned no findings for ${missing.join(", ")}; ` +
      'add one entry to RESULT["findings"] per dimension with "kind" set to the dimension name — including when there was nothing to report',
  ];
}
