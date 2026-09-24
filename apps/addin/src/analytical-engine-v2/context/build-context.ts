import { isPercentNumberFormat } from "../../app/schema/excel-date.js";
import { classifySemanticMetricClass } from "../../app/schema/measure-compatibility.js";
import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import type { PeriodIndex } from "../../app/schema/analytical/period-index.js";
import type { AnalyticalConversationState } from "../state/conversation-state.js";
import { V2_TOOLS } from "../tools/registry.js";
import { capabilityFactsOf } from "../capability/capability-availability.js";
import { selectCapabilities } from "../capability/capability-selection.js";
import { buildToolContext } from "../capability/tool-context.js";

const MAX_METRICS_SHOWN = 60;
const MAX_PERIODS_SHOWN = 30;

export interface EngineContext {
  readonly tableBlock: string;
  readonly metricsBlock: string;
  readonly stateBlock: string;
  readonly toolCatalog: string;
}

/** §6 — TableSchemaContext: shape and confidence, never values. */
function buildTableBlock(schema: TableSchema, periodIndex: PeriodIndex): string {
  const points = [...periodIndex.points].sort((a, b) => b.orderKey - a.orderKey);
  const shown = points.slice(0, MAX_PERIODS_SHOWN);
  const lines = [
    `sheet: ${schema.sheetName}`,
    `range: ${schema.sourceRange}`,
    `orientation: ${schema.orientation}`,
    `metrics: ${schema.rowAxis.length}`,
    `schemaConfidence: ${schema.confidence.toFixed(2)}`,
    `periods (${points.length} total, showing ${shown.length}, newest first):`,
    `current comparison is selected only by periodIntent {kind:"latest_vs_previous"}; the resolver uses the latest period and its immediately previous comparable period.`,
    ...shown.map((p) => `  - ${p.canonical} (${p.headerPath})`),
  ];
  return lines.join("\n");
}

/** §6/§28/§45 — metric labels with their semantic class, fenced as untrusted. */
function buildMetricsBlock(schema: TableSchema, grids: AnalysisGrids, periodIndex: PeriodIndex): string {
  const shown = schema.rowAxis.slice(0, MAX_METRICS_SHOWN);
  const lines = shown.map((m) => {
    const percentFormatted = periodIndex.points.some((p) => p.colIndex >= 0 && isPercentNumberFormat(grids.numberFormats[m.rowIndex]?.[p.colIndex] ?? null));
    return `  - "${m.display}" (${classifySemanticMetricClass(m.display, { percentFormatted })})`;
  });
  const more = schema.rowAxis.length - shown.length;
  return [...lines, ...(more > 0 ? [`  … ${more} more`] : [])].join("\n");
}

/**
 * §6/§7/§8/§9 — the ONE conversation state, as named typed references.
 *
 * DESCRIPTORS ONLY. What each slot IS, what it is about, and which tool reads
 * it — never the rows themselves. Dumping a previous result's table here would
 * both blow up the prompt and invite the planner to read values off it instead
 * of calling the tool that computes them (§8).
 *
 * Which slot a pronoun means is NOT decided here (§12). These are candidates.
 */
function buildStateBlock(state: AnalyticalConversationState): string {
  const lines: string[] = [];
  if (state.lastResult) {
    const r = state.lastResult;
    lines.push(
      `lastResult: ${r.tool} (${r.type}), ${r.rows.length} row(s), fields [${r.fields.map((f) => f.name).join(", ")}]` +
        `${r.periodCanonicals.length > 0 ? `, periods ${r.periodCanonicals.join(" .. ")}` : ""} — the previous turn's ANSWER; read it with reference.last_result`,
    );
  }
  if (state.lastMetric) lines.push(`lastMetric: "${state.lastMetric.metricKey}" — one metric; read it with reference.last_metric`);
  if (state.lastMetricSet) {
    lines.push(
      `lastMetricSet: ${state.lastMetricSet.metricKeys.length} metric(s) — the candidate set a partitive follow-up narrows further; read it with reference.last_metric_set`,
    );
  }
  if (state.lastPeriod) {
    lines.push(`lastPeriod: ${state.lastPeriod.startCanonical}${state.lastPeriod.endCanonical ? ` .. ${state.lastPeriod.endCanonical}` : ""} — read it with reference.last_period`);
  }
  if (state.lastPeriodRange) {
    lines.push(`lastPeriodRange: ${state.lastPeriodRange.startCanonical} .. ${state.lastPeriodRange.endCanonical} — an interval, not a date; read it with reference.last_period_range`);
  }
  if (state.lastSeries) {
    lines.push(`lastSeries: "${state.lastSeries.metricKey}" over ${state.lastSeries.periodCanonicals.length} period(s) — read it with reference.last_series`);
  }
  if (state.lastEvent) {
    lines.push(
      `lastEvent: "${state.lastEvent.metricKey}" between ${state.lastEvent.startCanonical} and ${state.lastEvent.endCanonical} — read it with reference.last_event; it also names that metric and that interval`,
    );
  }
  if (state.lastAnalysis) {
    const a = state.lastAnalysis;
    const on = [a.rankingField ? `ranked by ${a.rankingField}${a.rankingMagnitude ? " by magnitude" : ""}` : "", a.basis ? `basis ${a.basis}` : ""].filter(Boolean).join(", ");
    lines.push(`lastAnalysis: ${a.tool} → ${a.kind}${on ? ` (${on})` : ""} — read it with reference.last_analysis`);
  }
  // §9 — a BOUNDED, ordered list. A follow-up reaches back a step or two; it
  // never searches an unbounded history, and neither does this block.
  const recent = (state.recentResults ?? []).slice(1);
  if (recent.length > 0) {
    lines.push(
      `earlier this conversation (most recent first; reference.recent n=2,3,… counts down this list, and a "role" argument counts only within that role): ` +
        recent.map((r, i) => `${i + 2}) ${r.tool} (${r.type}, ${r.role ?? "primary"})`).join("; "),
    );
  }
  return lines.length > 0 ? lines.map((l) => `  - ${l}`).join("\n") : "  (nothing yet — this is the first analytical turn)";
}

/**
 * §6 — ToolCatalog: names, argument contracts, one-line purpose.
 *
 * Stage 26.3 §8 — render the ARGUMENT CONTRACT, not the object identity. This
 * previously interpolated the ArgSpec object directly, so every argument of
 * every tool reached the planner as "metric: [object Object]". The declared
 * types, required flags and per-argument descriptions — the whole §6 contract —
 * were never visible to the model, which had to infer argument shapes from the
 * prose description alone. That is the most likely origin of the object-wrapped
 * guesses seen throughout the 26.2L baseline ({"metric":{"inputRef":"result_1"}},
 * {"field":{"name":"slope"}}, {"metrics":"result_2"}).
 *
 * Stage 26.8 §24/§26 — and render it ONCE. The 26.7 measurement put the
 * catalogue at 76% of a ~34,000-character prompt, a third of which was the
 * SAME twenty-one argument contracts restated across fifty tools. Each one is
 * now stated once above the list, and each tool carries a signature rather than
 * a prose argument sentence.
 *
 * This is a serialization change, not a semantic one (§23/§26): every tool,
 * every argument, every type, every required flag, every ref alternative and
 * every description string is still present. `catalogEntries` exposes that as
 * data so the §25 test can assert it rather than pattern-matching prose.
 */
export interface CatalogEntry {
  readonly name: string;
  readonly signature: string;
  readonly returns: string;
  readonly description: string;
  /** Argument contracts stated on this tool's own line. */
  readonly ownArgs: readonly string[];
}

export interface CatalogModel {
  readonly shared: readonly { readonly name: string; readonly type: string; readonly describe: string; readonly uses: number }[];
  readonly entries: readonly CatalogEntry[];
}

const CATALOG_HEADER = [
  "Each tool is written as  name(argument:type, \u2026) \u2192 resultType .  \"!\" marks a REQUIRED argument; every other argument is optional.",
  "Types: string, number, boolean, string[], value (a number or a string), object; resultRef / metricRef / periodRef are all the resultId STRING of an earlier result.",
  "Wherever an argument has both a literal and a \u2026Ref form, pass the Ref form when you already hold that result.",
].join("\n");

/**
 * An argument contract used by more than one tool is stated once, here, instead
 * of once per tool. Keyed by name+type+text, so two tools sharing an argument
 * NAME but not its meaning still each keep their own wording.
 */
function catalogModel(): CatalogModel {
  const uses = new Map<string, { name: string; type: string; describe: string; uses: number }>();
  for (const tool of V2_TOOLS) {
    for (const [name, spec] of Object.entries(tool.args)) {
      const key = `${name}\u0000${spec.type}\u0000${spec.describe}`;
      const entry = uses.get(key) ?? { name, type: spec.type, describe: spec.describe, uses: 0 };
      entry.uses += 1;
      uses.set(key, entry);
    }
  }
  const shared = [...uses.values()].filter((e) => e.uses > 1).sort((a, b) => a.name.localeCompare(b.name));
  const isShared = new Set(shared.map((e) => `${e.name}\u0000${e.type}\u0000${e.describe}`));
  const entries = V2_TOOLS.map((tool) => {
    const args = Object.entries(tool.args);
    return {
      name: tool.name,
      signature: `${tool.name}(${args.map(([n, spec]) => `${n}${spec.required ? "!" : ""}:${spec.type}`).join(", ")})`,
      returns: tool.returns,
      description: tool.description,
      ownArgs: args.filter(([n, spec]) => !isShared.has(`${n}\u0000${spec.type}\u0000${spec.describe}`)).map(([n, spec]) => `${n} \u2014 ${spec.describe}`),
    };
  });
  return { shared, entries };
}

export function buildToolCatalog(): string {
  const model = catalogModel();
  const shared = model.shared.map((e) => `  ${e.name} (${e.type}) \u2014 ${e.describe}`).join("\n");
  const tools = model.entries
    .map((e) => `- ${e.signature} \u2192 ${e.returns}\n  ${e.description}${e.ownArgs.length > 0 ? `\n  ${e.ownArgs.join("; ")}` : ""}`)
    .join("\n");
  return [CATALOG_HEADER, "", "ARGUMENTS THAT MEAN THE SAME IN EVERY TOOL THAT TAKES THEM:", shared, "", tools].join("\n");
}

/** §25 — the catalogue's content as data, so a test asserts it rather than prose. */
export function toolCatalogModel(): CatalogModel {
  return catalogModel();
}

export function defaultToolCatalog(schema: TableSchema, periodIndex: PeriodIndex, state: AnalyticalConversationState): string {
  const facts = capabilityFactsOf({ schema, periodIndex, state });
  return buildToolContext({ facts, selection: selectCapabilities({ facts }) }).text;
}

export function buildEngineContext(
  schema: TableSchema,
  grids: AnalysisGrids,
  periodIndex: PeriodIndex,
  state: AnalyticalConversationState,
  toolCatalog?: string,
): EngineContext {
  return {
    tableBlock: buildTableBlock(schema, periodIndex),
    metricsBlock: buildMetricsBlock(schema, grids, periodIndex),
    stateBlock: buildStateBlock(state),
    toolCatalog: toolCatalog ?? defaultToolCatalog(schema, periodIndex, state),
  };
}
