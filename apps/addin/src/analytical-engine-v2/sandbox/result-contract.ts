import { plannedName } from "./result-normalizer.js";
import type { RequestedOutput, SandboxPlan } from "./types.js";

/**
 * §9 — one requested output, as the serialization step has to see it.
 *
 * `name` is present only when the plan actually gave a usable one. A planner
 * description is prose ("the December total"), and prose is not a key — the
 * NAMING rule in the system prompt governs those, and inventing a key here
 * from a sentence would put a fabricated identifier in front of a reader,
 * which is the «a1» incident with the polarity reversed.
 */
export interface ContractEntry {
  readonly shape: RequestedOutput["shape"];
  /** The RESULT key this output must arrive under. */
  readonly key: string;
  /** The exact entry name, when the plan named one; otherwise the generator picks. */
  readonly name: string | null;
  readonly description: string;
  /** What a value of this shape has to look like, in Python terms. */
  readonly structure: string;
}

export interface ResultContract {
  readonly entries: readonly ContractEntry[];
}

/**
 * §29 — the plan's shape vocabulary, spelled as the RESULT key it lands in.
 *
 * `validateAgainstPlan` checks exactly these keys, so this table is what makes
 * the coverage check and the prompt say the same thing.
 */
const SHAPE_KEY: Readonly<Record<RequestedOutput["shape"], string>> = {
  table: "tables",
  series: "series",
  groups: "groups",
  scalar: "scalars",
  model: "models",
  diagnostic: "diagnostics",
};

/**
 * §10 — the structure per shape, generated from the shape alone.
 *
 * The brief lists a wider vocabulary than this system has (`entity_set`,
 * `row_set`, `structured_object`, …). Those are not omissions: the planner's
 * `RequestedOutput["shape"]` is a six-member union, a planner cannot ask for
 * anything outside it, and widening that union would be the planner change §1
 * rules out. Each of the brief's names maps onto one of the six — an entity
 * set is `groups`, a row set is a `table`, a model summary is `models` — and
 * the mapping is the contract below.
 */
const SHAPE_STRUCTURE: Readonly<Record<RequestedOutput["shape"], string>> = {
  table: 'a pandas DataFrame, or {"columns": [str], "rows": [[value]]}',
  series: 'a pandas Series, or {"index": [label], "values": [number]}',
  groups: 'a LIST of {"label": str, "members": [str], "profile": {str: float}} — members are labels from the data',
  scalar: "a single float — not a dict, not a list, not a one-row table",
  model: "a LIST of dicts of plain numbers summarising a fitted model",
  diagnostic: "a dict of quality measures: {str: float} — silhouette, r2, p-value",
};

/** §10 — the contract, derived from the plan and nothing else. */
export function buildResultContract(plan: SandboxPlan): ResultContract {
  return {
    entries: plan.requestedOutputs.map((output) => ({
      shape: output.shape,
      key: SHAPE_KEY[output.shape],
      name: plannedName(output),
      description: output.description,
      structure: SHAPE_STRUCTURE[output.shape],
    })),
  };
}

/**
 * §9/§11 — the contract as the code generator reads it.
 *
 * Printed as a literal to fill in, because that is the form a serialization
 * step can be checked against. The §11 separation is stated right here rather
 * than in the system prompt: analysis first, then collect, then serialize —
 * so no analytical variable has to be named after an output field.
 */
export function renderResultContract(contract: ResultContract, hasGaps = false): readonly string[] {
  if (contract.entries.length === 0) return [];
  // The contract lists what the plan REQUIRES. It used to open with "Return
  // exactly this, and nothing else at the top level", and that sentence cost
  // §24 its declaration rate: `preprocessing` is not a requested output, so it
  // was not in the printed literal, so models obeying the instruction dropped
  // it. Measured across five runs, the missing-value policy went from being
  // declared by 98% of completed analyses to 75%, and the §44 counter for an
  // undeclared policy went from 0 to 4.
  //
  // A contract that suppresses a safety declaration is not a tighter contract,
  // it is a hole with a schema. The wording now says what it means — these
  // keys are REQUIRED, others are allowed — and the keys the system prompt
  // asks for are printed here too, so the two messages cannot disagree.
  const lines: string[] = [
    "",
    "=== RESULT CONTRACT ===",
    "RESULT must contain exactly these keys, with exactly these shapes:",
    "",
    "RESULT = {",
  ];

  const byKey = new Map<string, ContractEntry[]>();
  for (const entry of contract.entries) {
    const bucket = byKey.get(entry.key) ?? [];
    bucket.push(entry);
    byKey.set(entry.key, bucket);
  }

  for (const [key, entries] of byKey) {
    if (key === "groups" || key === "models") {
      lines.push(`    "${key}": ${entries[0]!.structure},   # ${entries.map((e) => e.description).join(" / ")}`);
      continue;
    }
    const inner = entries
      .map((e) => `        ${e.name ? `"${e.name}"` : "<name it after what it holds>"}: ${e.structure},   # ${e.description}`)
      .join("\n");
    lines.push(`    "${key}": {`, inner, "    },");
  }

  lines.push('    "method": {"name": str, "parameters": dict, "random_state": int | None},');
  // §23/§24 — the declaration is part of the contract, not an optional extra.
  // Printed with its shape whenever the data HAS gaps, because that is when
  // omitting it is a §44 violation rather than merely tidy.
  if (hasGaps) {
    lines.push(
      '    "preprocessing": {"missingValuePolicy": {"method": "exclude" | "impute" | "interpolate",',
      '                       "rationale": str, "affectedRows": int, "affectedColumns": [str]}},',
      "    #  ^ REQUIRED: this table has empty cells. Apply the policy BEFORE you fit or score,",
      "    #    and never fill a gap with 0. Omitting this fails the result even if the numbers are right.",
    );
  }
  lines.push(
    "}",
    "",
    "You MAY also add \"diagnostics\", \"warnings\", \"findings\" and \"preprocessing\" — they are never",
    "a substitute for the keys above, and never wrapped around them. Do not invent any OTHER",
    "top-level key, and do not nest the whole result inside one.",
    "",
    "Write the analysis first and keep its variables named after the ANALYSIS. Then, in the last",
    "few lines, copy the values you computed into the structure above. Do not rename an analytical",
    "variable to match an output field, and do not restructure the analysis to fit the contract.",
  );
  return lines;
}

/** §12 — the contract, compact enough to quote inside a repair message. */
export function contractSummary(contract: ResultContract): string {
  return contract.entries
    .map((e) => `RESULT["${e.key}"]${e.name ? `["${e.name}"]` : ""} = ${e.structure}   (${e.description})`)
    .join("\n");
}

/**
 * §12 — the analysis worked; only the serialization did not.
 *
 * Told apart from a failed analysis by one question: did the script return
 * ANYTHING measured? A run that produced a table, a scalar, a series, a group,
 * a model, a diagnostic or a finding computed something — it just put it
 * somewhere the plan did not name. A run that returned an empty envelope did
 * not get that far, and telling it "do not change the analytical method" would
 * be advice about a method that never ran.
 *
 * This is the distinction that makes §12's cheap repair safe. Everything it
 * changes is which INSTRUCTION the generator gets; the budget, the loop and
 * the validators are untouched.
 */
export function producedSomething(counts: {
  readonly tables: number;
  readonly scalars: number;
  readonly series: number;
  readonly groups: number;
  readonly models: number;
  readonly diagnostics: number;
  readonly findings: number;
}): boolean {
  return (
    counts.tables > 0 ||
    counts.scalars > 0 ||
    counts.series > 0 ||
    counts.groups > 0 ||
    counts.models > 0 ||
    counts.diagnostics > 0 ||
    counts.findings > 0
  );
}

/**
 * §12 — the repair message for a result that computed the right thing badly
 * filed.
 *
 * §13 asks whether the already-computed variables can be re-serialized without
 * re-running the analysis. In this runtime they cannot, and the reason is
 * worth recording rather than rediscovering: `__sa_run` builds a fresh
 * namespace per execution and discards it, by design — that is what makes one
 * analysis unable to see another's state. Keeping the namespace alive between
 * attempts would be exactly the "persistent hidden state" §13 forbids
 * introducing for an optimisation, and it would also mean a repaired script
 * could silently inherit a variable it never defined.
 *
 * So the repair re-executes, as §13 says to when the runtime does not support
 * retention safely. What this saves is not the execution: it is the ANALYSIS
 * being rewritten. The instruction below is the whole mechanism — keep every
 * line that produced a number, change only the last few.
 */
export function reserializationHint(contract: ResultContract, problems: readonly string[]): string {
  return [
    "The analytical computation completed, but the returned result does not match the declared output contract.",
    "",
    `What is missing: ${problems.join("; ")}.`,
    "",
    "Do not change the analytical method. Do not recompute anything. Keep every line that produced a number.",
    "Change ONLY the final RESULT assignment, so the values you already computed arrive under this exact contract:",
    "",
    contractSummary(contract),
  ].join("\n");
}
