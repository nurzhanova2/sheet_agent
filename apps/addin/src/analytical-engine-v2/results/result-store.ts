import type { CellValue } from "@sheet-agent/application";
import type { EngineResult, ResultField, ResultId, ResultType } from "../types.js";

export interface NewResult {
  readonly tool: string;
  readonly type: ResultType;
  readonly fields: readonly ResultField[];
  readonly rows: readonly (readonly CellValue[])[];
  readonly metricKeys?: readonly string[];
  readonly periodCanonicals?: readonly string[];
  readonly parents?: readonly ResultId[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ResultStoreLimits {
  readonly maxRowsPerResult: number;
  readonly maxResultCells: number;
}

/**
 * §18/§19 — an append-only, per-turn store. Ids are sequential and scoped to
 * the store instance, so a planner that echoes an id from an earlier turn
 * fails loudly with UNKNOWN_REFERENCE instead of silently hitting a stale row
 * set (§14). Cross-turn continuity goes through committed conversation state,
 * never through a raw id the model happened to remember.
 */
export class ResultStore {
  readonly #byId = new Map<ResultId, EngineResult>();
  readonly #limits: ResultStoreLimits;
  readonly #sourceRange: string;
  readonly #sourceVersion: string;
  #seq = 0;

  constructor(sourceRange: string, sourceVersion: string, limits: ResultStoreLimits) {
    this.#sourceRange = sourceRange;
    this.#sourceVersion = sourceVersion;
    this.#limits = limits;
  }

  /**
   * Stage 26.7 §30/§48 — RESTORE work a clarified turn already completed, under
   * the ids it already had, so answering a clarification resumes the task
   * instead of recomputing it. Only ever called with results this engine
   * itself produced and committed to a SuspendedPlannerState; nothing the
   * model wrote can reach it.
   */
  seed(results: readonly EngineResult[]): void {
    for (const r of results) {
      this.#byId.set(r.resultId, r);
      const n = Number(/^result_(\d+)$/.exec(r.resultId)?.[1] ?? 0);
      if (n > this.#seq) this.#seq = n;
    }
  }

  /** Mints a handle and records lineage. Rows are clamped to the store's bounds (§12). */
  put(input: NewResult): EngineResult {
    this.#seq += 1;
    const resultId = `result_${this.#seq}`;
    const maxRowsByCells = input.fields.length > 0 ? Math.floor(this.#limits.maxResultCells / input.fields.length) : this.#limits.maxRowsPerResult;
    const rows = input.rows.slice(0, Math.max(1, Math.min(this.#limits.maxRowsPerResult, maxRowsByCells)));
    const metricKeys = input.metricKeys ?? deriveMetricKeys(input.fields, rows);
    const result: EngineResult = {
      resultId,
      tool: input.tool,
      type: input.type,
      fields: input.fields,
      rows,
      metricKeys,
      periodCanonicals: input.periodCanonicals ?? [],
      parents: input.parents ?? [],
      sourceRange: this.#sourceRange,
      sourceVersion: this.#sourceVersion,
      metadata: input.metadata ?? {},
    };
    this.#byId.set(resultId, result);
    return result;
  }

  get(id: string): EngineResult | undefined {
    return this.#byId.get(id);
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  ids(): readonly ResultId[] {
    return [...this.#byId.keys()];
  }

  all(): readonly EngineResult[] {
    return [...this.#byId.values()];
  }

  /**
   * §19 — the full ancestry of a result, nearest parent first. Used by the
   * trace, by provenance reporting, and by staleness invalidation.
   */
  lineageOf(id: string): readonly EngineResult[] {
    const chain: EngineResult[] = [];
    const seen = new Set<string>([id]);
    let frontier = this.#byId.get(id)?.parents ?? [];
    while (frontier.length > 0) {
      const next: ResultId[] = [];
      for (const parentId of frontier) {
        if (seen.has(parentId)) continue;
        seen.add(parentId);
        const parent = this.#byId.get(parentId);
        if (!parent) continue;
        chain.push(parent);
        next.push(...parent.parents);
      }
      frontier = next;
    }
    return chain;
  }
}

/** The metric universe of a result, in row order, deduplicated. */
export function deriveMetricKeys(fields: readonly ResultField[], rows: readonly (readonly CellValue[])[]): readonly string[] {
  const i = fields.findIndex((f) => f.kind === "metric");
  if (i < 0) return [];
  return [...new Set(rows.map((r) => String(r[i] ?? "")))].filter(Boolean);
}

/** Column index of a field by name, or -1. */
export function fieldIndex(result: EngineResult, name: string): number {
  return result.fields.findIndex((f) => f.name === name);
}

/** The single metric-labelled column's index, or -1. */
export function metricFieldIndex(result: EngineResult): number {
  return result.fields.findIndex((f) => f.kind === "metric");
}
