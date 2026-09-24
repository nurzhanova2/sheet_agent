import { findTool, toolNames, type ToolEnv, type ToolSpec } from "./registry.js";
import { CAPABILITY_PURPOSE, type CapabilityId } from "../capability/capability-model.js";
import { unknownReference, type ArgSpec } from "./contracts.js";
import { RESULT_ID_RE, refNameFor } from "./semantic-refs.js";
import { toolError, type ToolCallDecision, type ToolOutcome } from "../types.js";

export interface ValidatedCall {
  readonly spec: ToolSpec;
  readonly args: Readonly<Record<string, unknown>>;
  /** Stable identity of this exact call, for the cache and repeat detection. */
  readonly signature: string;
}

export type ValidationOutcome = { readonly ok: true; readonly call: ValidatedCall } | { readonly ok: false; readonly error: ToolOutcome };

function typeMatches(spec: ArgSpec, value: unknown): boolean {
  switch (spec.type) {
    // Stage 26.3 §8 — a semantic reference travels as a plain resultId string,
    // so metricRef/periodRef validate exactly like resultRef here; what they
    // MEAN is enforced by the dereferencer.
    case "string":
    case "resultRef":
    case "metricRef":
    case "periodRef":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    // Stage 26.3 §12 — a filter operand: a number, a string, or a string list
    // for `in`/`not_in`. The tool validates it against the FIELD's kind; no
    // implicit numeric/string coercion happens anywhere.
    case "value":
      return typeof value === "number" || typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/** Deterministic signature: tool name plus its arguments in a stable key order. */
export function callSignature(tool: string, args: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(args).sort();
  return `${tool}(${keys.map((k) => `${k}=${JSON.stringify(args[k])}`).join(",")})`;
}

export interface ToolExposure {
  readonly exposed: ReadonlySet<string>;
  readonly availableCapabilities: readonly CapabilityId[];
}

export function exposureError(tool: string, spec: ToolSpec | undefined, exposure: ToolExposure): ToolOutcome {
  const names = [...exposure.exposed];
  if (!spec) return toolError("UNKNOWN_TOOL", `there is no tool "${tool}"`, names);
  const capability = spec.capability;
  const summary = exposure.availableCapabilities.map((id) => `${id} (${CAPABILITY_PURPOSE[id]})`);
  return toolError(
    "CAPABILITY_UNAVAILABLE",
    `"${tool}" belongs to the "${capability}" capability, which this turn does not have. Available capabilities: ${summary.join("; ") || "none"}`,
    names,
  );
}

export function validateCall(decision: ToolCallDecision, env: ToolEnv, exposure?: ToolExposure): ValidationOutcome {
  const spec = findTool(decision.tool);
  if (exposure && !exposure.exposed.has(decision.tool)) {
    return { ok: false, error: exposureError(decision.tool, spec, exposure) };
  }
  if (!spec) return { ok: false, error: toolError("UNKNOWN_TOOL", `there is no tool "${decision.tool}"`, toolNames()) };

  const args = decision.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, error: toolError("INVALID_ARGUMENT", `"arguments" must be an object for "${decision.tool}"`) };
  }

  const declared = Object.keys(spec.args);
  const unknown = Object.keys(args).filter((k) => !declared.includes(k));
  if (unknown.length > 0) {
    return { ok: false, error: toolError("INVALID_ARGUMENT", `"${decision.tool}" has no argument ${unknown.map((u) => `"${u}"`).join(", ")}`, declared) };
  }

  for (const [name, argSpec] of Object.entries(spec.args)) {
    const value = args[name];
    if (value === undefined) {
      if (argSpec.required) return { ok: false, error: toolError("INVALID_ARGUMENT", `"${decision.tool}" requires "${name}": ${argSpec.describe}`, declared) };
      continue;
    }
    // Stage 26.3 §8 — a reference pushed into a LITERAL slot was 26.2L's single
    // largest error class, in two spellings: the bare id ({"metric":"result_1"})
    // and an object wrapper ({"metric":{"inputRef":"result_1"}}). When the tool
    // has the matching `<arg>Ref` sibling, NAME IT: the call is one rename away
    // from correct, and the planner can only make that rename if the error says
    // so. This is contract guidance, not wording-specific help.
    const sibling = refNameFor(name);
    if (spec.args[sibling]) {
      const bareId = typeof value === "string" && RESULT_ID_RE.test(value);
      const wrapped = typeof value === "object" && value !== null && !Array.isArray(value);
      if (bareId || wrapped) {
        const inner = wrapped
          ? Object.values(value as Record<string, unknown>).find((v): v is string => typeof v === "string" && RESULT_ID_RE.test(v))
          : (value as string);
        return {
          ok: false,
          error: toolError(
            "INVALID_ARGUMENT",
            inner
              ? `"${name}" of "${decision.tool}" takes a literal value; to use the result "${inner}" pass it as "${sibling}": "${inner}"`
              : `"${name}" of "${decision.tool}" must be ${argSpec.type} — ${argSpec.describe}. To pass an earlier result instead, use "${sibling}".`,
            [sibling],
          ),
        };
      }
    }
    if (!typeMatches(argSpec, value)) {
      return { ok: false, error: toolError("INVALID_ARGUMENT", `"${name}" of "${decision.tool}" must be ${argSpec.type} — ${argSpec.describe}`) };
    }
  }

  // Stage 26.3 §3 — a semantic reference must name a result that exists. The
  // TYPE and CARDINALITY checks belong to the dereferencer, which knows what
  // each slot means; this only turns an invented id into a recoverable error.
  for (const [name, argSpec] of Object.entries(spec.args)) {
    if (argSpec.type !== "metricRef" && argSpec.type !== "periodRef") continue;
    const value = args[name];
    if (typeof value !== "string") continue;
    if (!env.store.get(value)) {
      return { ok: false, error: unknownReference(value, env) };
    }
  }

  // §8 — an inputRef must point at a result TYPE this tool can work with. The
  // tool's own checks still run afterwards; this catches the category error
  // (ranking a series by a per-metric field) before the tool has to guess.
  const ref = args["inputRef"] ?? args["leftRef"];
  if (typeof ref === "string" && spec.accepts) {
    const source = env.store.get(ref);
    if (!source) return { ok: false, error: unknownReference(ref, env) };
    if (!spec.accepts.includes(source.type)) {
      return {
        ok: false,
        error: toolError("INCOMPATIBLE_INPUT", `"${decision.tool}" cannot take a ${source.type} result like "${ref}"`, [...spec.accepts]),
      };
    }
  }

  return { ok: true, call: { spec, args, signature: callSignature(decision.tool, args) } };
}

/**
 * §38/§39 — runs a validated call, reusing an identical earlier call's result
 * within this turn. Caching is keyed on the exact signature, and only
 * successful results are cached: a typed error must be re-delivered so the
 * planner sees it again rather than silently continuing.
 */
export function executeCall(call: ValidatedCall, env: ToolEnv, cache: Map<string, string>): { readonly outcome: ToolOutcome; readonly cached: boolean } {
  const hit = cache.get(call.signature);
  if (hit) {
    const existing = env.store.get(hit);
    if (existing) return { outcome: { ok: true, result: existing }, cached: true };
  }
  let outcome: ToolOutcome;
  try {
    outcome = call.spec.run(call.args, env);
  } catch (error) {
    outcome = toolError("INCOMPATIBLE_INPUT", error instanceof Error ? error.message : String(error));
  }
  if (outcome.ok) cache.set(call.signature, outcome.result.resultId);
  return { outcome, cached: false };
}
