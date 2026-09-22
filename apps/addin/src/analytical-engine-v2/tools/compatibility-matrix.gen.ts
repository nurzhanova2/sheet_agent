// ---------------------------------------------------------------------------
// Stage 26.3 §21 — generator for the tool/argument compatibility matrix.
//
// Derived from the registry itself rather than written by hand, so it cannot
// drift from the real contract. `interop.test.ts` asserts the invariant this
// document reports; this renders it for humans.
//
// Run:  npx vitest run src/analytical-engine-v2/tools/compatibility-matrix.test.ts
// ---------------------------------------------------------------------------

import { V2_TOOLS } from "./registry.js";
import type { ArgSpec } from "./contracts.js";

/** The semantic type a slot carries, as opposed to how it is spelled. */
function semanticType(arg: string, spec: ArgSpec): string {
  switch (spec.type) {
    case "metricRef":
      return "Metric";
    case "periodRef":
      return "Period";
    case "resultRef":
      return "ResultSet";
    case "string[]":
      return arg === "metrics" ? "Metric[]" : "string[]";
    case "value":
      return "Scalar (number | string | string[])";
    default:
      if (arg === "metric") return "Metric";
      if (["of", "period", "startPeriod", "endPeriod", "at"].includes(arg)) return "Period";
      return spec.type;
  }
}

function cardinality(arg: string, spec: ArgSpec): string {
  if (spec.type === "metricRef" || spec.type === "periodRef") return "exactly 1";
  if (spec.type === "resultRef") return "0..N";
  if (arg === "metric" || ["of", "period", "startPeriod", "endPeriod", "at"].includes(arg)) return "exactly 1";
  return "—";
}

export function renderCompatibilityMatrix(): string {
  const rows: string[] = [
    "| Tool | Argument | Semantic type | Literal? | ResultRef? | Accepted result types | Cardinality |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const tool of V2_TOOLS) {
    const entries = Object.entries(tool.args);
    if (entries.length === 0) {
      rows.push(`| \`${tool.name}\` | *(none)* | — | — | — | — | — |`);
      continue;
    }
    for (const [arg, spec] of entries) {
      if (arg.endsWith("Ref") && tool.args[arg.slice(0, -3)]) continue; // reported on its literal row
      const refSibling = tool.args[`${arg}Ref`];
      const isRefItself = spec.type === "resultRef" || spec.type === "metricRef" || spec.type === "periodRef";
      const literal = isRefItself ? "no" : "yes";
      const byRef = isRefItself || refSibling ? "yes" : "no";
      const refType = refSibling?.type ?? (isRefItself ? spec.type : undefined);
      const accepted =
        refType === "metricRef"
          ? "any result naming exactly 1 metric"
          : refType === "periodRef"
            ? "any result naming exactly 1 period"
            : refType === "resultRef"
              ? (tool.accepts ? tool.accepts.join(", ") : "per-metric result")
              : "—";
      const name = refSibling ? `${arg} / ${arg}Ref` : arg;
      rows.push(
        `| \`${tool.name}\` | \`${name}\` | ${semanticType(arg, spec)} | ${literal} | ${byRef} | ${accepted} | ${cardinality(arg, spec)} |`,
      );
    }
  }
  return [
    "# Stage 26.3 §21 — V2 tool compatibility matrix",
    "",
    `Generated from the registry. ${V2_TOOLS.length} tools.`,
    "",
    "A slot marked **ResultRef? = yes** can be supplied with the output of an earlier",
    "tool instead of a retyped literal. Coercion is cardinality-checked: a result",
    "qualifies as a Metric only if it names exactly one metric, and as a Period only",
    "if it names exactly one period.",
    "",
    ...rows,
    "",
  ].join("\n");
}
