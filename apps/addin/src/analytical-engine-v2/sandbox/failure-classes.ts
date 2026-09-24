/** §7 — the closed vocabulary of mechanical failures. */
export type FailureClass =
  /** Object/string data reached a numeric operation. */
  | "NON_NUMERIC_INPUT"
  /** A pandas method was called on a numpy array, or the reverse. */
  | "PANDAS_NUMPY_TYPE_MISMATCH"
  /** Two differently-indexed objects were combined. */
  | "INDEX_ALIGNMENT_ERROR"
  /** An estimator refused NaN (§23 — the forbidden repair is `fillna(0)`). */
  | "MISSING_VALUE_INCOMPATIBILITY"
  /** The matrix reaching an estimator has the wrong shape. */
  | "SHAPE_MISMATCH"
  /** A column or key that is not in the frame. */
  | "MISSING_COLUMN"
  /** An import the sandbox does not carry (§8). */
  | "UNSUPPORTED_LIBRARY"
  /** Everything else. Carries no hint — inventing one is guessing. */
  | "GENERIC_RUNTIME_ERROR";

interface ClassRule {
  readonly cls: Exclude<FailureClass, "GENERIC_RUNTIME_ERROR">;
  readonly match: RegExp;
}

// Order matters: the first match wins, so the more specific patterns lead.
const RULES: readonly ClassRule[] = [
  {
    cls: "MISSING_VALUE_INCOMPATIBILITY",
    match: /Input (?:X )?contains NaN|does not accept missing values|Input contains infinity|cannot convert float NaN/i,
  },
  {
    cls: "PANDAS_NUMPY_TYPE_MISMATCH",
    match: /'numpy\.ndarray' object has no attribute|'numpy\.(?:float64|int64|bool_)' object has no attribute|has no attribute '(?:fillna|dropna|isna|to_frame|iterrows|groupby)'/i,
  },
  {
    cls: "INDEX_ALIGNMENT_ERROR",
    match: /Unalignable boolean Series|cannot reindex|indexes have overlapping values|Length of values .* does not match length of index|lengths must match/i,
  },
  {
    cls: "NON_NUMERIC_INPUT",
    match: /ufunc 'isnan' not supported|Cannot cast ufunc .* from dtype\('O'\)|could not convert string to float|invalid literal for (?:int|float)|ufunc .* did not contain a loop|unsupported operand type\(s\) for .*: 'str'|dtype\('O'\) to dtype/i,
  },
  {
    cls: "SHAPE_MISMATCH",
    match: /Found array with \d+ sample|should be >= n_clusters|Number of labels is \d+|n_components=\d+ must be|shapes .* not aligned|Found input variables with inconsistent numbers/i,
  },
  {
    cls: "MISSING_COLUMN",
    match: /KeyError|None of \[Index\(|not in index|is not in list/i,
  },
  {
    cls: "UNSUPPORTED_LIBRARY",
    match: /ModuleNotFoundError|not available in the analytical sandbox|No module named/i,
  },
];

export function classifyFailure(message: string): FailureClass {
  return RULES.find((r) => r.match.test(message))?.cls ?? "GENERIC_RUNTIME_ERROR";
}

/**
 * §8 — what to do about it, in the generator's terms.
 *
 * Each hint names the prepared view that already solves the problem, because
 * after Stage 27.x the answer to most of these is "you were handed the right
 * object and used the wrong one".
 */
const HINTS: Readonly<Record<FailureClass, string>> = {
  NON_NUMERIC_INPUT:
    "The numerical operation received object/string data — `data` still holds the label column. " +
    "Use `numeric_data` (float DataFrame) or `X` (float ndarray) for the computation, and keep " +
    "`entity_data` only for mapping results back to the entities they describe. Both share `data`'s index.",
  PANDAS_NUMPY_TYPE_MISMATCH:
    "`X` is a numpy array and has no pandas methods — fillna, dropna, iterrows and .index do not exist on it. " +
    "Do the pandas work on `numeric_data` first, then take `.to_numpy()` (or use `X`) for the estimator. " +
    "Labels live in `entity_data`, so nothing is lost by converting late.",
  INDEX_ALIGNMENT_ERROR:
    "Two differently-indexed objects were combined. `data`, `numeric_data` and `entity_data` all carry the SAME " +
    "index — build the mask and the frame it selects from the same one, and do not reset or set an index in between.",
  MISSING_VALUE_INCOMPATIBILITY:
    "A missing value reached an estimator. Do NOT fill it with 0 — an empty cell is not an observed zero. " +
    "Apply the policy you declared BEFORE fitting, on the DataFrame: `numeric_data.dropna()` (exclude) or " +
    "`numeric_data.apply(lambda s: s.fillna(s.median()), axis=1)` (impute), then fit on that, and record what it " +
    "touched in preprocessing.missingValuePolicy.",
  SHAPE_MISMATCH:
    "The matrix reaching the estimator has the wrong shape or too few rows. Check what the missing-value policy " +
    "removed before fitting, and reduce the number of components or clusters to what the remaining rows support.",
  MISSING_COLUMN:
    "That key is not in the frame. Column names are exactly the ones listed under THE DATA, and `numeric_columns` / " +
    "`entity_columns` hold them at runtime — select by those names, never by a name you constructed or by values.",
  UNSUPPORTED_LIBRARY: "That library is not in the analytical sandbox. Use numpy, pandas, scipy or scikit-learn.",
  GENERIC_RUNTIME_ERROR: "",
};

/**
 * The runtime's message, plus the instruction its class calls for.
 *
 * An unclassified traceback comes back untouched. Silence is the correct
 * answer there: advice invented for a failure nobody has seen is how a repair
 * loop starts guessing.
 */
export function repairHintFor(message: string): string {
  const hint = HINTS[classifyFailure(message)];
  return hint === "" ? message : `${message}\n\n${hint}`;
}
