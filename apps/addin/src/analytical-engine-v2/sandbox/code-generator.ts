// ---------------------------------------------------------------------------
// Stage 27 §13/§14/§18/§24/§28/§30/§66 — asking a model for analysis code.
//
// The prompt is short on encouragement and long on contract, because almost
// every way this goes wrong is a contract failure rather than a reasoning one:
// the script prints instead of assigning, fills a gap with zero, writes a
// sentence into the result, or forgets to seed a stochastic method so two runs
// of the same question disagree.
//
// Two rules deserve their prominence here.
//
// §28 — Python calculates, the narrator explains. The model is told, in the
// system prompt and again in the envelope description, that no field may
// contain a sentence about the business. This is not stylistic: a conclusion
// written by generated code has bypassed the §31 numeric verification and the
// §56 narration checks entirely, and would reach the user unexamined.
//
// §23/§25 — a missing value is not zero. The dataset arrives with NaN where
// the workbook had no observation, and the prompt requires the script to
// DECLARE what it did about them. A declared `exclude` is auditable; a silent
// `fillna(0)` turns an empty cell into "нет продаж" two layers downstream.
// ---------------------------------------------------------------------------

import { dimensionBrief, type ExplorationDimension } from "./exploration.js";
import { criteriaForPrompt } from "./method-comparison.js";
import type { CodeRequest } from "./executor.js";
import type { SandboxDataset } from "./types.js";

export interface CodeMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

const SYSTEM = [
  "You write short Python analysis scripts. Output ONLY Python code — no prose, no explanation, no markdown fences.",
  "",
  "WHAT YOU ARE GIVEN (already in scope, do not create or load them)",
  "  data     pandas.DataFrame — the table to analyse. NaN means the cell was EMPTY.",
  "  meta     list of dicts, one per column: name, semanticType, unit, missingCount, zeroCount.",
  "  periods  list of period labels in order, or None if the table has no time axis.",
  "  pd, np   pandas and numpy, already imported.",
  "",
  "WHAT YOU MUST PRODUCE",
  "  Assign a dict to RESULT. Nothing else is read — printing is not a result.",
  "",
  "  RESULT = {",
  '    "method": {"name": str, "parameters": dict, "random_state": int | None},',
  '    "tables": {name: DataFrame},          # comparisons, profiles, per-entity numbers',
  '    "series": {name: Series},             # something measured over periods',
  '    "groups": [{"label": str, "members": [str], "profile": {str: float}}],',
  '    "scalars": {name: float},             # single measurements',
  '    "models": [dict],                     # fitted-model summaries as plain numbers',
  '    "diagnostics": {name: value},         # quality measures: silhouette, r2, p-values',
  '    "findings": [{"kind": str, "subject": str, "values": {str: float}}],',
  '    "preprocessing": {"missingValuePolicy": {"method": str, "rationale": str,',
  '                       "affectedRows": int, "affectedColumns": [str]},',
  '                      "scaling": str, "steps": [str]},',
  '    "warnings": [str],',
  "  }",
  "  Include only the keys your analysis actually produces.",
  "",
  "RULES",
  "- NO sentences anywhere in RESULT. No conclusions, no business meaning, no recommendations.",
  "  Return numbers and structures; something else turns them into an answer.",
  "- NEVER fill a missing value with 0. NaN means 'not observed'; 0 means 'observed as zero'.",
  "  Choose a policy (exclude / impute / interpolate) and DECLARE it in preprocessing.missingValuePolicy.",
  "- Any random or iterative method must set random_state=0 and report it in method.",
  "- Respect semanticType: never average an entity_id or a category; a percent_fraction is",
  "  already 0..1, so do not divide it by 100 again.",
  "- Available: numpy, pandas, scipy, sklearn, and the Python maths modules.",
  "  NOT available: os, sys, io, subprocess, socket, requests, urllib, open(), eval(), exec().",
  "  The data is already in `data` — never read a file or a URL.",
  "- Keep it under 60 lines. Prefer one clear method to three half-finished ones.",
].join("\n");

/** §9 — the schema the script is written against, as compact prose. */
function describeDataset(dataset: SandboxDataset): string {
  const lines = dataset.columns.map((c) => {
    const bits = [`${c.name}: ${c.semanticType}`];
    if (c.unit) bits.push(`unit ${c.unit}`);
    // §23/§25 — both counts, always, so the script can see the difference it
    // is required to preserve.
    if (c.missingCount > 0) bits.push(`${c.missingCount} empty`);
    if (c.zeroCount > 0) bits.push(`${c.zeroCount} recorded zeros`);
    return `  - ${bits.join(", ")}`;
  });
  const sample = dataset.rows.slice(0, 3).map((row) => `  ${JSON.stringify(row)}`);
  return [
    `Sheet "${dataset.sheet}", ${dataset.rows.length} rows × ${dataset.columns.length} columns.`,
    "Columns:",
    ...lines,
    ...(dataset.periods && dataset.periods.length > 0 ? [`Periods, in order: ${dataset.periods.join(", ")}`] : []),
    "First rows:",
    ...sample,
  ].join("\n");
}

/**
 * §18/§19/§20/§21 — the multi-method contract, stated only when it applies.
 *
 * One method needs no comparison and gets no paragraph about one; §19 only
 * binds when the planner committed to several. When it does bind, the prompt
 * is explicit that EXECUTING is what counts, because the failure this section
 * exists to prevent is fluent and cheap: a script that fits k-means, then
 * writes `"hierarchical": {"note": "would also be reasonable"}` and calls that
 * a comparison.
 *
 * The criteria vocabulary is quoted in full rather than described. A model
 * told to "explain your criteria" writes a sentence; a model handed twelve
 * words and told to pick from them returns something checkable — and the check
 * behind this refuses anything else (§21).
 */
function methodSection(methods: readonly string[]): readonly string[] {
  if (methods.length === 0) return [];
  const head = ["", "=== METHODS TO USE ===", ...methods.map((m) => `  - ${m}`)];
  if (methods.length < 2) return [...head, "Report the method and its parameters in RESULT[\"method\"]."];
  return [
    ...head,
    "ACTUALLY RUN EACH ONE. Naming a method you did not execute does not count as trying it.",
    "Then add a comparison to RESULT:",
    '  RESULT["method_comparison"] = {',
    '    "methods": [{"name": str, "parameters": dict, "metrics": {str: float}, "warnings": [str]}, ...],',
    '    "selected": str,                 # must be one of the names above',
    '    "selection_criteria": [str],      # ONLY these words:',
    `    #   ${criteriaForPrompt()}`,
    '    "selection_evidence": {str: float},  # a number behind EACH criterion you named',
    "  }",
    "Every method needs at least one real metric — that is what shows it ran.",
    "Do not write \"interpretability\", \"cleaner\" or \"makes more sense\": say WHICH of the",
    "criteria above you measured, and give the number you measured it with.",
    'Also set RESULT["method"] to the selected method, so the result stays reproducible.',
  ];
}

/**
 * §36/§37 — the exploration brief, when the planner asked for one.
 *
 * The dimensions arrive already chosen, so this does not decide WHERE to look;
 * it says what each look has to produce, and — the part that matters — that a
 * dimension which found nothing still has to say so. An exploration that
 * silently omits the dimension where nothing turned up reads exactly like one
 * that never ran it, and the reader cannot tell "пропусков нет" from "я не
 * смотрел".
 */
function explorationSection(dimensions: readonly ExplorationDimension[]): readonly string[] {
  if (dimensions.length === 0) return [];
  return [
    "",
    "=== EXPLORE THESE, AND ONLY THESE ===",
    ...dimensions.map((d) => `  ${d}: ${dimensionBrief(d)}`),
    "",
    'Put every observation in RESULT["findings"] as {"kind": <the dimension name>, "subject": <what it is about>, "values": {<name>: <number>}}.',
    "EVERY dimension above needs at least one entry, including the ones where nothing stood out —",
    'use values like {"count": 0} to say so. A dimension you leave out reads as one you never ran.',
    "Use the value names given above where they are given: they are what the report is built from.",
    "Do not rank the dimensions or decide which matters most. Report what you measured.",
  ];
}

/**
 * §66 — the repair message.
 *
 * Deliberately terse. A generator handed a forty-line traceback fixes the
 * traceback; one handed "KeyError: 'Feb'" plus its own previous code fixes the
 * analysis. The failing code is included because a model asked to repair
 * something it cannot see rewrites it from scratch, losing whatever was right.
 */
function repairSection(request: CodeRequest): readonly string[] {
  if (!request.previous || !request.failure) return [];
  return [
    "",
    `=== YOUR PREVIOUS ATTEMPT (attempt ${request.attempt - 1}) FAILED ===`,
    request.previous,
    "",
    "=== WHY IT FAILED ===",
    request.failure.repairHint ?? request.failure.message,
    "",
    "Fix that specific problem. Keep everything that worked. Return the corrected script only.",
  ];
}

/** §13 — the plan, the data and (on a retry) the failure. */
export function buildCodeMessages(request: CodeRequest): readonly CodeMessage[] {
  const { plan, dataset } = request;
  const outputs = plan.requestedOutputs.map((o) => `  - ${o.id} (${o.shape}): ${o.description}`);
  const user = [
    "=== OBJECTIVE ===",
    plan.objective,
    "",
    "=== REQUIRED OUTPUTS ===",
    "Your RESULT must contain each of these, in the shape named:",
    ...outputs,
    ...methodSection(plan.methodConstraints ?? []),
    ...explorationSection(plan.explorationDimensions ?? []),
    ...(plan.assumptions && plan.assumptions.length > 0 ? ["", "=== ASSUMPTIONS ===", ...plan.assumptions.map((a) => `  - ${a}`)] : []),
    "",
    "=== THE DATA ===",
    describeDataset(dataset),
    ...repairSection(request),
    "",
    "Return the Python script only.",
  ].join("\n");

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

/**
 * Recover the code from whatever the model actually sent.
 *
 * Models fence code even when told not to, and sometimes prepend a sentence of
 * explanation. Stripping both is cheaper than spending a repair attempt on a
 * SyntaxError caused by a backtick — and the AST validator behind this will
 * still refuse anything that is not really Python.
 */
export function extractCode(raw: string): string {
  const fenced = /```(?:python|py)?\s*\n([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) return fenced[1].trim();
  // An unterminated fence: take everything after the opener.
  const opener = /```(?:python|py)?\s*\n([\s\S]*)$/.exec(raw);
  if (opener?.[1]) return opener[1].trim();
  return raw.trim();
}

/** §14 — what is stored about a generation, for audit and "Показать код". */
export interface GeneratedCode {
  readonly code: string;
  readonly attempt: number;
  readonly objective: string;
}
