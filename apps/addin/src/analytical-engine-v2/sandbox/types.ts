import type { CellValue } from "@sheet-agent/application";
import type { ResultId } from "../types.js";
import type { ExplorationDimension } from "./exploration.js";
import type { MethodComparison } from "./method-comparison.js";

// --- §9: what the sandbox is given -----------------------------------------

/**
 * §9 — how a column should be READ, independent of its storage type.
 *
 * This is the sandbox's half of the §73 data-semantics contract: generated
 * code is told that a column is a percentage stored as a fraction, or an
 * identifier that merely looks numeric, so it cannot average a customer ID or
 * multiply a share by 100 twice.
 */
export type SemanticType =
  | "metric_label"
  | "entity_id"
  | "category"
  | "period"
  | "amount"
  | "count"
  | "percent_fraction"
  | "percent_scaled"
  | "ratio"
  | "index"
  | "text"
  | "unknown";

export interface DatasetColumn {
  readonly name: string;
  readonly semanticType: SemanticType;
  /** The unit as the workbook spells it, when the label carries one. */
  readonly unit?: string;
  /** §23 — how many cells in this column hold no observation. */
  readonly missingCount: number;
  /**
   * §25 — how many hold a RECORDED zero. Counted apart from missing on
   * purpose: the whole point of §25 is that these two are different facts and
   * conflating them is how "0" becomes "нет продаж".
   */
  readonly zeroCount: number;
}

/**
 * §9 — the analytical dataset, prepared by the engine and read-only inside.
 *
 * `rows` holds `null` for a missing observation and never a substituted zero
 * (§23). That is not a formatting choice: once a gap has been filled with 0 on
 * the way in, no policy declared later can tell it apart from a real zero.
 */
export interface SandboxDataset {
  readonly datasetId: string;
  /** The result this dataset was built from, for lineage (§32). */
  readonly tableRef: string;
  readonly sheet: string;
  readonly sourceRange: string;
  /** §69 — the workbook version this was read at. Checked before committing. */
  readonly freshnessToken: string;
  readonly columns: readonly DatasetColumn[];
  readonly rows: readonly (readonly CellValue[])[];
  /** §10 — set when the engine had to reduce the data, and how. Never silent. */
  readonly reduction?: DatasetReduction;
  /** Periods in canonical order, when the table has a temporal axis. */
  readonly periods?: readonly string[];
}

/** §10 — a recorded, non-silent reduction of the input. */
export interface DatasetReduction {
  readonly method: "sampled" | "truncated" | "aggregated";
  readonly originalRows: number;
  readonly keptRows: number;
  readonly rationale: string;
}

/**
 * §10 — hard input bounds.
 *
 * The defaults are a starting point to be MEASURED (§10 says so explicitly),
 * not a claim about what is safe. They are sized so a full task-pane-sized
 * table passes untouched and a pasted database extract does not.
 */
export interface DatasetBounds {
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCells: number;
  readonly maxSerializedBytes: number;
}

export const DATASET_BOUNDS: DatasetBounds = {
  maxRows: 5000,
  maxColumns: 120,
  maxCells: 120_000,
  maxSerializedBytes: 4_000_000,
};

// --- §12: what it is allowed to consume ------------------------------------

/** §12 — every limit the runtime enforces. Measured before being finalised. */
export interface SandboxLimits {
  readonly executionTimeoutMs: number;
  readonly maxCodeLength: number;
  readonly maxAttempts: number;
  readonly maxOutputBytes: number;
  readonly maxArtifacts: number;
  readonly maxResultRows: number;
}

export const SANDBOX_LIMITS: SandboxLimits = {
  // §12 suggests 30–60s. The upper end is unusable inside a turn that already
  // spends ~40s in the planner, so the budget starts at the lower end and the
  // §87 latency measurement decides whether it can stay there.
  executionTimeoutMs: 30_000,
  maxCodeLength: 12_000,
  // §12/§66 — three ATTEMPTS means two repairs after the first failure.
  maxAttempts: 3,
  maxOutputBytes: 256_000,
  maxArtifacts: 8,
  maxResultRows: 500,
};

// --- §13: what the planner asks for ----------------------------------------

/**
 * §13 — the analysis REQUEST, stated before any code exists.
 *
 * The separation matters for §5. `objective` and `requestedOutputs` record
 * what the user asked for; if the code cannot deliver them, the turn fails
 * with a capability error rather than returning whatever the code did manage.
 * Without a written-down objective there is nothing to hold the result against
 * and "segmentation" quietly becomes "trend analysis".
 */
export interface SandboxPlan {
  /** What the analysis must achieve, in the planner's own words. */
  readonly objective: string;
  readonly datasetRefs: readonly string[];
  /** §13 — the outputs the answer needs; checked against what came back (§29). */
  readonly requestedOutputs: readonly RequestedOutput[];
  /** Assumptions the planner is making about the data. */
  readonly assumptions?: readonly string[];
  /** §18 — methods the planner commits to trying, named up front. */
  readonly methodConstraints?: readonly string[];
  /**
   * §36/§37 — the dimensions an open-ended exploration must cover.
   *
   * Present only for exploration. Its absence is what distinguishes "найди
   * что-нибудь необычное" from "кластеризуй продукты": the second has an
   * objective that names its own output, the first has to be given a shape
   * before it has one.
   */
  readonly explorationDimensions?: readonly ExplorationDimension[];
  readonly expectedArtifactTypes?: readonly ArtifactType[];
}

export interface RequestedOutput {
  readonly id: string;
  readonly description: string;
  /** Which part of the envelope must carry it, so §29 can check presence. */
  readonly shape: "table" | "scalar" | "series" | "groups" | "model" | "diagnostic";
}

export type ArtifactType = "chart_data" | "table" | "model_summary";

// --- §27: what comes back --------------------------------------------------

export type SandboxStatus = "ok" | "error";

/** §27 — a named table returned by the analysis. */
export interface SandboxTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
}

export interface SandboxSeries {
  readonly name: string;
  readonly index: readonly (string | number)[];
  readonly values: readonly (number | null)[];
}

export interface SandboxGroup {
  readonly label: string;
  readonly members: readonly string[];
  /** Structured profile — never a sentence (§28). */
  readonly profile?: Readonly<Record<string, number>>;
}

/**
 * §24 — how missing observations were handled, declared by the code itself.
 *
 * Required whenever anything was missing. §23 forbids the silent zero; this is
 * how the sandbox proves it did not take one, and what the narrator cites when
 * it has to say the analysis excluded rows.
 */
export interface MissingValuePolicy {
  readonly method: "exclude" | "impute" | "interpolate" | "zero_if_semantically_valid";
  readonly rationale: string;
  readonly affectedRows: number;
  readonly affectedColumns: readonly string[];
}

/** §26 — everything done to the data before the method saw it. */
export interface PreprocessingRecord {
  readonly droppedRows?: number;
  readonly droppedColumns?: readonly string[];
  readonly scaling?: string;
  readonly normalization?: string;
  readonly encoding?: string;
  readonly aggregation?: string;
  readonly sampling?: string;
  readonly missingValuePolicy?: MissingValuePolicy;
  /** Free-form steps, in execution order, for "Показать расчёт" (§63). */
  readonly steps?: readonly string[];
}

/**
 * §27 — a candidate observation the code believes it found.
 *
 * "Candidate" is the operative word. These do not reach the user: they are
 * verified (§31) and converted into VerifiedFindings first, which is what
 * keeps §28's line intact — generated Python may point at something
 * interesting, it may not tell the user what it means.
 */
export interface FindingCandidate {
  readonly kind: string;
  readonly subject: string;
  readonly values: Readonly<Record<string, number>>;
  readonly supporting?: Readonly<Record<string, unknown>>;
}

/** §30 — enough to re-run the analysis and get the same numbers. */
export interface MethodRecord {
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly randomState?: number;
}

/** §27/§64 — chart-ready DATA. Never markup, never script (§65). */
export interface SandboxArtifact {
  readonly type: ArtifactType;
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SandboxResult {
  readonly executionId: string;
  readonly status: SandboxStatus;
  readonly method?: MethodRecord;
  /**
   * §19/§20 — present when more than one method was tried.
   *
   * Separate from `method` rather than a list inside it, because the two
   * answer different questions: `method` is how the RESULT was produced and is
   * always needed for §30 reproducibility; this is why that method rather than
   * the others, and exists only when there were others.
   */
  readonly methodComparison?: MethodComparison;
  readonly tables: readonly SandboxTable[];
  readonly scalars: Readonly<Record<string, number>>;
  readonly series: readonly SandboxSeries[];
  readonly groups: readonly SandboxGroup[];
  readonly models: readonly Readonly<Record<string, unknown>>[];
  readonly diagnostics: Readonly<Record<string, unknown>>;
  readonly findingsCandidates: readonly FindingCandidate[];
  readonly warnings: readonly string[];
  readonly preprocessing?: PreprocessingRecord;
  /** §32 — which dataset, at which freshness, produced this. */
  readonly sourceLineage: SourceLineage;
  readonly artifacts: readonly SandboxArtifact[];
  readonly excludedEntities?: readonly { readonly entity: string; readonly reason: string }[];
}

export interface SourceLineage {
  readonly datasetIds: readonly string[];
  readonly sheet: string;
  readonly sourceRange: string;
  readonly freshnessToken: string;
  /** Engine results this analysis was composed with, for hybrid runs (§34). */
  readonly parentResultRefs?: readonly ResultId[];
}

// --- §68: how it fails ------------------------------------------------------

/**
 * §68 — the failure taxonomy.
 *
 * Each maps to a different thing the user should be told and a different thing
 * the system should do next, which is why they are not one "sandbox failed".
 * UNSAFE_CODE is never retried; SANDBOX_RUNTIME_ERROR usually is (§66).
 */
export type SandboxErrorCode =
  /** The generated code did not parse, or violated the AST contract (§15). */
  | "CODE_VALIDATION_ERROR"
  /** The code parsed and was safe, but asks for a capability we deny (§15). */
  | "UNSAFE_CODE"
  | "SANDBOX_TIMEOUT"
  | "SANDBOX_MEMORY_LIMIT"
  /** The code raised. Repairable (§66). */
  | "SANDBOX_RUNTIME_ERROR"
  /** It ran and returned something that is not a valid envelope (§29). */
  | "INVALID_RESULT"
  | "UNSUPPORTED_LIBRARY"
  | "DATA_TOO_LARGE"
  /** The workbook moved under the analysis (§69). */
  | "STALE_DATASET"
  /** The user cancelled; no result may commit (§70). */
  | "CANCELLED"
  /** The runtime could not start at all. */
  | "SANDBOX_UNAVAILABLE";

export interface SandboxError {
  readonly code: SandboxErrorCode;
  /** Developer-facing detail. Never shown raw to the user (§88). */
  readonly message: string;
  /** §66 — the concise structured feedback handed back to the code generator. */
  readonly repairHint?: string;
  /** Which line of generated code, when known. */
  readonly line?: number;
  /**
   * Stage 27.x.1 §31 — the attempt-level class, when it is known WITHOUT
   * having to re-read a traceback.
   *
   * `classifyFailure` reads the runtime's message and is right most of the
   * time; the preflight checks and the output-contract check KNOW their class
   * because they are the thing that decided it. Recording it here means the
   * taxonomy stops depending on a regex agreeing with a hint that was written
   * from the same rule two files away.
   */
  readonly failureClass?: string;
  /** §12 — which flavour of contract failure, when the class is not enough. */
  readonly subtype?: "OUTPUT_SHAPE_MISMATCH";
}

export type SandboxOutcome =
  | { readonly ok: true; readonly result: SandboxResult; readonly code: string; readonly attempts: number; readonly durationMs: number }
  | { readonly ok: false; readonly error: SandboxError; readonly code?: string; readonly attempts: number; readonly durationMs: number };

/** §66 — a failure the code generator is allowed to see and try to fix. */
export function isRepairable(code: SandboxErrorCode): boolean {
  return code === "SANDBOX_RUNTIME_ERROR" || code === "INVALID_RESULT" || code === "CODE_VALIDATION_ERROR";
}

/**
 * §84 — why the sandbox was chosen over the deterministic tools.
 *
 * Recorded per turn so §85's question — which of these operations deserves to
 * become a real tool — is answered by telemetry rather than by guessing.
 */
export type SandboxNecessity =
  | "MISSING_DETERMINISTIC_CAPABILITY"
  | "OPEN_ENDED_EXPLORATION"
  | "CUSTOM_TRANSFORMATION"
  | "ADVANCED_STATISTICS"
  | "MULTI_METHOD_ANALYSIS"
  | "OTHER";
