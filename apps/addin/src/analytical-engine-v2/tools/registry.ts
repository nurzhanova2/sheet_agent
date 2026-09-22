// ---------------------------------------------------------------------------
// Stage 26.2 §3/§64 — the V2 tool registry.
//
// Assembly only. Every adapter lives in a per-category module and every one of
// them wraps an existing Stage 24.7–24.9 deterministic primitive: this file
// introduces no analytical behaviour of its own.
// ---------------------------------------------------------------------------

import { CHANGE_AGGREGATE_TOOLS } from "./change-aggregate-tools.js";
import { JOIN_TOOLS } from "./join-tools.js";
import { PERIOD_VALUE_TOOLS } from "./period-value-tools.js";
import { REFERENCE_TOOLS } from "./reference-tools.js";
import { SCHEMA_METRIC_TOOLS } from "./schema-metric-tools.js";
import { SET_DERIVE_TOOLS } from "./set-derive-tools.js";
import { TEMPORAL_EVENT_TOOLS } from "./temporal-event-tools.js";
import type { ToolSpec } from "./contracts.js";

export { buildToolEnv } from "./contracts.js";
export type { ArgSpec, ToolEnv, ToolSpec } from "./contracts.js";

export const V2_TOOLS: readonly ToolSpec[] = [
  ...SCHEMA_METRIC_TOOLS,
  ...PERIOD_VALUE_TOOLS,
  ...CHANGE_AGGREGATE_TOOLS,
  ...SET_DERIVE_TOOLS,
  ...JOIN_TOOLS,
  ...TEMPORAL_EVENT_TOOLS,
  ...REFERENCE_TOOLS,
];

const BY_NAME = new Map(V2_TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolSpec | undefined {
  return BY_NAME.get(name);
}

export function toolNames(): readonly string[] {
  return V2_TOOLS.map((t) => t.name);
}
