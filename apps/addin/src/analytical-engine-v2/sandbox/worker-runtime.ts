// ---------------------------------------------------------------------------
// Stage 27 §11/§12/§70 — the runtime that ships: Pyodide inside a Worker.
//
// Three properties make the Worker non-optional rather than a nicety.
//
// 1. §12, the timeout. `runPython` is synchronous; while WASM runs, the
//    JavaScript event loop on that thread does not. An in-process runtime
//    therefore cannot bound `while True: pass` — a measured fact, not a
//    theoretical one. From another thread the bound is real: write the
//    interrupt buffer, and failing that call `terminate()`, measured to kill a
//    runaway WASM loop in about a second.
//
// 2. §70, cancellation. "No late result may commit after cancellation" is
//    trivially satisfied when the thread that would have produced it no longer
//    exists.
//
// 3. The task pane. A 30-second analysis on the UI thread freezes the pane for
//    30 seconds, including the progress states §88 asks for — which would then
//    be a spinner that cannot spin.
//
// A terminated worker is DISCARDED, never reused: whatever state a killed
// analysis left behind dies with it, which is also how §11's ephemeral
// workspace is enforced at the coarsest possible granularity.
// ---------------------------------------------------------------------------

import type { SandboxDataset, SandboxError, SandboxLimits, SandboxResult, SourceLineage } from "./types.js";
import { SANDBOX_LIMITS } from "./types.js";
import type { CodeViolation, ExecuteOutcome } from "./pyodide-runtime.js";

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
  | { readonly type: "run"; readonly id: number; readonly code: string; readonly dataset: unknown; readonly maxRows: number };

export type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "boot_error"; readonly message: string }
  | { readonly type: "violations"; readonly id: number; readonly violations: readonly CodeViolation[] }
  | { readonly type: "result"; readonly id: number; readonly envelope: Record<string, unknown> }
  | { readonly type: "failed"; readonly id: number; readonly code: string; readonly message: string };

interface Pending {
  readonly resolve: (message: WorkerMessage) => void;
  readonly reject: (error: Error) => void;
}

export interface WorkerRuntimeOptions {
  readonly factory: SandboxWorkerFactory;
  readonly indexURL?: string;
  readonly packages?: readonly string[];
  readonly limits?: SandboxLimits;
}

export class WorkerSandboxRuntime {
  /** §12 — true: `terminate()` bounds anything, including a tight loop. */
  readonly hardTimeout = true;

  #worker: SandboxWorkerLike | null = null;
  #booting: Promise<void> | null = null;
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

  #boot(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = this.#options.factory();
      this.#worker = worker;
      listen(worker, "message", (raw) => {
        const message = payloadOf(raw) as WorkerMessage;
        if (message.type === "ready") {
          resolve();
          return;
        }
        if (message.type === "boot_error") {
          reject(new Error(message.message));
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
        const error = new Error(String((raw as { message?: string })?.message ?? raw));
        reject(error);
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
      return fail({ code: reply.code as SandboxError["code"], message: reply.message, repairHint: reply.message });
    }
    if (reply.type !== "result") {
      return fail({ code: "INVALID_RESULT", message: `unexpected reply from the analytical runtime: ${reply.type}` });
    }

    const lineage: SourceLineage = {
      datasetIds: [dataset.datasetId],
      sheet: dataset.sheet,
      sourceRange: dataset.sourceRange,
      freshnessToken: dataset.freshnessToken,
    };
    const result = {
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
      ...reply.envelope,
      sourceLineage: lineage,
    } as unknown as SandboxResult;

    return { ok: true, result, stdout: String(reply.envelope["stdout"] ?? ""), durationMs: Date.now() - started };
  }

  /** Release the worker; the next call boots a fresh one. */
  async dispose(): Promise<void> {
    await this.#discard({ code: "CANCELLED", message: "runtime disposed" });
  }
}

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
