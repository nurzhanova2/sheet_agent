// ---------------------------------------------------------------------------
// Stage 24.4 — the agent decision protocol.
//
// Each iteration the model returns ONE of:
//   { kind: "tool_call", tool, input }   — run a deterministic tool
//   { kind: "clarify",   question, candidates } — ask the user, persist the task
//   { kind: "final",     answer }        — finish, grounded in observations
//
// Anything else FAILS CLOSED. There is no "best guess" fallback: a malformed
// decision is surfaced to the loop, which bounds retries.
// ---------------------------------------------------------------------------

import type { AgentDecision, ParsedDecision } from "./types.js";

const TOOL_CALL_KEYS = new Set(["kind", "tool", "input"]);
const CLARIFY_KEYS = new Set(["kind", "question", "candidates"]);
const FINAL_KEYS = new Set(["kind", "answer"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extraKeys(object: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(object).filter((key) => !allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates a raw model decision. Accepts a JSON string or an already-parsed
 * value. Returns `{ ok: true, decision }` only for a well-formed, fully-typed
 * decision with no unexpected keys.
 */
export function parseAgentDecision(raw: unknown): ParsedDecision {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: "decision is not valid JSON" };
    }
  }

  if (!isPlainObject(value)) return { ok: false, error: "decision must be a JSON object" };

  const kind = value["kind"];
  if (kind !== "tool_call" && kind !== "clarify" && kind !== "final") {
    return { ok: false, error: `unknown decision kind ${JSON.stringify(kind)}` };
  }

  if (kind === "tool_call") {
    const unexpected = extraKeys(value, TOOL_CALL_KEYS);
    if (unexpected.length > 0) return { ok: false, error: `unexpected key(s) on tool_call: ${unexpected.join(", ")}` };
    const tool = value["tool"];
    if (typeof tool !== "string" || tool.trim() === "") return { ok: false, error: "tool_call.tool must be a non-empty string" };
    const input = value["input"] ?? {};
    if (!isPlainObject(input)) return { ok: false, error: "tool_call.input must be a JSON object" };
    const decision: AgentDecision = { kind: "tool_call", tool: tool.trim(), input };
    return { ok: true, decision };
  }

  if (kind === "clarify") {
    const unexpected = extraKeys(value, CLARIFY_KEYS);
    if (unexpected.length > 0) return { ok: false, error: `unexpected key(s) on clarify: ${unexpected.join(", ")}` };
    const question = value["question"];
    if (typeof question !== "string" || question.trim() === "") return { ok: false, error: "clarify.question must be a non-empty string" };
    const rawCandidates = value["candidates"] ?? [];
    if (!isStringArray(rawCandidates)) return { ok: false, error: "clarify.candidates must be an array of strings" };
    const decision: AgentDecision = {
      kind: "clarify",
      question: question.trim(),
      candidates: rawCandidates.map((c) => c.trim()).filter((c) => c !== ""),
    };
    return { ok: true, decision };
  }

  const unexpected = extraKeys(value, FINAL_KEYS);
  if (unexpected.length > 0) return { ok: false, error: `unexpected key(s) on final: ${unexpected.join(", ")}` };
  const answer = value["answer"];
  if (typeof answer !== "string" || answer.trim() === "") return { ok: false, error: "final.answer must be a non-empty string" };
  return { ok: true, decision: { kind: "final", answer: answer.trim() } };
}
