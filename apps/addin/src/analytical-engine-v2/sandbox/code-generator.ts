import { dimensionBrief, type ExplorationDimension } from "./exploration.js";
import { criteriaForPrompt } from "./method-comparison.js";
import { buildResultContract, renderResultContract } from "./result-contract.js";
import type { CodeRequest } from "./executor.js";
import type { SandboxDataset, SandboxPlan } from "./types.js";

export interface CodeMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

const SANDBOX_RULE_LINES: readonly string[] = [
  "You write short Python analysis scripts. Output ONLY Python code — no prose, no explanation, no markdown fences.",
  "",
  "WHAT YOU ARE GIVEN (already in scope, do not create or load them)",
  "  data          pandas.DataFrame — the whole table. NaN means the cell was EMPTY.",
  "  numeric_data  DataFrame of the numeric columns only, float dtype, same rows and index as data.",
  "  entity_data   DataFrame of the label columns only, same rows and index as data.",
  "  X             numpy float matrix of numeric_data. NaN preserved — nothing was filled.",
  "  numeric_columns, entity_columns   their column names.",
  "  meta     list of dicts, one per column: name, semanticType, unit, missingCount, zeroCount.",
  "  periods  list of period labels in order, or None if the table has no time axis.",
  "  pd, np   pandas and numpy, already imported.",
  "",
  "WHICH ONE TO USE",
  "  numeric_data or X for anything numeric — sklearn, scipy, regression, distances, clustering.",
  "  data for raw values and labels; entity_data to map results back to the entities they describe.",
  "  Never hand `data` to a numerical algorithm: it holds the text label column and will raise.",
  "  X is a numpy array, NOT a DataFrame. It has no fillna, dropna, isna, groupby, iterrows,",
  "  apply, loc, iloc, .index or .columns. Do every pandas step on numeric_data, and convert",
  "  at the end — `numeric_data.dropna().to_numpy()` — or use the prepared X if you changed nothing.",
  "  A pandas boolean mask cannot index X either: `X[mask.to_numpy()]`, or filter numeric_data first.",
  "  All three share one index, so a mask built on one lines up with the others.",
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
  "NAMING — every name you write here can end up in front of a reader",
  "  Name each entry of tables/series/scalars/groups after WHAT IT HOLDS, in lowercase English:",
  '  "december_total", "cluster_profiles", "monthly_growth" — never "a1", "out1", "result", "df".',
  "  A `subject` and a table's first column MUST be a label the data actually carries — a value",
  "  from the metric/entity column. Never a row position, an index number, a column letter, or an",
  "  id from this prompt. If you cannot attach a real label to a number, leave it out of findings.",
  "",
  "RULES",
  "- NO sentences anywhere in RESULT. No conclusions, no business meaning, no recommendations.",
  "  Return numbers and structures; something else turns them into an answer.",
  "- NEVER fill a missing value with 0. NaN means 'not observed'; 0 means 'observed as zero'.",
  "  Choose a policy (exclude / impute / interpolate), APPLY it to the frame BEFORE you fit or",
  "  score anything, and DECLARE the one you applied in preprocessing.missingValuePolicy.",
  "  Declaring without applying is the usual failure: sklearn estimators raise on NaN, so",
  "  `X = frame.dropna()` (exclude) or `X = frame.apply(lambda s: s.fillna(s.median()), axis=1)`",
  "  (impute) has to run first. Report how many rows or columns that touched.",
  "- Any random or iterative method must set random_state=0 and report it in method.",
  "- Respect semanticType: never average an entity_id or a category; a percent_fraction is",
  "  already 0..1, so do not divide it by 100 again.",
  "- Available: numpy, pandas, scipy, sklearn, and the Python maths modules.",
  "  NOT available: os, sys, io, subprocess, socket, requests, urllib, open(), eval(), exec().",
  "  The data is already in `data` — never read a file or a URL.",
  "- Prefer one clear method to three half-finished ones. A script that runs and returns less",
  "  is worth more than one that covers everything and raises.",
];

export const SANDBOX_SYSTEM_RULES = SANDBOX_RULE_LINES.join(String.fromCharCode(10));

/** §9 — the schema the script is written against, as compact prose. */
export function describeDataset(dataset: SandboxDataset): string {
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
    'The "subject" is the entity or column label FROM THE DATA — "Мезень", "Дек" — never a row',
    "number and never one of the ids in this prompt. An unlabelled finding cannot be reported.",
    "EVERY dimension above needs at least one entry, including the ones where nothing stood out —",
    'use values like {"count": 0} with subject "" to say so. A dimension you leave out reads as',
    "one you never ran.",
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

/**
 * §14/§38 — how much code this request is actually asking for.
 *
 * The old prompt ended with a flat "keep it under 60 lines" while the section
 * above it could be asking for six exploration dimensions and four compared
 * methods. That is not a tight budget, it is a contradiction, and the live run
 * showed how a model resolves one: it silently drops dimensions, which comes
 * back as §29's coverage failure, or it compresses until something raises.
 *
 * So the budget is derived from the same plan that sets the work. It is still
 * a ceiling — nothing here invites a longer script — but it is a ceiling the
 * request can actually fit inside.
 */
function lineBudget(plan: SandboxPlan): number {
  const dimensions = plan.explorationDimensions?.length ?? 0;
  const methods = plan.methodConstraints?.length ?? 0;
  const budget = 60 + Math.max(0, dimensions - 1) * 20 + (methods >= 2 ? methods * 15 : 0);
  return Math.min(budget, 160);
}

/** §13 — the plan, the data and (on a retry) the failure. */
export function buildCodeMessages(request: CodeRequest): readonly CodeMessage[] {
  const { plan, dataset } = request;
  // §18 — the planner's output IDs stay out of this message. They are handles
  // for binding a result to a declared output, they mean nothing to whoever
  // writes the code, and a model shown one under "your RESULT must contain
  // each of these" will use it as the key. Shape and description are the whole
  // contract; naming is governed by the NAMING rule in the system prompt.
  // The shape is named as the RESULT KEY it has to arrive under, which is the
  // only thing the script can act on. "one groups" was neither.
  //
  // Stage 27.x.1 §9 — and the key alone was not enough either. The full
  // contract is derived from the same requestedOutputs and printed as a
  // literal to fill in, because ENGINE_CONTRACT_ERROR was almost never a
  // wrong analysis: it was a right number filed under a name nobody had
  // stated. Naming it costs a dozen lines of prompt and no execution.
  const user = [
    "=== OBJECTIVE ===",
    plan.objective,
    // §23/§24 — the contract has to know whether gaps exist, because that is
    // what makes the missing-value declaration required rather than optional.
    ...renderResultContract(buildResultContract(plan), dataset.columns.some((c) => c.missingCount > 0)),
    ...methodSection(plan.methodConstraints ?? []),
    ...explorationSection(plan.explorationDimensions ?? []),
    ...(plan.assumptions && plan.assumptions.length > 0 ? ["", "=== ASSUMPTIONS ===", ...plan.assumptions.map((a) => `  - ${a}`)] : []),
    "",
    "=== THE DATA ===",
    describeDataset(dataset),
    ...repairSection(request),
    "",
    `Keep the script under ${lineBudget(plan)} lines. Return the Python script only.`,
  ].join("\n");

  return [
    { role: "system", content: SANDBOX_SYSTEM_RULES },
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
