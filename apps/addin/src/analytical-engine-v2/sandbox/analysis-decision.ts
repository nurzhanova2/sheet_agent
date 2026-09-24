import { LOOK_TARGETS, targetNeedsVariable, type LookTarget } from "./pyodide-runtime.js";

export type AnalysisActionKind = "INSPECT" | "EXECUTE_CODE" | "CALL_TOOL" | "DISCOVER_TOOLS" | "CLARIFY" | "COMPLETE";

export const ALL_ACTIONS: readonly AnalysisActionKind[] = ["INSPECT", "EXECUTE_CODE", "CALL_TOOL", "DISCOVER_TOOLS", "CLARIFY", "COMPLETE"];

export interface DecisionContract {
  readonly actions: readonly AnalysisActionKind[];
}

export const FULL_CONTRACT: DecisionContract = { actions: ALL_ACTIONS };

export type AnalysisDecision =
  | { readonly kind: "INSPECT"; readonly purpose: string; readonly target: LookTarget; readonly variable: string | null }
  | { readonly kind: "EXECUTE_CODE"; readonly purpose: string; readonly code: string }
  | { readonly kind: "CALL_TOOL"; readonly purpose: string; readonly tool: string; readonly input: Readonly<Record<string, unknown>> }
  | { readonly kind: "DISCOVER_TOOLS"; readonly purpose: string; readonly capability: string }
  | { readonly kind: "CLARIFY"; readonly question: string; readonly candidates: readonly string[] }
  | { readonly kind: "COMPLETE"; readonly primaryResultRefs: readonly string[]; readonly supportingResultRefs: readonly string[] };

export type ParsedAnalysisDecision = { readonly ok: true; readonly decision: AnalysisDecision } | { readonly ok: false; readonly error: string };

const KEYS: Readonly<Record<AnalysisActionKind, ReadonlySet<string>>> = {
  INSPECT: new Set(["action", "purpose", "target", "variable"]),
  EXECUTE_CODE: new Set(["action", "purpose", "code"]),
  CALL_TOOL: new Set(["action", "purpose", "tool", "input"]),
  DISCOVER_TOOLS: new Set(["action", "purpose", "capability"]),
  CLARIFY: new Set(["action", "question", "candidates"]),
  COMPLETE: new Set(["action", "primaryResultRefs", "supportingResultRefs"]),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extraKeys(object: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(object).filter((key) => !allowed.has(key));
}

function stringArray(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value.map((item) => item.trim()).filter((item) => item !== "");
}

/**
 * §3 — validate one raw decision.
 *
 * Unknown keys are rejected rather than ignored. An `EXECUTE_CODE` carrying a
 * stray `primaryResultRefs` is a model that thinks it is completing while
 * asking to run code, and acting on the half we recognise commits us to a
 * reading we cannot justify.
 */
export function parseAnalysisDecision(raw: unknown, contract: DecisionContract = FULL_CONTRACT): ParsedAnalysisDecision {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: "the decision is not valid JSON" };
    }
  }
  if (!isPlainObject(value)) return { ok: false, error: "the decision must be a JSON object" };

  const action = value["action"];
  const offered = contract.actions.join(", ");
  if (typeof action !== "string" || !(action in KEYS)) {
    return { ok: false, error: `unknown action ${JSON.stringify(action)}; use one of ${offered}` };
  }
  const kind = action as AnalysisActionKind;
  if (!contract.actions.includes(kind)) {
    return { ok: false, error: `CAPABILITY_UNAVAILABLE ${kind} is not available in this analysis. Available actions: ${offered}` };
  }
  const unexpected = extraKeys(value, KEYS[kind]);
  if (unexpected.length > 0) return { ok: false, error: `unexpected key(s) on ${kind}: ${unexpected.join(", ")}` };

  const purpose = typeof value["purpose"] === "string" ? value["purpose"].trim() : "";

  if (kind === "INSPECT") {
    const target = value["target"];
    if (typeof target !== "string" || !(LOOK_TARGETS as readonly string[]).includes(target)) {
      return { ok: false, error: `INSPECT.target must be one of ${LOOK_TARGETS.join(", ")}` };
    }
    const looked = target as LookTarget;
    const rawVariable = value["variable"];
    if (rawVariable !== undefined && rawVariable !== null && typeof rawVariable !== "string") {
      return { ok: false, error: "INSPECT.variable must be a string" };
    }
    const named = typeof rawVariable === "string" && rawVariable.trim() !== "" ? rawVariable.trim() : null;
    // A `variable.*` target with no variable has nothing to look at, and
    // guessing which one was meant is exactly the repair §3 rules out.
    if (targetNeedsVariable(looked) && named === null) return { ok: false, error: `INSPECT.target "${looked}" needs a variable name` };
    // A `table.*` or `result.*` target does not read `variable`, and the
    // model fills it in anyway — `{"target": "table.head", "variable": "data"}`
    // is what the live run sent. Dropping it is not a guess about intent: the
    // field has no effect on the operation. It matters because §17 identifies
    // a repeated action by its fields, so leaving it in made three identical
    // looks at the table read as three different actions, and the loop spent
    // its whole inspection budget on them.
    const variable = targetNeedsVariable(looked) ? named : null;
    return { ok: true, decision: { kind, purpose, target: looked, variable } };
  }

  if (kind === "EXECUTE_CODE") {
    const code = value["code"];
    if (typeof code !== "string" || code.trim() === "") return { ok: false, error: "EXECUTE_CODE.code must be a non-empty string" };
    return { ok: true, decision: { kind, purpose, code } };
  }

  if (kind === "CALL_TOOL") {
    const tool = value["tool"];
    if (typeof tool !== "string" || tool.trim() === "") return { ok: false, error: "CALL_TOOL.tool must be a non-empty string" };
    const input = value["input"] ?? {};
    if (!isPlainObject(input)) return { ok: false, error: "CALL_TOOL.input must be a JSON object" };
    return { ok: true, decision: { kind, purpose, tool: tool.trim(), input } };
  }

  if (kind === "DISCOVER_TOOLS") {
    const capability = value["capability"];
    if (typeof capability !== "string" || capability.trim() === "") return { ok: false, error: "DISCOVER_TOOLS.capability must be a non-empty capability name" };
    return { ok: true, decision: { kind, purpose, capability: capability.trim() } };
  }

  if (kind === "CLARIFY") {
    const question = value["question"];
    if (typeof question !== "string" || question.trim() === "") return { ok: false, error: "CLARIFY.question must be a non-empty string" };
    const candidates = stringArray(value["candidates"]);
    if (candidates === null) return { ok: false, error: "CLARIFY.candidates must be an array of strings" };
    return { ok: true, decision: { kind, question: question.trim(), candidates } };
  }

  // §19/§21 — COMPLETE is ResultRefs, never prose. A model that has "enough
  // text" has not finished an analysis; it has written about one. Refusing an
  // empty `primaryResultRefs` here is what keeps the narrator from being the
  // thing that decides which computation mattered.
  const primary = stringArray(value["primaryResultRefs"]);
  if (primary === null) return { ok: false, error: "COMPLETE.primaryResultRefs must be an array of strings" };
  if (primary.length === 0) return { ok: false, error: "COMPLETE.primaryResultRefs must name at least one result produced in this analysis" };
  const supporting = stringArray(value["supportingResultRefs"]);
  if (supporting === null) return { ok: false, error: "COMPLETE.supportingResultRefs must be an array of strings" };
  return { ok: true, decision: { kind, primaryResultRefs: primary, supportingResultRefs: supporting } };
}

/**
 * §17 — a stable identity for "the same action again".
 *
 * Deliberately excludes `purpose`: a model that reruns identical broken code
 * under a freshly-worded justification has repeated the action, and letting
 * the wording make it look new is how an ineffective loop stays alive.
 */
export function actionFingerprint(decision: AnalysisDecision): string {
  switch (decision.kind) {
    case "EXECUTE_CODE":
      return `code:${decision.code.trim()}`;
    case "INSPECT":
      return `look:${decision.target}:${decision.variable ?? ""}`;
    case "CALL_TOOL":
      return `tool:${decision.tool}:${stableJson(decision.input)}`;
    case "DISCOVER_TOOLS":
      return `discover:${decision.capability}`;
    case "CLARIFY":
      return `clarify:${decision.question}`;
    case "COMPLETE":
      return `complete:${[...decision.primaryResultRefs].sort().join(",")}`;
  }
}

/** Key order must not change an action's identity. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------
// §16 — reading a response that is not exactly one object.
//
// The first live run failed here, repeatedly and expensively, and the message
// it produced was the least useful one available: "the decision is not valid
// JSON". What the model had actually sent was THREE complete, individually
// valid decisions concatenated — two EXECUTE_CODE and a COMPLETE — which is a
// model that planned the whole analysis in one breath, not a model that
// cannot write JSON. Told "not valid JSON", it has no idea what to change.
//
// Stage 26.6 already met this for the planner and already built the scanner:
// `scanDecisions` classifies the SHAPE of a response without repairing it. It
// is reused here rather than reimplemented, and it keeps the rule that matters
// — §5 of that stage — never pick one decision out of several. A batch is
// reported as a batch, and the agent sends one.
// ---------------------------------------------------------------------------

import { scanDecisions } from "../planner/decision-scan.js";
import type { SerializationClass } from "../types.js";

export type ReadDecision =
  | {
      readonly ok: true;
      readonly decision: AnalysisDecision;
      readonly serialization: SerializationClass;
      /** Set when a BATCH was received and only its first action was taken. */
      readonly batched?: { readonly count: number; readonly dropped: readonly string[] };
    }
  | { readonly ok: false; readonly error: string; readonly serialization: SerializationClass };

/**
 * OVERTURNS Stage 26.6 §5 — but only for this protocol, and only this far.
 *
 * §5 of that stage says the scanner "never picks one object out of several",
 * and for the PLANNER that still holds: `parsePlannerDecision` is untouched
 * and still refuses batches outright.
 *
 * Here it does not hold, and three live runs are the reason. This deployment
 * answers a plan-shaped question with a plan: runs 3 and 4 produced batches of
 * 3, 4, 8 and 10 decisions, and it kept doing it after the prompt was changed
 * to forbid it in three separate sentences. Refusing them cost 13 control
 * errors in run 4 and killed most turns before any analysis ran.
 *
 * The argument that this is not "deciding what the model meant":
 *
 *   The protocol's own guarantee (§1/§8) is that after EVERY action the same
 *   agent is asked again, with the observation. So items 2..n of a batch are
 *   by construction predictions made WITHOUT the information the protocol
 *   promises will arrive before they are acted on. Running the first and
 *   asking again is not a guess about intent — it is precisely what happens
 *   to a single decision, and the model said itself which action came first.
 *
 * That argument only covers a first action whose result the agent will SEE.
 * So the narrowing is hard, and the parts it refuses are the parts §5 was
 * actually protecting:
 *
 *   - every object must be a VALID decision, or the batch is refused whole;
 *   - the first must be EXECUTE_CODE, INSPECT or CALL_TOOL. A batch that
 *     opens with COMPLETE or CLARIFY is refused, because those END the turn:
 *     honouring one written before any result existed would let the model
 *     finish an analysis it had not yet done, which is the §21 failure;
 *   - the agent is TOLD the rest were dropped, so it never believes steps it
 *     did not take have run;
 *   - it is counted and shown in the trace, never silent.
 */
const BATCH_SAFE_FIRST = new Set<AnalysisActionKind>(["EXECUTE_CODE", "INSPECT", "CALL_TOOL", "DISCOVER_TOOLS"]);

export function readAnalysisDecision(raw: string, contract: DecisionContract = FULL_CONTRACT): ReadDecision {
  const scan = scanDecisions(raw, '"action"');

  if (scan.serialization === "concatenated" || scan.serialization === "array") {
    const parsed = scan.objects.map((text) => parseAnalysisDecision(text, contract));
    const actions = parsed.map((p) => (p.ok ? p.decision.kind : "?"));
    const first = parsed[0];

    // A batch is only legible if all of it is. One unparseable member means we
    // do not actually know what the model sent, and the first object being
    // valid does not make the response a plan rather than a mess.
    if (!first?.ok || parsed.some((p) => !p.ok)) {
      return {
        ok: false,
        serialization: scan.serialization,
        error:
          `you sent ${scan.objects.length} objects in one response and at least one is not a valid decision. ` +
          "Send exactly one JSON object.",
      };
    }

    if (!BATCH_SAFE_FIRST.has(first.decision.kind)) {
      return {
        ok: false,
        serialization: scan.serialization,
        error:
          `you sent ${scan.objects.length} decisions at once, beginning with ${first.decision.kind} (${actions.join(", ")}). ` +
          `${first.decision.kind} ends the turn, so it cannot be the first of a plan. Send one action, see its result, then decide.`,
      };
    }

    return {
      ok: true,
      decision: first.decision,
      serialization: scan.serialization,
      batched: { count: scan.objects.length, dropped: actions.slice(1) },
    };
  }

  if (scan.serialization === "truncated") {
    return {
      ok: false,
      serialization: scan.serialization,
      error: "your response was cut off before the JSON object closed. Send a shorter decision — split a long script across two EXECUTE_CODE steps.",
    };
  }

  if (scan.objects.length === 0) {
    return { ok: false, serialization: scan.serialization, error: "the decision is not valid JSON. Send exactly one JSON object, with nothing before or after it." };
  }

  const parsed = parseAnalysisDecision(scan.objects[0]!, contract);
  if (!parsed.ok) return { ok: false, serialization: scan.serialization, error: parsed.error };
  return { ok: true, decision: parsed.decision, serialization: scan.serialization };
}
