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
