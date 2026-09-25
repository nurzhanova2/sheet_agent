export type CapabilityId =
  | "schema"
  | "periods"
  | "read_values"
  | "series"
  | "comparison"
  | "ranking"
  | "extrema"
  | "statistics"
  | "references"
  | "sandbox"
  | "visualization"
  | "mutation";

export const CAPABILITY_IDS: readonly CapabilityId[] = [
  "schema",
  "periods",
  "read_values",
  "series",
  "comparison",
  "ranking",
  "extrema",
  "statistics",
  "references",
  "sandbox",
  "visualization",
  "mutation",
];

export interface ReferenceFacts {
  readonly result: boolean;
  readonly recent: boolean;
  readonly metric: boolean;
  readonly metricSet: boolean;
  readonly period: boolean;
  readonly periodRange: boolean;
  readonly series: boolean;
  readonly event: boolean;
  readonly analysis: boolean;
}

export const NO_REFERENCES: ReferenceFacts = {
  result: false,
  recent: false,
  metric: false,
  metricSet: false,
  period: false,
  periodRange: false,
  series: false,
  event: false,
  analysis: false,
};

export interface CapabilityFacts {
  readonly metricCount: number;
  readonly periodCount: number;
  readonly resultCount: number;
  readonly references: ReferenceFacts;
  readonly sandbox: boolean;
  readonly toolInvoker: boolean;
  readonly mutationGateway: boolean;
  readonly visualization: boolean;
}

export const CAPABILITY_PURPOSE: Readonly<Record<CapabilityId, string>> = {
  schema: "inspect the table structure and resolve metric labels",
  periods: "list and resolve the periods this table carries",
  read_values: "read one metric's value at one period",
  series: "retrieve a metric's values across periods",
  comparison: "compare two periods, compute change, derive or join columns",
  ranking: "filter, sort and take the top or bottom rows of an earlier result",
  extrema: "find the largest or smallest value, and the biggest move between adjacent periods",
  statistics: "deterministic summaries: totals, averages, spread, trend, volatility, monotonicity",
  references: "reuse a verified result, metric, period or series from earlier in this conversation",
  sandbox: "execute custom read-only Python for analysis no deterministic tool performs",
  visualization: "render a chart from a result",
  mutation: "change the workbook",
};

export interface ToolDescriptor {
  readonly id: string;
  readonly capability: CapabilityId;
  readonly shortDescription: string;
  readonly inputSummary: string;
  readonly outputSummary: string;
}

const SENTENCE_END = /^(.*?[.!?])(?:\s|$)/u;

export function shortDescriptionOf(description: string): string {
  const trimmed = description.trim();
  const first = SENTENCE_END.exec(trimmed);
  const head = (first?.[1] ?? trimmed).trim();
  return head.length > 160 ? `${head.slice(0, 157)}...` : head;
}
