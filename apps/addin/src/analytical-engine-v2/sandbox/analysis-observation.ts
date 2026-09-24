import type { LookObservation, StepObservation } from "./pyodide-runtime.js";
import type { AnalysisActionKind } from "./analysis-decision.js";

const NEWLINE = String.fromCharCode(10);

/** A variable as the agent sees it: name, type, shape. Never contents (§10). */
export interface VariableDescriptor {
  readonly name: string;
  readonly type: string;
  readonly shape?: readonly number[];
  readonly dtype?: string;
}

export type ObservationStatus =
  /** The action did what it said. */
  | "ok"
  /** Python raised. Recoverable, and the agent's business (§7/§8). */
  | "error"
  /** The system declined to act at all: unsafe code, a dead runtime (§25). */
  | "refused"
  /** §17 — the identical ineffective action, again. */
  | "repeated"
  /** §20 — COMPLETE arrived but the analysis is not finished. */
  | "incomplete";

export interface AgentObservation {
  readonly stepId: number;
  readonly actionType: AnalysisActionKind | "CONTROL";
  readonly status: ObservationStatus;
  readonly summary: string;
  readonly createdVariables?: readonly VariableDescriptor[];
  readonly variableUpdates?: readonly VariableDescriptor[];
  readonly resultRefs?: readonly string[];
  readonly error?: {
    readonly type: string;
    readonly message: string;
    readonly failingLine?: string;
    readonly line?: number;
    /** §7 — what DOES exist, so no name has to be guessed. */
    readonly available?: readonly VariableDescriptor[];
    readonly prepared?: readonly string[];
  };
  readonly warnings?: readonly string[];
  readonly elapsedMs: number;
}

/** A Python-side descriptor map, as `VariableDescriptor`s. */
export function describeEnvironment(available: Readonly<Record<string, unknown>>): readonly VariableDescriptor[] {
  const out: VariableDescriptor[] = [];
  for (const [name, raw] of Object.entries(available)) {
    if (typeof raw !== "object" || raw === null) continue;
    const info = raw as Record<string, unknown>;
    const shape = Array.isArray(info["shape"]) ? (info["shape"] as unknown[]).filter((n): n is number => typeof n === "number") : undefined;
    out.push({
      name,
      type: typeof info["type"] === "string" ? info["type"] : "unknown",
      ...(shape && shape.length > 0 ? { shape } : {}),
      ...(typeof info["dtype"] === "string" ? { dtype: info["dtype"] } : {}),
    });
  }
  return out;
}

/** `features: DataFrame (9, 12)` — the §6 line. */
export function renderVariable(variable: VariableDescriptor): string {
  const shape = variable.shape && variable.shape.length > 0 ? ` (${variable.shape.join(", ")})` : "";
  const dtype = variable.dtype ? ` ${variable.dtype}` : "";
  return `${variable.name}: ${variable.type}${shape}${dtype}`;
}

/**
 * A step's raw result, as an observation.
 *
 * `before` is the environment as it was BEFORE the step, which is what makes
 * §6's "Created / Updated" split possible at all. Without it every surviving
 * variable looks new on every step and the agent cannot tell what it just did
 * from what was already there.
 */
export function observeStep(params: {
  readonly stepId: number;
  readonly step: StepObservation;
  readonly before: readonly VariableDescriptor[];
}): AgentObservation {
  const { stepId, step, before } = params;
  const now = describeEnvironment(step.available);
  const previous = new Map(before.map((v) => [v.name, renderVariable(v)]));

  if (step.status === "error") {
    return {
      stepId,
      actionType: "EXECUTE_CODE",
      status: "error",
      summary: `EXECUTION_ERROR ${step.errorType ?? "Error"}`,
      error: {
        type: step.errorType ?? "Error",
        message: (step.message ?? "").slice(0, 400),
        ...(step.failingLine ? { failingLine: step.failingLine } : {}),
        ...(typeof step.line === "number" ? { line: step.line } : {}),
        available: now,
        ...(step.prepared ? { prepared: step.prepared } : {}),
      },
      elapsedMs: step.durationMs,
    };
  }

  const created = now.filter((v) => !previous.has(v.name));
  const updated = now.filter((v) => previous.has(v.name) && previous.get(v.name) !== renderVariable(v));
  return {
    stepId,
    actionType: "EXECUTE_CODE",
    status: "ok",
    summary: "EXECUTION_OK",
    ...(created.length > 0 ? { createdVariables: created } : {}),
    ...(updated.length > 0 ? { variableUpdates: updated } : {}),
    ...(step.emitted && step.emitted.length > 0 ? { resultRefs: step.emitted } : {}),
    ...(step.stdout.trim() !== "" ? { warnings: [`stdout: ${step.stdout.trim().slice(0, 500)}`] } : {}),
    elapsedMs: step.durationMs,
  };
}

/** §11/§12 — an INSPECT result, as an observation. */
export function observeLook(params: { readonly stepId: number; readonly look: LookObservation; readonly elapsedMs: number }): AgentObservation {
  const { stepId, look, elapsedMs } = params;
  if (look.status === "unknown_variable") {
    return {
      stepId,
      actionType: "INSPECT",
      status: "error",
      summary: `INSPECT_UNKNOWN ${look.variable ?? ""}`.trim(),
      error: {
        type: "UnknownVariable",
        message: `there is no variable named "${look.variable ?? ""}" in this session`,
        available: describeEnvironment(look.available ?? {}),
        ...(look.prepared ? { prepared: look.prepared } : {}),
      },
      elapsedMs,
    };
  }
  return { stepId, actionType: "INSPECT", status: look.status === "error" ? "error" : "ok", summary: renderLook(look), elapsedMs };
}

/** The §12 body of a look: ground truth, bounded. */
export function renderLook(look: LookObservation): string {
  const lines: string[] = [look.variable ? `${look.variable}` : look.target];
  if (look.type) lines.push(`type: ${look.type}`);
  if (look.shape && look.shape.length > 0) lines.push(`shape: [${look.shape.join(",")}]`);
  if (look.dtype) lines.push(`dtype: ${look.dtype}`);
  if (look.dtypes) {
    const parts = Object.entries(look.dtypes).map(([name, count]) => `${name} ×${count}`);
    if (parts.length > 0) lines.push(`dtypes: ${parts.join(", ")}`);
  }
  // `table.info` reports its missing counts PER COLUMN, and the columns it
  // reports are the whole point of the target: a live run showed the agent
  // inspecting `table.info` twice, being told only the shape, and then
  // guessing twelve column names — every one of them wrong.
  if (look.entityColumns && look.entityColumns.length > 0) lines.push(`entity columns: ${look.entityColumns.join(", ")}`);
  if (look.numericColumns && look.numericColumns.length > 0) lines.push(`numeric columns: ${look.numericColumns.join(", ")}`);
  if (look.matrixShape && look.matrixShape.length > 0) lines.push(`X (numeric matrix): [${look.matrixShape.join(",")}]`);
  if (typeof look.missing === "number") lines.push(`missing: ${look.missing}`);
  else if (look.missing && typeof look.missing === "object") {
    const parts = Object.entries(look.missing as Readonly<Record<string, number>>).map(([name, count]) => `${name}: ${count}`);
    lines.push(parts.length > 0 ? `missing values by column: ${parts.join(", ")}` : "missing values: none");
  }
  if (look.finite) lines.push(`finite: ${look.finite[0]}/${look.finite[1]}`);
  if (look.columns && look.columns.length > 0) lines.push(`columns: ${look.columns.slice(0, 40).join(", ")}`);
  if (look.schema) {
    for (const field of look.schema.slice(0, 40)) {
      const name = String(field["name"] ?? "");
      // The sandbox calls it `role`. Reading only `type`/`semanticType` — as
      // this did — printed every column with an empty type, so the agent could
      // see the names but not which one held the labels.
      const type = String(field["role"] ?? field["type"] ?? field["semanticType"] ?? "");
      const missing = typeof field["missing"] === "number" && field["missing"] > 0 ? `, ${String(field["missing"])} empty` : "";
      if (name !== "") lines.push(`  ${name}: ${type}${missing}`);
    }
  }
  if (look.emitted) {
    for (const [kind, names] of Object.entries(look.emitted)) {
      if (names.length > 0) lines.push(`${kind}: ${names.join(", ")}`);
    }
  }
  if (look.rows && look.rows.length > 0) {
    if (look.columns && look.columns.length > 0 && !lines.some((l) => l.startsWith("columns:"))) lines.push(`columns: ${look.columns.join(", ")}`);
    for (const row of look.rows.slice(0, 10)) lines.push(`  ${row.map((cell) => String(cell)).join(" | ")}`);
  }
  if (look.status === "not_tabular") lines.push("this variable has no rows or columns to show");
  if (look.status === "error") lines.push(`${look.errorType ?? "Error"}: ${look.message ?? ""}`);
  return lines.join(NEWLINE);
}

/**
 * §6/§7 — one observation, as the agent reads it.
 *
 * The shape of the error block is deliberate and matches §7 line for line.
 * Every field in it answers a question the model would otherwise answer by
 * guessing: what broke, on which line, and what names actually exist.
 */
export function renderObservation(observation: AgentObservation): string {
  const lines: string[] = [`STEP ${observation.stepId} — ${observation.actionType}`];

  if (observation.error) {
    lines.push(observation.summary, "", "type:", observation.error.type, "", "message:", observation.error.message);
    if (observation.error.failingLine) lines.push("", "failingLine:", observation.error.failingLine);
    if (observation.error.available && observation.error.available.length > 0) {
      lines.push("", "available:", ...observation.error.available.map(renderVariable));
    }
    if (observation.error.prepared && observation.error.prepared.length > 0) {
      lines.push("", "always available:", observation.error.prepared.join(", "));
    }
    return lines.join(NEWLINE);
  }

  lines.push(observation.summary);
  if (observation.actionType === "EXECUTE_CODE" && observation.status === "ok") {
    lines.push("", "Created:", ...(observation.createdVariables?.map(renderVariable) ?? ["none"]));
    lines.push("", "Updated:", ...(observation.variableUpdates?.map(renderVariable) ?? ["none"]));
    const emitted = observation.resultRefs ?? [];
    lines.push("", "Emitted results:", emitted.length > 0 ? emitted.join(", ") : "none");
    // The one thing the agent needs to know once it has results, said where it
    // will read it. Without this the live runs kept computing after a
    // successful emit, and one eventually tried to finish from inside Python
    // (NameError: name 'COMPLETE' is not defined).
    if (emitted.length > 0) {
      lines.push(
        "",
        "These are RESULTS you can finish with. When they answer the question, send:",
        `{"action": "COMPLETE", "primaryResultRefs": ["${emitted[0]}"], "supportingResultRefs": []}`,
        "COMPLETE is a DECISION, not Python. Do not write it in code.",
      );
    }
  } else if (observation.resultRefs && observation.resultRefs.length > 0) {
    lines.push("", `results: ${observation.resultRefs.join(", ")}`);
  }
  if (observation.warnings && observation.warnings.length > 0) lines.push("", "warnings:", ...observation.warnings);
  return lines.join(NEWLINE);
}

/**
 * §10 — the observation history the next decision is given.
 *
 * The sandbox session, not the transcript, is authoritative for what exists
 * (§10), so an old observation's variable list is not load-bearing and the
 * oldest can be dropped when the history grows. The MOST RECENT observations
 * are kept, because the last error is what the next action has to answer.
 *
 * The first observation is kept whatever happens: dropping it loses how the
 * analysis started, and a model that cannot see its own opening move tends to
 * repeat it.
 */
export function renderHistory(observations: readonly AgentObservation[], limit = 6): string {
  if (observations.length === 0) return "No actions taken yet.";
  if (observations.length <= limit) return observations.map(renderObservation).join(NEWLINE + NEWLINE);

  const first = observations[0]!;
  const recent = observations.slice(-(limit - 1));
  const dropped = observations.length - recent.length - 1;
  return [
    renderObservation(first),
    `… ${dropped} earlier step${dropped === 1 ? "" : "s"} omitted; the variables they created are still in the session and listed above.`,
    ...recent.map(renderObservation),
  ].join(NEWLINE + NEWLINE);
}
