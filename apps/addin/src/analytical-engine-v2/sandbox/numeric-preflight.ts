import type { FailureClass } from "./failure-classes.js";
import type { SandboxDataset } from "./types.js";

/** Estimator and numeric entry points whose first argument must be numeric. */
const NUMERIC_CALLS = [
  "fit",
  "fit_transform",
  "fit_predict",
  "transform",
  "predict",
  "score",
  "silhouette_score",
  "calinski_harabasz_score",
  "davies_bouldin_score",
  "linkage",
  "pdist",
  "cdist",
  "lstsq",
  "polyfit",
  "isnan",
  "nanmean",
  "nanstd",
  "corrcoef",
  "cov",
] as const;

/**
 * Is raw `data` passed straight into a numeric call?
 *
 * Matched on the ARGUMENT being exactly `data` — `data)` or `data,` — so
 * `fit(data[numeric_columns])`, `fit(data.select_dtypes("number"))` and
 * `fit(numeric_data)` all pass untouched.
 */
const RAW_HANDOFF = new RegExp(String.raw`\.?\b(?:${NUMERIC_CALLS.join("|")})\s*\(\s*data\s*[,)]`, "u");

/**
 * §4 — pandas-only members, called on something that is a numpy array.
 *
 * Every one of these exists on a DataFrame and does not exist on an ndarray,
 * so reaching for it on `X` is unambiguously the boundary error. `.loc` and
 * `.iloc` are matched with their bracket because that is how they are used;
 * `.index` and `.columns` are attributes and are matched bare.
 *
 * What is deliberately NOT here: `mean`, `std`, `sum`, `min`, `max`, `shape`,
 * `T`, `reshape`, `astype`, `any`, `all`, `argmin`, `argmax`. Those exist on
 * BOTH types, so `X.mean(axis=0)` is correct numpy and must never be refused.
 */
const PANDAS_ONLY_METHODS = [
  "fillna",
  "dropna",
  "isna",
  "notna",
  "isnull",
  "notnull",
  "groupby",
  "iterrows",
  "itertuples",
  "to_frame",
  "to_dict",
  "set_index",
  "reset_index",
  "sort_values",
  "value_counts",
  "idxmax",
  "idxmin",
  "nlargest",
  "nsmallest",
  "interpolate",
  "rolling",
  "apply",
  "applymap",
  "merge",
  "join",
  "pivot_table",
  "describe",
] as const;

const PANDAS_ONLY_ATTRS = ["index", "columns", "values", "dtypes", "empty", "iat", "at"] as const;

/**
 * §4/§7 — `X.<pandas member>`, and nothing else.
 *
 * The receiver is pinned to the bare identifier `X` with a non-word guard on
 * both sides, so `X_scaled.fillna(...)`, `MAX.index` and `df.X.groupby(...)`
 * are all outside the pattern. That narrowness is the point: this may only
 * fire where the type is known from the runtime's own construction.
 */
const PANDAS_ON_X = new RegExp(
  String.raw`(?<![\w.])X\s*\.\s*(?:(?:${PANDAS_ONLY_METHODS.join("|")})\s*\(|(?:loc|iloc)\s*\[|(?:${PANDAS_ONLY_ATTRS.join("|")})(?![\w(]))`,
  "u",
);

/**
 * §7 — has the script taken `X` away from us?
 *
 * The runtime binds `X` to a float ndarray, which is what licenses the check
 * above. A script is free to rebind it — `X = numeric_data.dropna()` is
 * perfectly good code, and on THAT `X` every pandas method is legal. So a
 * rebinding whose right-hand side is not visibly an array switches the check
 * off rather than risking a false rejection.
 *
 * `X = frame.values`, `X = numeric_data.to_numpy()`, `X = np.array(...)` and
 * `X = np.asarray(...)` stay arrays, so they keep the check on.
 */
const X_REBOUND = /^[ \t]*X[ \t]*(?::[^=\n]+)?=(?![=])([^\n]*)$/m;
// `X = X[...]` is still an array — whatever X was, subscripting it does not
// make it a DataFrame — so that spelling keeps the check on rather than
// disarming it on the one line most likely to contain the bug.
const STILL_ARRAY = /\.values\b|\.to_numpy\s*\(|\bnp\.|\bnumpy\.|(?<![\w.])X(?![\w])/u;

function receiverIsKnownArray(code: string): boolean {
  const rebind = X_REBOUND.exec(code);
  if (!rebind) return true;
  return STILL_ARRAY.test(rebind[1] ?? "");
}

/**
 * §6 — a pandas boolean mask indexed straight into the numpy matrix.
 *
 * `mask = numeric_data["A"] > 0` then `X[mask]` is the alignment trap: pandas
 * carries an index, numpy carries positions, and the two agree right up until
 * a row is dropped somewhere in between. Detected only in the STATICALLY
 * OBVIOUS form — a name assigned from a comparison on a known pandas object,
 * then used as the whole subscript of `X` — because anything looser starts
 * refusing correct code.
 *
 * `X[mask.to_numpy()]`, `X[mask.values]` and `X[:, 0]` are all fine and do not
 * match: the first two are the fix, the third has a comma.
 */
const PANDAS_OBJECTS = String.raw`(?:numeric_data|entity_data|data)`;
const MASK_ASSIGN = new RegExp(String.raw`^[ \t]*(\w+)[ \t]*=[ \t]*(?![^\n]*(?:\.values\b|\.to_numpy\s*\())[^\n]*${PANDAS_OBJECTS}\b[^\n]*(?:[<>]=?|[=!]=|\.isin\s*\(|\.notna\s*\(|\.isna\s*\()[^\n]*$`, "gmu");

function pandasMaskOnX(code: string): string | null {
  const masks = new Set<string>();
  MASK_ASSIGN.lastIndex = 0;
  for (const match of code.matchAll(MASK_ASSIGN)) {
    const name = match[1];
    if (name && name !== "X") masks.add(name);
  }
  for (const name of masks) {
    if (new RegExp(String.raw`(?<![\w.])X\s*\[\s*${name}\s*\]`, "u").test(code)) return name;
  }
  // The inline spelling, which needs no assignment at all.
  if (new RegExp(String.raw`(?<![\w.])X\s*\[\s*${PANDAS_OBJECTS}\b[^\],]*\]`, "u").test(code)) return "the inline mask";
  return null;
}

/** §5 — the codes the executor turns into a typed, repairable failure. */
export type PreflightCode = "NON_NUMERIC_FEATURE_INPUT" | "PANDAS_METHOD_ON_NDARRAY" | "PANDAS_MASK_ON_NDARRAY";

export interface PreflightProblem {
  readonly code: PreflightCode;
  readonly message: string;
  readonly repairHint: string;
  /** §31 — which attempt-level class this counts as, before it ever runs. */
  readonly failureClass: FailureClass;
  /** §5 — the structured repair context, for the trace and the diagnostics. */
  readonly context?: {
    readonly receiver: string;
    readonly receiverType: string;
    readonly availableAlternative: string;
  };
}

/** §5 — the instruction, stated once so both pandas checks read the same. */
const BOUNDARY_INSTRUCTION =
  "Perform pandas preprocessing on numeric_data. Use X only for NumPy/scipy/sklearn numerical operations.";

export function numericPreflight(code: string, dataset: SandboxDataset): PreflightProblem | null {
  const numeric = dataset.columns.filter((c) =>
    ["amount", "count", "percent_fraction", "percent_scaled", "ratio", "index"].includes(c.semanticType),
  );
  const entity = dataset.columns.filter((c) => ["metric_label", "entity_id", "category", "text"].includes(c.semanticType));
  // Nothing better to point at: no advice. Both checks below name
  // `numeric_data` as the fix, and naming a view that does not exist is worse
  // than saying nothing.
  if (numeric.length === 0) return null;

  const numericNames = numeric.map((c) => c.name).join(", ");
  const entityNames = entity.map((c) => c.name).join(", ");

  // §3 — Stage 27.x's check, unchanged. Needs a text column to trip over.
  if (entity.length > 0 && RAW_HANDOFF.test(code)) {
    return {
      code: "NON_NUMERIC_FEATURE_INPUT",
      failureClass: "NON_NUMERIC_INPUT",
      message: `a numerical operation was given the whole table, which holds the label column${entity.length > 1 ? "s" : ""} ${entityNames}`,
      repairHint:
        "The numerical operation received object/string data.\n\n" +
        `Available:\nnumeric_data: pandas.DataFrame (${numericNames})\nX: numpy.ndarray[float]\nentity_data: labels (${entityNames})\n\n` +
        "Use numeric_data or X for the computation. Keep entity_data only for mapping output labels. " +
        "All three carry the same index as data, so results line up without a merge.",
      context: { receiver: "data", receiverType: "pandas.DataFrame (mixed dtypes)", availableAlternative: "numeric_data" },
    };
  }

  // §7 — everything past here types its receiver from the runtime's own
  // construction. A script that rebound `X` gets no opinion from us.
  if (!receiverIsKnownArray(code)) return null;

  // §4/§5 — a pandas method on the numpy matrix.
  const pandasCall = PANDAS_ON_X.exec(code);
  if (pandasCall) {
    const member = pandasCall[0].replace(/^X\s*\.\s*/u, "").replace(/\s*[([]$/u, "");
    return {
      code: "PANDAS_METHOD_ON_NDARRAY",
      failureClass: "PANDAS_NUMPY_TYPE_MISMATCH",
      message: `\`X.${member}\` is a pandas member called on a numpy array`,
      repairHint:
        `\`X\` is numpy.ndarray[float]. It has no \`${member}\` — that belongs to pandas.\n\n` +
        `Available:\nnumeric_data: pandas.DataFrame (${numericNames}) — all pandas methods work here\n` +
        "X: numpy.ndarray[float] — for sklearn, scipy and numpy only\n\n" +
        `${BOUNDARY_INSTRUCTION}\n` +
        "Do the pandas step on numeric_data first, then pass `.to_numpy()` (or the prepared X, if you changed nothing) to the estimator.",
      context: { receiver: "X", receiverType: "numpy.ndarray", availableAlternative: "numeric_data" },
    };
  }

  // §6 — a pandas boolean mask indexed into the numpy matrix.
  const mask = pandasMaskOnX(code);
  if (mask) {
    return {
      code: "PANDAS_MASK_ON_NDARRAY",
      failureClass: "INDEX_ALIGNMENT_ERROR",
      message: `\`${mask}\` is a pandas boolean Series used to index the numpy array X`,
      repairHint:
        "A pandas boolean mask carries an index; X carries positions. They agree until a row is dropped, and then they silently do not.\n\n" +
        "Convert aligned pandas mask to NumPy boolean values explicitly, or filter numeric_data before producing the numerical matrix.\n\n" +
        `Either \`X[${mask === "the inline mask" ? "mask" : mask}.to_numpy()]\`, or — usually better — filter first: ` +
        "`kept = numeric_data[mask]` and then `kept.to_numpy()`.\n" +
        `${BOUNDARY_INSTRUCTION}`,
      context: { receiver: "X", receiverType: "numpy.ndarray", availableAlternative: "numeric_data" },
    };
  }

  return null;
}
