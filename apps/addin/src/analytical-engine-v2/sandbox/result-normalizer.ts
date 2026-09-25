import type { RequestedOutput, SandboxPlan, SandboxResult } from "./types.js";

export interface NormalizationNote {
  /** The shape whose single entry was renamed. */
  readonly shape: RequestedOutput["shape"];
  readonly from: string;
  readonly to: string;
}

export interface NormalizedResult {
  readonly result: SandboxResult;
  readonly notes: readonly NormalizationNote[];
  /** §10 — a mapping that needed a judgement this layer must not make. */
  readonly ambiguous: readonly string[];
}

/**
 * The plan's own name for an output, when it gave one worth using.
 *
 * Exported for `result-contract.ts`, which has to print the SAME name the
 * normalizer will later rename to. §14 forbids duplicating normalization logic
 * in the contract layer, and two copies of this predicate drifting apart is
 * exactly the failure that rule describes: the prompt would ask for one key
 * and the normalizer would rename to another.
 */
export function plannedName(output: RequestedOutput): string | null {
  const name = output.description.trim();
  // A description is prose; only a single bare identifier is a NAME. Anything
  // with spaces is a sentence about the output, not a key it should carry.
  return /^[A-Za-z][A-Za-z0-9_]{1,60}$/.test(name) ? name : null;
}

/**
 * §9/§10 — rename the single unambiguous candidate, or report the ambiguity.
 *
 * Only `scalars` and `tables` are addressed by NAME downstream, so only those
 * can be misnamed in a way that matters. Series, groups, models and
 * diagnostics are matched by shape and position already.
 */
export function normalizeResult(plan: SandboxPlan, result: SandboxResult): NormalizedResult {
  const notes: NormalizationNote[] = [];
  const ambiguous: string[] = [];

  const scalarOutputs = plan.requestedOutputs.filter((o) => o.shape === "scalar");
  const scalarNames = Object.keys(result.scalars);
  const wantedScalar = scalarOutputs.length === 1 ? plannedName(scalarOutputs[0]!) : null;

  let scalars = result.scalars;
  if (wantedScalar && !scalarNames.includes(wantedScalar)) {
    if (scalarNames.length === 1) {
      const from = scalarNames[0]!;
      scalars = { [wantedScalar]: result.scalars[from]! };
      notes.push({ shape: "scalar", from, to: wantedScalar });
    } else if (scalarNames.length > 1) {
      ambiguous.push(
        `the plan asks for one scalar named "${wantedScalar}" and the analysis returned ${scalarNames.length} ` +
          `(${scalarNames.join(", ")}); return the one that answers the objective under that name, or say which is which`,
      );
    }
  }

  const tableOutputs = plan.requestedOutputs.filter((o) => o.shape === "table");
  const wantedTable = tableOutputs.length === 1 ? plannedName(tableOutputs[0]!) : null;
  let tables = result.tables;
  if (wantedTable && result.tables.length === 1 && result.tables[0]!.name !== wantedTable) {
    const from = result.tables[0]!.name;
    tables = [{ ...result.tables[0]!, name: wantedTable }];
    notes.push({ shape: "table", from, to: wantedTable });
  }

  if (notes.length === 0) return { result, notes, ambiguous };
  return { result: { ...result, scalars, tables }, notes, ambiguous };
}
