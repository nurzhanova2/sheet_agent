// ---------------------------------------------------------------------------
// Stage 27 §19/§20/§21 — trying several methods, and saying why one won.
//
// Three rules, and they only work together.
//
// §19 — when the request asks for several approaches, several approaches must
// actually RUN. "Можно было бы также применить иерархическую кластеризацию" is
// a sentence, not an analysis, and it is the specific thing §19 forbids. The
// check for it is blunt on purpose: a method with no measured metric was
// mentioned, not executed, and does not count towards the comparison.
//
// §20 — the comparison is a STRUCTURE, not a paragraph: which methods ran,
// what each measured, which one was taken, and on what grounds.
//
// §21 — and the grounds may not be "the model liked this one". A criterion has
// to come from a closed vocabulary of things that can be OBSERVED, and each
// declared criterion has to be backed by a number that was actually computed.
// §21 permits the model an evaluative choice; it requires the model to show
// its ruler.
//
// Worth stating once, because it shapes the vocabulary below: a criterion is
// not a metric. `separation` is the criterion; silhouette, Davies-Bouldin and
// Calinski-Harabasz are three ways to measure it. §18 lists "silhouette" and
// "interpretability" side by side, but they are different kinds of thing — one
// is evidence, the other is what the evidence is for. Keeping them apart is
// what lets the narrator say "чётче разделяет группы" (a criterion, in words)
// while the trace keeps 0.62 (a metric, a number).
// ---------------------------------------------------------------------------

/**
 * §21 — the closed vocabulary of observable selection criteria.
 *
 * The first seven are §21's own list. The rest exist because §17 admits
 * regressions, statistical tests and anomaly detection into the sandbox, and a
 * regression comparison forced to justify itself in clustering words would
 * either lie or give up.
 */
export type SelectionCriterion =
  // — §21, verbatim —
  /** Meaningful cluster sizes: nothing degenerate, nothing swallowing the table. */
  | "cluster_sizes"
  /** Groups that are actually apart from one another. */
  | "separation"
  /** The same answer survives a different seed, sample or fold. */
  | "stability"
  /** Few, simple features do the differentiating. */
  | "feature_simplicity"
  /** Fewer groups or components for comparable quality. */
  | "parsimony"
  /** Members of a group resemble each other on profile, not only on distance. */
  | "profile_coherence"
  /** The answer does not hinge on how missing observations were treated. */
  | "missing_data_robustness"
  // — §17's other methods —
  /** How well the model reproduces the data it was fitted on. */
  | "fit_quality"
  /** Residuals behave the way the method assumes they do. */
  | "residual_behaviour"
  /** The effect is distinguishable from noise. */
  | "significance"
  /** The effect is large enough to matter, not merely detectable. */
  | "effect_size"
  /** Error on data the method did not see. */
  | "predictive_error";

export const SELECTION_CRITERIA: readonly SelectionCriterion[] = [
  "cluster_sizes",
  "separation",
  "stability",
  "feature_simplicity",
  "parsimony",
  "profile_coherence",
  "missing_data_robustness",
  "fit_quality",
  "residual_behaviour",
  "significance",
  "effect_size",
  "predictive_error",
];

const CRITERION_SET: ReadonlySet<string> = new Set<string>(SELECTION_CRITERIA);

/**
 * Spellings that mean one of the criteria, accepted without a repair cycle.
 *
 * Every entry here names something OBSERVABLE under a different word — mostly
 * the measure standing in for the thing it measures (`silhouette` for
 * separation), or a shorter synonym. None of them softens the gate.
 *
 * What is deliberately absent is the word §21 is aimed at. "interpretability",
 * "elegance", "makes more sense", "business_fit" have no entry and never will:
 * they are the vague grounds §21 exists to refuse, and the right response to
 * them is the repair message telling the model to say what it actually
 * observed — not a quiet translation into a criterion it did not measure.
 */
const CRITERION_ALIASES: Readonly<Record<string, SelectionCriterion>> = {
  silhouette: "separation",
  separation_score: "separation",
  cluster_size: "cluster_sizes",
  size_balance: "cluster_sizes",
  balanced_clusters: "cluster_sizes",
  robustness: "stability",
  reproducibility: "stability",
  simplicity: "feature_simplicity",
  few_features: "feature_simplicity",
  n_clusters: "parsimony",
  low_k: "parsimony",
  coherence: "profile_coherence",
  profile_consistency: "profile_coherence",
  missing_robustness: "missing_data_robustness",
  missing_sensitivity: "missing_data_robustness",
  r2: "fit_quality",
  goodness_of_fit: "fit_quality",
  residuals: "residual_behaviour",
  p_value: "significance",
  statistical_significance: "significance",
  effect: "effect_size",
  cv_error: "predictive_error",
};

export function isSelectionCriterion(value: unknown): value is SelectionCriterion {
  return typeof value === "string" && CRITERION_SET.has(value);
}

/**
 * §21 — read a criterion the generated code declared, or refuse it.
 *
 * `null` means the word is not a criterion this system recognises as
 * observable, which is a failure the repair loop reports rather than a value
 * to be guessed at.
 */
export function readCriterion(value: unknown): SelectionCriterion | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (CRITERION_SET.has(key)) return key as SelectionCriterion;
  return CRITERION_ALIASES[key] ?? null;
}

/**
 * §21 — what counts as having MEASURED each criterion.
 *
 * These are matched against the NAMES of the numbers the analysis returned, so
 * a declared criterion has to correspond to something on the page. The lists
 * are generous about naming (`silhouette`, `silhouette_avg` and
 * `mean_silhouette` all read as separation) and deliberately not generous
 * about absence: a criterion no number speaks to is rejected rather than
 * accepted on trust, which is §21's entire point.
 */
const CRITERION_EVIDENCE: Readonly<Record<SelectionCriterion, readonly string[]>> = {
  cluster_sizes: ["size", "smallest", "largest", "balance", "member", "count", "n"],
  separation: ["silhouette", "separation", "davies", "bouldin", "calinski", "harabasz", "between", "margin", "gap", "distance", "dunn"],
  stability: ["stability", "ari", "rand", "jaccard", "agreement", "bootstrap", "resample", "consistency", "seed"],
  feature_simplicity: ["feature", "dim", "variable", "loading", "predictor", "sparsity"],
  parsimony: ["k", "cluster", "component", "group", "term", "aic", "bic", "complexity"],
  profile_coherence: ["coherence", "cohesion", "inertia", "within", "wcss", "compact", "homogeneity", "explained"],
  missing_data_robustness: ["missing", "nan", "complete", "coverage", "imputed", "dropped", "sensitivity"],
  fit_quality: ["r2", "rsquared", "adj", "accuracy", "auc", "loglik", "deviance", "f1", "fit"],
  residual_behaviour: ["residual", "rmse", "mae", "mse", "durbin", "heteroskedastic", "normality", "shapiro", "error"],
  significance: ["p", "pvalue", "pval", "alpha", "ci", "confidence", "tstat", "zstat", "chi2", "significance"],
  effect_size: ["effect", "cohen", "eta", "beta", "coef", "slope", "correlation", "r", "d"],
  predictive_error: ["rmse", "mae", "mape", "cv", "holdout", "oob", "test", "validation"],
};

/**
 * Split a metric name the way a person reads it: `meanSilhouette`,
 * `mean_silhouette` and `mean-silhouette` are the same two words.
 */
function metricTokens(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Does this number's name speak to that criterion?
 *
 * Short keywords (`k`, `p`, `r`, `n`, `d`) match a whole token only, because a
 * substring rule would let `parameters` prove parsimony and `sharpe` prove
 * significance. Longer ones may match inside a token, so `silhouette_avg` and
 * `avg_silhouette_score` both land.
 */
function evidences(criterion: SelectionCriterion, metricName: string): boolean {
  const tokens = metricTokens(metricName);
  const flat = tokens.join("");
  return CRITERION_EVIDENCE[criterion].some((kw) => (kw.length <= 2 ? tokens.includes(kw) : flat.includes(kw)));
}

// --- §20: the structure ----------------------------------------------------

/** §20 — one method that actually ran, with what it measured. */
export interface ComparedMethod {
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** §19 — the measurements. A method with none was mentioned, not executed. */
  readonly metrics: Readonly<Record<string, number>>;
  /** Why this method fits the data poorly, in the code's own structured terms. */
  readonly warnings: readonly string[];
  /** §20/§32 — the stored result this method produced, once it has one. */
  readonly resultRef?: string;
}

/**
 * §20 — the comparison.
 *
 * `selectionCriteria` is an enum and `selectionEvidence` is numbers; neither is
 * prose. That is §28 holding at one more boundary: generated Python may say it
 * chose k-means for `separation` and that the silhouette was 0.62, and may not
 * say that "k-means gave the cleanest business segmentation".
 */
export interface MethodComparison {
  readonly methods: readonly ComparedMethod[];
  readonly selectedMethod: string;
  readonly selectionCriteria: readonly SelectionCriterion[];
  readonly selectionEvidence: Readonly<Record<string, number>>;
}

/** A criterion, in words, for the method note the narrator is given (§21/§60). */
export function criterionLabel(criterion: SelectionCriterion, locale: "ru" | "en"): string {
  const ru: Record<SelectionCriterion, string> = {
    cluster_sizes: "размеры групп осмысленные, без вырожденных",
    separation: "группы отчётливо отделены друг от друга",
    stability: "результат устойчив к смене выборки или начального приближения",
    feature_simplicity: "различие объясняется небольшим числом простых признаков",
    parsimony: "меньше групп при сопоставимом качестве",
    profile_coherence: "внутри группы объекты похожи по профилю",
    missing_data_robustness: "результат мало зависит от обработки пропусков",
    fit_quality: "модель лучше описывает данные",
    residual_behaviour: "остатки ведут себя так, как предполагает метод",
    significance: "эффект отличим от шума",
    effect_size: "величина эффекта заметная, а не просто различимая",
    predictive_error: "меньше ошибка на данных, которых метод не видел",
  };
  const en: Record<SelectionCriterion, string> = {
    cluster_sizes: "group sizes are meaningful, none degenerate",
    separation: "the groups are clearly apart from one another",
    stability: "the result survives a different sample or starting point",
    feature_simplicity: "a few simple features account for the difference",
    parsimony: "fewer groups for comparable quality",
    profile_coherence: "members of a group resemble each other on profile",
    missing_data_robustness: "the result barely depends on how gaps were handled",
    fit_quality: "the model describes the data better",
    residual_behaviour: "the residuals behave as the method assumes",
    significance: "the effect is distinguishable from noise",
    effect_size: "the effect is sizeable, not merely detectable",
    predictive_error: "lower error on data the method did not see",
  };
  return locale === "ru" ? ru[criterion] : en[criterion];
}

// --- §19/§21: the checks ---------------------------------------------------

/** §19 — a method counts as EXECUTED only if it measured something. */
export function executedMethods(comparison: MethodComparison): readonly ComparedMethod[] {
  return comparison.methods.filter((m) => m.name.trim() !== "" && Object.values(m.metrics).some((v) => Number.isFinite(v)));
}

/**
 * §19/§20/§21 — is this comparison real?
 *
 * Returns the problems in the generator's own terms, because every one of them
 * is repairable and the repair loop hands these straight back (§66). Silence
 * means the comparison may be shown to a person.
 *
 * Note what is NOT checked: whether the executed methods are the ones the
 * planner named. Matching "hierarchical clustering" against a run that reports
 * itself as "Agglomerative (ward)" needs a synonym table that would be wrong
 * for every method added after it was written, and failing an analysis over a
 * naming mismatch is worse than the problem. §19 asks that several methods be
 * tried and measured; that is what is enforced. The declared names still reach
 * the generator as constraints, and the drift is visible in the trace.
 */
export function validateMethodComparison(comparison: MethodComparison): readonly string[] {
  const problems: string[] = [];
  const executed = executedMethods(comparison);

  // §19 — the whole point. Two named methods and one set of numbers means the
  // second was described rather than run.
  if (executed.length < 2) {
    const mentioned = comparison.methods.length - executed.length;
    problems.push(
      `only ${executed.length} of the ${comparison.methods.length} methods in method_comparison reported any metrics` +
        (mentioned > 0 ? `; ${mentioned} were named without a single measurement, which does not count as having tried them` : "") +
        "; run each method and report its metrics",
    );
  }

  const names = new Set(executed.map((m) => m.name));
  if (!names.has(comparison.selectedMethod)) {
    problems.push(
      `method_comparison.selected is "${comparison.selectedMethod}", which is not among the methods that ran (${[...names].join(", ") || "none"})`,
    );
  }

  if (comparison.selectionCriteria.length === 0) {
    problems.push(`method_comparison gives no criteria for choosing "${comparison.selectedMethod}"; name them from the allowed list`);
  }

  // §21 — every criterion must point at a number that exists. The selected
  // method's own metrics count, so a comparison need not repeat the silhouette
  // it already reported.
  const selected = executed.find((m) => m.name === comparison.selectedMethod);
  const available = [...Object.keys(comparison.selectionEvidence), ...Object.keys(selected?.metrics ?? {})];
  for (const declared of comparison.selectionCriteria) {
    // The envelope arrives from Python, so what is typed here as a criterion
    // may at runtime be any string the model wrote. This is where "the model
    // liked this one" is actually stopped.
    const criterion = readCriterion(declared);
    if (criterion === null) {
      problems.push(`"${String(declared)}" is not an observable selection criterion; use one of: ${criteriaForPrompt()}`);
      continue;
    }
    if (!available.some((name) => evidences(criterion, name))) {
      problems.push(
        `criterion "${criterion}" is declared but nothing measures it — put a number for it in selection_evidence ` +
          `(something named like ${CRITERION_EVIDENCE[criterion].slice(0, 3).join(", ")})`,
      );
    }
  }

  return problems;
}

/** §14 — the vocabulary, as the code generator is told it. */
export function criteriaForPrompt(): string {
  return SELECTION_CRITERIA.join(", ");
}
