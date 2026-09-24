import type { SandboxDataset, SandboxError, SandboxLimits, SandboxResult, SourceLineage } from "./types.js";
import { SANDBOX_LIMITS } from "./types.js";
import { BOOTSTRAP_SOURCES } from "./python-runtime.js";
import { repairHintFor } from "./failure-classes.js";

/** The slice of Pyodide's API this module uses. Kept narrow on purpose. */
export interface PyodideApi {
  runPython(code: string): unknown;
  loadPackage(names: readonly string[]): Promise<unknown>;
  globals: { get(name: string): unknown };
  setInterruptBuffer?(buffer: Uint8Array): void;
}

export type PyodideLoader = (options: { readonly indexURL?: string }) => Promise<PyodideApi>;

export type DeniedCapability = "NETWORK" | "PROCESS" | "FILESYSTEM" | "BRIDGE";

/** §15 — one refusal from the AST contract. */
export interface CodeViolation {
  readonly code: "SYNTAX" | "IMPORT" | "CALL" | "ATTR" | "NAME" | "IO" | DeniedCapability;
  readonly detail: string;
  readonly line: number;
}

export interface RuntimeOptions {
  /** Where the Pyodide assets live. Omitted in Node; a served path in the pane. */
  readonly indexURL?: string;
  /** §6 — the analytical stack. Loaded once, on first use. */
  readonly packages?: readonly string[];
  readonly loader?: PyodideLoader;
  readonly limits?: SandboxLimits;
}

/**
 * §6 — the stack that is actually bundled.
 *
 * scipy arrives as a scikit-learn dependency, so the three named here bring
 * four. statsmodels and matplotlib are deliberately absent: §6 permits
 * trimming when packaging makes the full set impractical, and each adds ~10 MB
 * to an installer for capabilities the deterministic engine already covers
 * (regression fit, trend) or that the app renders itself (§64 — charts are
 * data, never generated images).
 */
export const DEFAULT_PACKAGES: readonly string[] = ["numpy", "pandas", "scikit-learn"];

export type ExecuteOutcome =
  | { readonly ok: true; readonly result: SandboxResult; readonly stdout: string; readonly durationMs: number }
  | { readonly ok: false; readonly error: SandboxError; readonly durationMs: number };

/**
 * Stage 27.2 §16/§17 — what one STEP of an iterative analysis reports back.
 *
 * The distinction from `ExecuteOutcome` is the whole of §16. An
 * `ExecuteOutcome` says whether an ANALYSIS succeeded; a `StepObservation`
 * says what HAPPENED, and a Python error is an ordinary value of it rather
 * than a failure of the turn. The agent reads this and decides what to do
 * next — the same agent, not a separate repair architecture.
 */
export interface StepObservation {
  readonly status: "ok" | "error";
  /** Present on error: the exception class, e.g. "NameError". */
  readonly errorType?: string;
  readonly message?: string;
  readonly line?: number | null;
  readonly failingLine?: string | null;
  readonly stdout: string;
  /** §28 — names the step created, with types and shapes but not contents. */
  readonly available: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** §27 — the names that always exist, repeated on failure so none is guessed. */
  readonly prepared?: readonly string[];
  /** Whether anything has been emitted into RESULT yet. */
  readonly hasResult?: boolean;
  /** The NAMES emitted so far — what a COMPLETE may point at. */
  readonly emitted?: readonly string[];
  readonly durationMs: number;
}

/**
 * Stage 27.2A §11/§12 — the bounded inspection targets.
 *
 * Every one of these is capped in rows and columns on the Python side. There
 * is no target that serialises a whole frame, on purpose: §11 rules out
 * arbitrary dumps, and an agent that needs an aggregate should compute it in
 * a step rather than read the table and do arithmetic in prose.
 */
export const LOOK_TARGETS = [
  "table.info",
  "table.schema",
  "table.head",
  "variable.summary",
  "variable.head",
  "variable.shape",
  "variable.dtype",
  "variable.columns",
  "result.preview",
] as const;

export type LookTarget = (typeof LOOK_TARGETS)[number];

/** Whether a target names a variable and therefore needs one. */
export function targetNeedsVariable(target: LookTarget): boolean {
  return target.startsWith("variable.");
}

/**
 * The answer to one LOOK.
 *
 * `status` carries the §16 principle into inspection: asking about a name
 * that does not exist is an observation with `unknown_variable` and the list
 * of what DOES exist, not an exception that ends the turn.
 */
export interface LookObservation {
  readonly target: string;
  readonly status: "ok" | "unknown_variable" | "not_tabular" | "error";
  readonly variable?: string;
  readonly type?: string;
  readonly shape?: readonly number[];
  readonly dtype?: string;
  readonly dtypes?: Readonly<Record<string, number>>;
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly unknown[])[];
  /** A number for a variable; a per-column map for `table.info`. */
  readonly missing?: number | Readonly<Record<string, number>>;
  readonly entityColumns?: readonly string[];
  readonly numericColumns?: readonly string[];
  readonly matrixShape?: readonly number[];
  /** `[finite, total]` — §12's "finite: 106/108". */
  readonly finite?: readonly [number, number];
  readonly schema?: readonly Readonly<Record<string, unknown>>[];
  readonly emitted?: Readonly<Record<string, readonly string[]>>;
  readonly available?: Readonly<Record<string, unknown>>;
  readonly prepared?: readonly string[];
  readonly errorType?: string;
  readonly message?: string;
}

/** §13 — a compact structural look at the table, without serialising it. */
export interface TableInspection {
  readonly shape: readonly number[];
  readonly entityColumns: readonly string[];
  readonly numericColumns: readonly string[];
  readonly missing: Readonly<Record<string, number>>;
  readonly matrixShape: readonly number[];
  readonly schema: readonly Readonly<Record<string, unknown>>[];
  readonly preview: readonly (readonly unknown[])[];
  readonly available: Readonly<Record<string, unknown>>;
}

/**
 * §11 — the runtime holds an ephemeral workspace per analysis, not a session.
 *
 * The Pyodide instance itself is reused because booting costs ~900 ms and the
 * bootstrap is idempotent, but each execution runs in a FRESH namespace built
 * inside `__sa_run`, so nothing an analysis defines survives into the next one.
 */
export class PyodideSandboxRuntime {
  /**
   * §12 — false: this runtime cannot stop CPU-bound code (see `execute`).
   * The executor refuses to run an untrusted analysis on a runtime whose
   * timeout is advisory, so this flag is load-bearing, not documentation.
   */
  readonly hardTimeout = false;

  #py: PyodideApi | null = null;
  #booting: Promise<PyodideApi> | null = null;
  readonly #options: RuntimeOptions;
  readonly #limits: SandboxLimits;

  constructor(options: RuntimeOptions = {}) {
    this.#options = options;
    this.#limits = options.limits ?? SANDBOX_LIMITS;
  }

  /** Boots once; concurrent callers share the same boot. */
  async ready(): Promise<PyodideApi> {
    if (this.#py) return this.#py;
    if (!this.#booting) this.#booting = this.#boot();
    this.#py = await this.#booting;
    return this.#py;
  }

  async #boot(): Promise<PyodideApi> {
    const load = this.#options.loader ?? (await defaultLoader());
    const py = await load(this.#options.indexURL !== undefined ? { indexURL: this.#options.indexURL } : {});
    await py.loadPackage(this.#options.packages ?? DEFAULT_PACKAGES);
    // §16 — the bootstrap runs BEFORE any generated code can exist, and its
    // order matters: capture, harden, then define the validator and runner.
    for (const source of BOOTSTRAP_SOURCES) py.runPython(source);
    return py;
  }

  /**
   * §15 — inspect the AST and report every refusal.
   *
   * Returns violations rather than throwing: the caller decides whether this
   * is a repairable generation slip (§66) or an UNSAFE_CODE stop (§68), and
   * that distinction belongs to the executor, not here.
   */
  async validate(code: string): Promise<readonly CodeViolation[]> {
    const py = await this.ready();
    const escaped = JSON.stringify(code);
    const raw = py.runPython(`__sa_validate(${escaped})`);
    return JSON.parse(String(raw)) as CodeViolation[];
  }

  /**
   * §12/§70 — execute, with the bounds this runtime can actually enforce.
   *
   * A measured limitation, stated rather than papered over. `runPython` is
   * SYNCHRONOUS: while WASM runs, the JavaScript event loop does not, so a
   * `setTimeout` scheduled here cannot fire until the Python call has already
   * returned. An in-process runtime therefore cannot bound CPU-bound code —
   * `while True: pass` runs forever, and a spike measuring exactly that is why
   * this comment exists instead of a timeout that appears to work.
   *
   * The interrupt buffer below is still installed, because it DOES work when
   * something on another thread writes it. That is the production arrangement:
   * `WorkerSandboxRuntime` runs this code inside a Worker and the main thread
   * both writes the buffer and, as the hard backstop, calls `terminate()` —
   * measured to kill a runaway WASM loop in about a second.
   *
   * So this class is the correctness-and-security runtime (tests, and any host
   * with no Worker), and the Worker wrapper is the one that ships. `hardTimeout`
   * says which you are holding.
   */
  /**
   * Stage 27.2 §15/§16 — run ONE step inside a named ephemeral session.
   *
   * The session is a Python namespace that survives between steps of a single
   * analytical turn, so `features` built in step 1 is still there in step 3.
   * It is disposed at the end of the turn (§15) — nothing arbitrary crosses
   * into an unrelated user turn, and `dispose()` is called from a `finally`
   * so that holds even when the turn fails.
   *
   * SECURITY IS UNCHANGED (§47). Every step goes through the same AST
   * validator, the same restricted builtins and the same interrupt-based
   * timeout as a one-shot execution. A session does not widen what code can
   * reach; it lengthens the life of a dict.
   *
   * The return type is the point. A Python exception comes back as an
   * observation with `status: "error"` rather than propagating — see §16.
   * The two things that are still hard failures are the ones the agent cannot
   * act on: code the validator refuses, and a runtime that will not start.
   */
  async step(sessionId: string, code: string, dataset: SandboxDataset, signal?: AbortSignal): Promise<StepObservation | { readonly refused: SandboxError }> {
    const started = Date.now();
    if (signal?.aborted) return { refused: { code: "CANCELLED", message: "cancelled before execution" } };
    if (code.length > this.#limits.maxCodeLength) {
      return { refused: { code: "CODE_VALIDATION_ERROR", message: `code is ${code.length} characters, over the ${this.#limits.maxCodeLength} limit` } };
    }

    let py: PyodideApi;
    try {
      py = await this.ready();
    } catch (err) {
      return { refused: { code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` } };
    }

    // §47 — the security gate runs per STEP, not per turn. A session does not
    // buy the agent a pass on the second action.
    const violations = await this.validate(code);
    if (violations.length > 0) {
      const syntax = violations.find((v) => v.code === "SYNTAX");
      // A SyntaxError is an ordinary thing for an agent to write and an
      // ordinary thing to fix, so it is an OBSERVATION (§1 lists it first).
      // An unsafe capability request is not: it is refused, and §68 of Stage
      // 27 says such code is never retried.
      if (syntax) {
        return {
          status: "error",
          errorType: "SyntaxError",
          message: syntax.detail,
          line: syntax.line,
          failingLine: code.split(NEWLINE)[Math.max(0, (syntax.line ?? 1) - 1)]?.trim() ?? null,
          stdout: "",
          available: {},
          prepared: PREPARED_NAMES,
          durationMs: Date.now() - started,
        };
      }
      return {
        refused: {
          code: "UNSAFE_CODE",
          message: `the analysis code requests capabilities the sandbox denies: ${violations.map((v) => `${v.code}:${v.detail}`).join(", ")}`,
          repairHint: unsafeRepairHint(violations),
          ...(violations[0] ? { line: violations[0].line } : {}),
        },
      };
    }

    const interrupt = makeInterruptBuffer();
    if (interrupt && py.setInterruptBuffer) py.setInterruptBuffer(interrupt);
    const raise = (): void => {
      if (interrupt) interrupt[0] = 2;
    };
    const timer = setTimeout(raise, this.#limits.executionTimeoutMs);
    const onAbort = (): void => raise();
    signal?.addEventListener("abort", onAbort);

    try {
      const payload = JSON.stringify(datasetPayload(dataset));
      const raw = String(
        py.runPython(`__sa_step(${JSON.stringify(sessionId)}, ${JSON.stringify(code)}, ${JSON.stringify(payload)}, ${this.#limits.maxResultRows})`),
      );
      const parsed = JSON.parse(raw) as Omit<StepObservation, "durationMs">;
      return { ...parsed, durationMs: Date.now() - started };
    } catch (err) {
      // Reaching here means the step harness itself failed rather than the
      // script — a timeout, a cancellation, or memory. Those are not things
      // the agent can write its way out of, so they stay refusals.
      const message = String(err);
      if (signal?.aborted) return { refused: { code: "CANCELLED", message: "cancelled during execution" } };
      if (/KeyboardInterrupt/.test(message)) return { refused: { code: "SANDBOX_TIMEOUT", message: `the step exceeded ${this.#limits.executionTimeoutMs} ms` } };
      if (/MemoryError|out of memory|Cannot enlarge memory/i.test(message)) return { refused: { code: "SANDBOX_MEMORY_LIMIT", message: "the step ran out of memory" } };
      return { refused: { code: "SANDBOX_RUNTIME_ERROR", message: pythonMessage(message) } };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (interrupt) interrupt[0] = 0;
    }
  }

  /** §11/§12 — one bounded look at a variable, the table, or what was emitted. */
  async look(sessionId: string, target: LookTarget, variable: string | null, dataset: SandboxDataset, limit = 10): Promise<LookObservation | { readonly refused: SandboxError }> {
    let py: PyodideApi;
    try {
      py = await this.ready();
    } catch (err) {
      return { refused: { code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` } };
    }
    try {
      const payload = JSON.stringify(datasetPayload(dataset));
      const raw = String(
        py.runPython(`__sa_look(${JSON.stringify(sessionId)}, ${JSON.stringify(target)}, ${JSON.stringify(variable ?? "")}, ${JSON.stringify(payload)}, ${limit})`),
      );
      return JSON.parse(raw) as LookObservation;
    } catch (err) {
      return { refused: { code: "SANDBOX_RUNTIME_ERROR", message: pythonMessage(String(err)) } };
    }
  }

  /** §13 — look at the table's structure before computing over it. */
  async inspect(sessionId: string, dataset: SandboxDataset): Promise<TableInspection | { readonly refused: SandboxError }> {
    let py: PyodideApi;
    try {
      py = await this.ready();
    } catch (err) {
      return { refused: { code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` } };
    }
    try {
      const payload = JSON.stringify(datasetPayload(dataset));
      return JSON.parse(String(py.runPython(`__sa_inspect(${JSON.stringify(sessionId)}, ${JSON.stringify(payload)})`))) as TableInspection;
    } catch (err) {
      return { refused: { code: "SANDBOX_RUNTIME_ERROR", message: pythonMessage(String(err)) } };
    }
  }

  /**
   * Collect what the session emitted, through the SAME envelope path a
   * one-shot analysis uses (§26) — the validators, the normalizer and the
   * numeric verifier see exactly what they saw before.
   */
  async finish(sessionId: string, dataset: SandboxDataset): Promise<ExecuteOutcome> {
    const started = Date.now();
    const fail = (error: SandboxError): ExecuteOutcome => ({ ok: false, error, durationMs: Date.now() - started });
    let py: PyodideApi;
    try {
      py = await this.ready();
    } catch (err) {
      return fail({ code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` });
    }
    let raw: string;
    try {
      raw = String(py.runPython(`__sa_finish(${JSON.stringify(sessionId)}, ${this.#limits.maxResultRows})`));
    } catch (err) {
      return fail({ code: "INVALID_RESULT", message: pythonMessage(String(err)) });
    }
    if (raw.length > this.#limits.maxOutputBytes) {
      return fail({ code: "INVALID_RESULT", message: `the result is ${raw.length} bytes, over the ${this.#limits.maxOutputBytes} limit` });
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail({ code: "INVALID_RESULT", message: "the session returned something that is not a structured result" });
    }
    return { ok: true, result: envelopeToResult(parsed, dataset, started), stdout: "", durationMs: Date.now() - started };
  }

  /**
   * §15 — end the session. Safe to call twice, and on a session that never
   * opened. Named to match `WorkerSandboxRuntime.endSession`, and kept
   * distinct from the worker-level `dispose()` those runtimes also have.
   */
  async endSession(sessionId: string): Promise<void> {
    try {
      const py = await this.ready();
      py.runPython(`__sa_dispose(${JSON.stringify(sessionId)})`);
    } catch {
      /* a runtime that never started has no session to end */
    }
  }

  async execute(code: string, dataset: SandboxDataset, signal?: AbortSignal): Promise<ExecuteOutcome> {
    const started = Date.now();
    const fail = (error: SandboxError): ExecuteOutcome => ({ ok: false, error, durationMs: Date.now() - started });

    if (signal?.aborted) return fail({ code: "CANCELLED", message: "cancelled before execution" });
    if (code.length > this.#limits.maxCodeLength) {
      return fail({ code: "CODE_VALIDATION_ERROR", message: `code is ${code.length} characters, over the ${this.#limits.maxCodeLength} limit` });
    }

    let py: PyodideApi;
    try {
      py = await this.ready();
    } catch (err) {
      return fail({ code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` });
    }

    const violations = await this.validate(code);
    if (violations.length > 0) {
      const syntax = violations.find((v) => v.code === "SYNTAX");
      return fail(
        syntax
          ? { code: "CODE_VALIDATION_ERROR", message: `the analysis code does not parse: ${syntax.detail}`, repairHint: `SyntaxError: ${syntax.detail}`, line: syntax.line }
          : {
              code: "UNSAFE_CODE",
              message: `the analysis code requests capabilities the sandbox denies: ${violations.map((v) => `${v.code}:${v.detail}`).join(", ")}`,
              repairHint: unsafeRepairHint(violations),
              ...(violations[0] ? { line: violations[0].line } : {}),
            },
      );
    }

    const interrupt = makeInterruptBuffer();
    if (interrupt && py.setInterruptBuffer) py.setInterruptBuffer(interrupt);
    const raise = (): void => {
      if (interrupt) interrupt[0] = 2; // SIGINT — Python raises KeyboardInterrupt
    };
    const timer = setTimeout(raise, this.#limits.executionTimeoutMs);
    const onAbort = (): void => raise();
    signal?.addEventListener("abort", onAbort);

    let raw: string;
    try {
      const payload = JSON.stringify(datasetPayload(dataset));
      raw = String(py.runPython(`__sa_run(${JSON.stringify(code)}, ${JSON.stringify(payload)}, ${this.#limits.maxResultRows})`));
    } catch (err) {
      const message = String(err);
      if (signal?.aborted) return fail({ code: "CANCELLED", message: "cancelled during execution" });
      if (/KeyboardInterrupt/.test(message)) {
        return fail({ code: "SANDBOX_TIMEOUT", message: `the analysis exceeded ${this.#limits.executionTimeoutMs} ms` });
      }
      if (/MemoryError|out of memory|Cannot enlarge memory/i.test(message)) {
        return fail({ code: "SANDBOX_MEMORY_LIMIT", message: "the analysis ran out of memory" });
      }
      if (/ModuleNotFoundError|not available in the analytical sandbox/.test(message)) {
        return fail({ code: "UNSUPPORTED_LIBRARY", message: pythonMessage(message), repairHint: repairHintFor(pythonMessage(message)) });
      }
      return fail({ code: "SANDBOX_RUNTIME_ERROR", message: pythonMessage(message), repairHint: repairHintFor(pythonMessage(message)) });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (interrupt) interrupt[0] = 0;
    }

    if (raw.length > this.#limits.maxOutputBytes) {
      return fail({ code: "INVALID_RESULT", message: `the result is ${raw.length} bytes, over the ${this.#limits.maxOutputBytes} limit` });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail({ code: "INVALID_RESULT", message: "the analysis returned something that is not a structured result" });
    }

    const result = envelopeToResult(parsed, dataset, started);
    return { ok: true, result, stdout: String(parsed["stdout"] ?? ""), durationMs: Date.now() - started };
  }
}

/**
 * The collected envelope as a `SandboxResult`.
 *
 * Shared by the one-shot `execute` and the iterative `finish` on purpose: §26
 * requires an emitted result to go through the same normalization, validation,
 * lineage and numeric verification as any other, and two constructors would be
 * two chances for those to diverge.
 */
function envelopeToResult(parsed: Record<string, unknown>, dataset: SandboxDataset, started: number): SandboxResult {
  const lineage: SourceLineage = {
    datasetIds: [dataset.datasetId],
    sheet: dataset.sheet,
    sourceRange: dataset.sourceRange,
    freshnessToken: dataset.freshnessToken,
  };
  return {
    executionId: `exec_${started.toString(36)}`,
    status: "ok" as const,
    tables: [],
    scalars: {},
    series: [],
    groups: [],
    models: [],
    diagnostics: {},
    findingsCandidates: [],
    warnings: [],
    artifacts: [],
    ...parsed,
    sourceLineage: lineage,
  } as unknown as SandboxResult;
}

/** §27 — the names that ALWAYS exist, repeated in every failure observation. */
const PREPARED_NAMES: readonly string[] = ["data", "numeric_data", "entity_data", "X", "numeric_columns", "entity_columns", "table", "result"];

/** A real newline, from its code point. */
const NEWLINE = String.fromCharCode(10);

/** §9 — exactly what crosses into Python. No addresses, no handles, no tokens. */
function datasetPayload(dataset: SandboxDataset): Record<string, unknown> {
  return {
    columns: dataset.columns.map((c) => ({
      name: c.name,
      semanticType: c.semanticType,
      unit: c.unit ?? null,
      missingCount: c.missingCount,
      zeroCount: c.zeroCount,
    })),
    rows: dataset.rows,
    periods: dataset.periods ?? null,
  };
}

const DENIED_CAPABILITY_HINTS: readonly { readonly code: DeniedCapability; readonly sentence: string }[] = [
  { code: "NETWORK", sentence: "The sandbox has no network; do not call out to a host or URL" },
  { code: "PROCESS", sentence: "The sandbox has no operating system, process or interpreter access" },
  { code: "FILESYSTEM", sentence: "The sandbox has no filesystem; do not open, read or write a path" },
  { code: "BRIDGE", sentence: "The sandbox has no host bridge; the page and its APIs are unreachable" },
];

/** §66 — what the code generator is told, in terms it can act on. */
function unsafeRepairHint(violations: readonly CodeViolation[]): string {
  const byCode = new Map<string, string[]>();
  for (const v of violations) {
    const list = byCode.get(v.code) ?? [];
    list.push(v.detail);
    byCode.set(v.code, list);
  }
  const parts: string[] = [];
  const imports = byCode.get("IMPORT");
  if (imports) parts.push(`These modules are not available: ${[...new Set(imports)].join(", ")}. Use only numpy, pandas, scipy, sklearn and the Python standard maths modules.`);
  const calls = byCode.get("CALL");
  if (calls) parts.push(`These functions are not available: ${[...new Set(calls)].join(", ")}.`);
  const io = byCode.get("IO");
  if (io) parts.push(`Do not read or write files or URLs (${[...new Set(io)].join(", ")}); the data is already provided in \`data\`.`);
  for (const capability of DENIED_CAPABILITY_HINTS) {
    const denied = byCode.get(capability.code);
    if (denied) parts.push(`${capability.sentence} (${[...new Set(denied)].join(", ")}). The data is already provided in \`data\`.`);
  }
  const attrs = [...(byCode.get("ATTR") ?? []), ...(byCode.get("NAME") ?? [])];
  if (attrs.length > 0) parts.push(`Do not use introspection attributes: ${[...new Set(attrs)].join(", ")}.`);
  return parts.join(" ");
}

/** Strip the JS wrapper off a Python traceback, keeping the line that matters. */
function pythonMessage(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? raw;
  const file = lines.find((l) => l.includes('File "<analysis>"'));
  return file ? `${last.trim()} (${file.trim()})` : last.trim();
}

function makeInterruptBuffer(): Uint8Array | null {
  try {
    const Shared = (globalThis as { SharedArrayBuffer?: typeof SharedArrayBuffer }).SharedArrayBuffer;
    if (!Shared) return null;
    return new Uint8Array(new Shared(1));
  } catch {
    return null;
  }
}

/**
 * The default loader, resolved lazily so that importing this module does not
 * pull ~12 MB of WASM into a bundle that may never run an analysis.
 */
async function defaultLoader(): Promise<PyodideLoader> {
  const mod = (await import("pyodide")) as unknown as { loadPyodide: PyodideLoader };
  return mod.loadPyodide;
}
