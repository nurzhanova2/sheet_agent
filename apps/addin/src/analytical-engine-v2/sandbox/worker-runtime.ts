import type { SandboxDataset, SandboxError, SandboxLimits, SandboxResult, SourceLineage } from "./types.js";
import { SANDBOX_LIMITS } from "./types.js";
import type { CodeViolation, ExecuteOutcome, LookObservation, LookTarget, StepObservation, TableInspection } from "./pyodide-runtime.js";
import { repairHintFor } from "./failure-classes.js";
import type { SandboxDiagnostic } from "../production/execution-progress.js";

/**
 * The worker surface, narrowed to what this host needs and widened to cover
 * both shapes: a browser `Worker` (addEventListener) and a Node
 * `worker_threads.Worker` (on). Tests supply a fake implementing the same two.
 */
export interface SandboxWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void | Promise<unknown>;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  on?(type: string, listener: (payload: unknown) => void): void;
}

export type SandboxWorkerFactory = () => SandboxWorkerLike;

// --- the protocol -----------------------------------------------------------

export type HostMessage =
  | { readonly type: "init"; readonly indexURL?: string; readonly packages?: readonly string[] }
  | { readonly type: "validate"; readonly id: number; readonly code: string }
  | { readonly type: "run"; readonly id: number; readonly code: string; readonly dataset: unknown; readonly maxRows: number }
  // Stage 27.2 §15 — the iterative session. `sessionId` scopes a Python
  // namespace to one analytical turn; nothing else about the protocol changes.
  | { readonly type: "step"; readonly id: number; readonly sessionId: string; readonly code: string; readonly dataset: unknown; readonly maxRows: number }
  | { readonly type: "inspect"; readonly id: number; readonly sessionId: string; readonly dataset: unknown }
  | { readonly type: "look"; readonly id: number; readonly sessionId: string; readonly target: string; readonly variable: string; readonly dataset: unknown; readonly limit: number }
  | { readonly type: "finish"; readonly id: number; readonly sessionId: string; readonly maxRows: number }
  | { readonly type: "dispose"; readonly id: number; readonly sessionId: string };

export type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "boot_error"; readonly message: string }
  | { readonly type: "violations"; readonly id: number; readonly violations: readonly CodeViolation[] }
  | { readonly type: "result"; readonly id: number; readonly envelope: Record<string, unknown> }
  | { readonly type: "observation"; readonly id: number; readonly observation: Record<string, unknown> }
  | { readonly type: "failed"; readonly id: number; readonly code: string; readonly message: string };

interface Pending {
  readonly resolve: (message: WorkerMessage) => void;
  readonly reject: (error: Error) => void;
}

export interface SandboxEnvironment {
  readonly indexURL: string;
  readonly moduleURL: string;
  readonly origin: string;
  readonly baseURI: string;
  readonly workerType: string;
}

export interface WorkerRuntimeOptions {
  readonly factory: SandboxWorkerFactory;
  readonly indexURL?: string;
  readonly packages?: readonly string[];
  readonly limits?: SandboxLimits;
  readonly environment?: SandboxEnvironment;
  readonly bootTimeoutMs?: number;
}

export type StartupStage = "worker_construction" | "worker_load" | "runtime_boot" | "boot_timeout";

export interface StartupFailure {
  readonly stage: StartupStage;
  readonly message: string;
  readonly asset: string | null;
}

const BOOT_TIMEOUT_MS = 120_000;

const ASSET_IN_MESSAGE =
  /(?:https?:\/\/[^\s"')]+|[A-Za-z0-9_.-]+\.(?:whl|wasm|mjs|js|zip|json))/u;

export function assetHint(message: string): string | null {
  return ASSET_IN_MESSAGE.exec(message)?.[0] ?? null;
}

const STAGE_TEXT: Readonly<Record<StartupStage, { readonly ru: string; readonly en: string }>> = {
  worker_construction: { ru: "не удалось создать фоновый поток", en: "the background worker could not be created" },
  worker_load: { ru: "фоновый поток не загрузился", en: "the background worker failed to load" },
  runtime_boot: { ru: "среда Python не запустилась", en: "the Python runtime did not start" },
  boot_timeout: { ru: "запуск не завершился за отведённое время", en: "startup did not finish in time" },
};

export function startupDiagnosticsOf(
  failure: StartupFailure | null,
  environment: SandboxEnvironment | undefined,
  locale: "ru" | "en" = "ru",
): readonly SandboxDiagnostic[] {
  const ru = locale === "ru";
  const rows: SandboxDiagnostic[] = [];
  if (failure) {
    rows.push({ label: ru ? "Этап" : "Stage", value: ru ? STAGE_TEXT[failure.stage].ru : STAGE_TEXT[failure.stage].en });
    rows.push({ label: ru ? "Причина" : "Reason", value: failure.message });
    if (failure.asset) rows.push({ label: ru ? "Ресурс" : "Asset", value: failure.asset });
  }
  if (environment) {
    rows.push({ label: ru ? "Пакеты Python" : "Python assets", value: environment.indexURL });
    rows.push({ label: ru ? "Модуль надстройки" : "Add-in module", value: environment.moduleURL });
    rows.push({ label: ru ? "Источник" : "Origin", value: environment.origin });
    rows.push({ label: "document.baseURI", value: environment.baseURI });
    rows.push({ label: ru ? "Тип потока" : "Worker type", value: environment.workerType });
  }
  return rows;
}

export class WorkerSandboxRuntime {
  /** §12 — true: `terminate()` bounds anything, including a tight loop. */
  readonly hardTimeout = true;

  #worker: SandboxWorkerLike | null = null;
  #booting: Promise<void> | null = null;
  #startupFailure: StartupFailure | null = null;
  #seq = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #options: WorkerRuntimeOptions;
  readonly #limits: SandboxLimits;

  constructor(options: WorkerRuntimeOptions) {
    this.#options = options;
    this.#limits = options.limits ?? SANDBOX_LIMITS;
  }

  async ready(): Promise<void> {
    if (this.#worker) return;
    if (!this.#booting) this.#booting = this.#boot();
    await this.#booting;
  }

  startupDiagnostics(): readonly SandboxDiagnostic[] {
    return startupDiagnosticsOf(this.#startupFailure, this.#options.environment);
  }

  #boot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (stage: StartupStage, message: string): void => {
        if (settled) return;
        settled = true;
        this.#startupFailure = { stage, message, asset: assetHint(message) };
        reject(new Error(message));
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        this.#startupFailure = null;
        resolve();
      };

      const timer = setTimeout(
        () => fail("boot_timeout", `the analytical runtime did not report ready within ${this.#options.bootTimeoutMs ?? BOOT_TIMEOUT_MS} ms`),
        this.#options.bootTimeoutMs ?? BOOT_TIMEOUT_MS,
      );

      let worker: SandboxWorkerLike;
      try {
        worker = this.#options.factory();
      } catch (error) {
        clearTimeout(timer);
        fail("worker_construction", String(error));
        return;
      }
      this.#worker = worker;
      listen(worker, "message", (raw) => {
        const message = payloadOf(raw) as WorkerMessage;
        if (message.type === "ready") {
          clearTimeout(timer);
          succeed();
          return;
        }
        if (message.type === "boot_error") {
          clearTimeout(timer);
          fail("runtime_boot", message.message);
          return;
        }
        const id = (message as { id?: number }).id;
        if (typeof id !== "number") return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.resolve(message);
      });
      listen(worker, "error", (raw) => {
        clearTimeout(timer);
        const message = String((raw as { message?: string })?.message ?? raw);
        fail("worker_load", message);
        const error = new Error(message);
        for (const [, pending] of this.#pending) pending.reject(error);
        this.#pending.clear();
      });
      const init: HostMessage = {
        type: "init",
        ...(this.#options.indexURL !== undefined ? { indexURL: this.#options.indexURL } : {}),
        ...(this.#options.packages !== undefined ? { packages: this.#options.packages } : {}),
      };
      worker.postMessage(init);
    });
  }

  /**
   * Kill the worker and fail everything waiting on it.
   *
   * Called on timeout, on cancellation, and on a transport error. The next
   * call boots a fresh one, which costs ~7 seconds — deliberately preferred
   * over reusing a runtime whose state is unknown.
   */
  async #discard(reason: SandboxError): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    this.#booting = null;
    for (const [, pending] of this.#pending) pending.reject(new Error(reason.message));
    this.#pending.clear();
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* a worker that will not die is already gone from our side */
      }
    }
  }

  #send(message: HostMessage & { readonly id: number }): Promise<WorkerMessage> {
    return new Promise((resolve, reject) => {
      this.#pending.set(message.id, { resolve, reject });
      this.#worker?.postMessage(message);
    });
  }

  async validate(code: string): Promise<readonly CodeViolation[]> {
    await this.ready();
    const id = (this.#seq += 1);
    const reply = await this.#send({ type: "validate", id, code });
    return reply.type === "violations" ? reply.violations : [];
  }

  /** §12/§70 — bounded by the clock and by the user, both enforced by terminate. */
  async execute(code: string, dataset: SandboxDataset, signal?: AbortSignal): Promise<ExecuteOutcome> {
    const started = Date.now();
    const fail = (error: SandboxError): ExecuteOutcome => ({ ok: false, error, durationMs: Date.now() - started });

    if (signal?.aborted) return fail({ code: "CANCELLED", message: "cancelled before execution" });
    if (code.length > this.#limits.maxCodeLength) {
      return fail({ code: "CODE_VALIDATION_ERROR", message: `code is ${code.length} characters, over the ${this.#limits.maxCodeLength} limit` });
    }

    try {
      await this.ready();
    } catch (err) {
      return fail({ code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` });
    }

    const id = (this.#seq += 1);
    const request = this.#send({ type: "run", id, code, dataset: datasetPayload(dataset), maxRows: this.#limits.maxResultRows });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SandboxError>((resolve) => {
      timer = setTimeout(() => resolve({ code: "SANDBOX_TIMEOUT", message: `the analysis exceeded ${this.#limits.executionTimeoutMs} ms` }), this.#limits.executionTimeoutMs);
    });
    const cancelled = new Promise<SandboxError>((resolve) => {
      if (!signal) return;
      signal.addEventListener("abort", () => resolve({ code: "CANCELLED", message: "cancelled during execution" }), { once: true });
    });

    let reply: WorkerMessage;
    try {
      const outcome = await Promise.race([request.then((m) => ({ kind: "reply" as const, m })), timeout.then((e) => ({ kind: "stop" as const, e })), cancelled.then((e) => ({ kind: "stop" as const, e }))]);
      if (outcome.kind === "stop") {
        // §70 — the worker dies, so no late result can arrive and commit.
        await this.#discard(outcome.e);
        return fail(outcome.e);
      }
      reply = outcome.m;
    } catch (err) {
      return fail({ code: "SANDBOX_RUNTIME_ERROR", message: String(err) });
    } finally {
      clearTimeout(timer);
    }

    if (reply.type === "failed") {
      return fail({ code: reply.code as SandboxError["code"], message: reply.message, repairHint: repairHintFor(reply.message) });
    }
    if (reply.type !== "result") {
      return fail({ code: "INVALID_RESULT", message: `unexpected reply from the analytical runtime: ${reply.type}` });
    }

    const result = envelopeToResult(reply.envelope, dataset, started);
    return { ok: true, result, stdout: String(reply.envelope["stdout"] ?? ""), durationMs: Date.now() - started };
  }

  // -------------------------------------------------------------------------
  // Stage 27.2 §15/§16 — the iterative session.
  //
  // The security posture is unchanged (§47). Every step is validated by the
  // same AST gate before it runs; the namespace is built by the same
  // `__sa_namespace` as a one-shot analysis; and the timeout still works the
  // way it has to in this runtime — by TERMINATING the worker, which is the
  // only thing that bounds CPU-bound Python. A terminated worker loses its
  // sessions, which is correct: a turn whose step had to be killed has no
  // state worth resuming.
  // -------------------------------------------------------------------------

  /** §16 — run one step; a Python error comes back as an observation. */
  async step(sessionId: string, code: string, dataset: SandboxDataset, signal?: AbortSignal): Promise<StepObservation | { readonly refused: SandboxError }> {
    const started = Date.now();
    if (signal?.aborted) return { refused: { code: "CANCELLED", message: "cancelled before execution" } };
    if (code.length > this.#limits.maxCodeLength) {
      return { refused: { code: "CODE_VALIDATION_ERROR", message: `code is ${code.length} characters, over the ${this.#limits.maxCodeLength} limit` } };
    }
    try {
      await this.ready();
    } catch (err) {
      return { refused: { code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` } };
    }

    // §47 — per STEP, not per turn.
    const violations = await this.validate(code);
    if (violations.length > 0) {
      const syntax = violations.find((v) => v.code === "SYNTAX");
      // §1 lists SyntaxError first among the things an agent should recover
      // from on its own, so it is an observation. An unsafe capability request
      // is not, and is never retried (Stage 27 §68).
      if (syntax) {
        return {
          status: "error",
          errorType: "SyntaxError",
          message: syntax.detail,
          line: syntax.line ?? null,
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
          ...(violations[0] ? { line: violations[0].line } : {}),
        },
      };
    }

    const id = (this.#seq += 1);
    const request = this.#send({ type: "step", id, sessionId, code, dataset: datasetPayload(dataset), maxRows: this.#limits.maxResultRows });
    const reply = await this.#race(request, signal);
    if ("stopped" in reply) return { refused: reply.stopped };
    if (reply.message.type === "failed") return { refused: { code: reply.message.code as SandboxError["code"], message: reply.message.message } };
    if (reply.message.type !== "observation") return { refused: { code: "INVALID_RESULT", message: `unexpected reply: ${reply.message.type}` } };
    return { ...(reply.message.observation as unknown as Omit<StepObservation, "durationMs">), durationMs: Date.now() - started };
  }

  /** §11/§12 — one bounded look, over the same worker protocol. */
  async look(sessionId: string, target: LookTarget, variable: string | null, dataset: SandboxDataset, limit = 10, signal?: AbortSignal): Promise<LookObservation | { readonly refused: SandboxError }> {
    try {
      await this.ready();
    } catch (err) {
      return { refused: { code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` } };
    }
    const id = (this.#seq += 1);
    const request = this.#send({ type: "look", id, sessionId, target, variable: variable ?? "", dataset: datasetPayload(dataset), limit });
    const reply = await this.#race(request, signal);
    if ("stopped" in reply) return { refused: reply.stopped };
    if (reply.message.type !== "observation") return { refused: { code: "INVALID_RESULT", message: "the runtime could not inspect that" } };
    return reply.message.observation as unknown as LookObservation;
  }

  /** §13 — structural inspection without serialising the frame. */
  async inspect(sessionId: string, dataset: SandboxDataset, signal?: AbortSignal): Promise<TableInspection | { readonly refused: SandboxError }> {
    try {
      await this.ready();
    } catch (err) {
      return { refused: { code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` } };
    }
    const id = (this.#seq += 1);
    const request = this.#send({ type: "inspect", id, sessionId, dataset: datasetPayload(dataset) });
    const reply = await this.#race(request, signal);
    if ("stopped" in reply) return { refused: reply.stopped };
    if (reply.message.type !== "observation") return { refused: { code: "INVALID_RESULT", message: "the runtime could not inspect the table" } };
    return reply.message.observation as unknown as TableInspection;
  }

  /** §26 — collect through the SAME envelope path a one-shot analysis uses. */
  async finish(sessionId: string, dataset: SandboxDataset, signal?: AbortSignal): Promise<ExecuteOutcome> {
    const started = Date.now();
    const fail = (error: SandboxError): ExecuteOutcome => ({ ok: false, error, durationMs: Date.now() - started });
    try {
      await this.ready();
    } catch (err) {
      return fail({ code: "SANDBOX_UNAVAILABLE", message: `the analytical runtime did not start: ${String(err)}` });
    }
    const id = (this.#seq += 1);
    const request = this.#send({ type: "finish", id, sessionId, maxRows: this.#limits.maxResultRows });
    const reply = await this.#race(request, signal);
    if ("stopped" in reply) return fail(reply.stopped);
    if (reply.message.type === "failed") return fail({ code: "INVALID_RESULT", message: reply.message.message });
    if (reply.message.type !== "result") return fail({ code: "INVALID_RESULT", message: `unexpected reply: ${reply.message.type}` });
    return { ok: true, result: envelopeToResult(reply.message.envelope, dataset, started), stdout: "", durationMs: Date.now() - started };
  }

  /**
   * §15 — one turn, one session.
   *
   * Named `endSession` rather than `dispose` because the runtime already has a
   * `dispose()` that releases the WORKER. Two lifetimes live here and they are
   * not the same: a session ends every analytical turn, the worker survives
   * the whole task-pane session.
   */
  async endSession(sessionId: string): Promise<void> {
    if (!this.#worker) return;
    try {
      const id = (this.#seq += 1);
      await this.#send({ type: "dispose", id, sessionId });
    } catch {
      /* a worker that has already gone has no session to end */
    }
  }

  /**
   * The timeout/cancellation race, shared by every session call.
   *
   * §12 again: only `terminate()` bounds CPU-bound Python, so a stop discards
   * the worker. Factored out so a future session method cannot accidentally
   * be the one that forgets to.
   */
  async #race(request: Promise<WorkerMessage>, signal?: AbortSignal): Promise<{ readonly message: WorkerMessage } | { readonly stopped: SandboxError }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SandboxError>((resolve) => {
      timer = setTimeout(() => resolve({ code: "SANDBOX_TIMEOUT", message: `the step exceeded ${this.#limits.executionTimeoutMs} ms` }), this.#limits.executionTimeoutMs);
    });
    const cancelled = new Promise<SandboxError>((resolve) => {
      if (!signal) return;
      signal.addEventListener("abort", () => resolve({ code: "CANCELLED", message: "cancelled during execution" }), { once: true });
    });
    try {
      const outcome = await Promise.race([
        request.then((m) => ({ kind: "reply" as const, m })),
        timeout.then((e) => ({ kind: "stop" as const, e })),
        cancelled.then((e) => ({ kind: "stop" as const, e })),
      ]);
      if (outcome.kind === "stop") {
        await this.#discard(outcome.e);
        return { stopped: outcome.e };
      }
      return { message: outcome.m };
    } catch (err) {
      return { stopped: { code: "SANDBOX_RUNTIME_ERROR", message: String(err) } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Release the worker; the next call boots a fresh one. */
  async dispose(): Promise<void> {
    await this.#discard({ code: "CANCELLED", message: "runtime disposed" });
  }
}

/**
 * The collected envelope as a `SandboxResult`.
 *
 * Shared by `execute` and `finish`: §26 requires an emitted result to go
 * through the same normalization, validation, lineage and numeric
 * verification as any other, and two constructors would be two chances for
 * those to diverge.
 */
function envelopeToResult(envelope: Record<string, unknown>, dataset: SandboxDataset, started: number): SandboxResult {
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
    ...envelope,
    sourceLineage: lineage,
  } as unknown as SandboxResult;
}

/** §27 — the names that ALWAYS exist, repeated in every failure observation. */
const PREPARED_NAMES: readonly string[] = ["data", "numeric_data", "entity_data", "X", "numeric_columns", "entity_columns", "table", "result"];

/** A real newline, from its code point. */
const NEWLINE = String.fromCharCode(10);

/** §9 — exactly what crosses into the worker. No handles, no tokens. */
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

/** Bridge the two worker event shapes without pretending they are one. */
function listen(worker: SandboxWorkerLike, type: string, handler: (payload: unknown) => void): void {
  if (typeof worker.addEventListener === "function") worker.addEventListener(type, handler);
  else if (typeof worker.on === "function") worker.on(type, handler);
}

/** A browser delivers a MessageEvent; Node delivers the value itself. */
function payloadOf(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) return (raw as { data: unknown }).data;
  return raw;
}
