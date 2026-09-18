// ---------------------------------------------------------------------------
// Stage 27 §12/§16/§70 — choosing a runtime, and refusing an unsafe one.
//
// Two implementations exist and they are NOT interchangeable. The worker one
// can stop a runaway analysis; the in-process one cannot, because `runPython`
// blocks the thread that would have to fire the timer (measured, see
// `pyodide-runtime.ts`). Handing untrusted generated code to a runtime whose
// timeout is advisory would make §12 a comment rather than a bound.
//
// So the choice is made here, once, and the executor is given a runtime that
// is honest about what it enforces. Where no Worker exists — a test process,
// an unusual host — the factory returns the in-process runtime and says so;
// the caller decides whether that is acceptable, and for a production turn it
// is not.
// ---------------------------------------------------------------------------

import type { AnalyticalRuntime } from "./executor.js";
import { PyodideSandboxRuntime } from "./pyodide-runtime.js";
import { WorkerSandboxRuntime, type SandboxWorkerLike } from "./worker-runtime.js";
import type { SandboxLimits } from "./types.js";

/**
 * Where the vendored runtime is served from.
 *
 * `public/pyodide/` is copied verbatim into the build output, so this path is
 * relative to the task pane's own document — which is what makes §8 true in
 * production rather than in intent: nothing here can resolve to a CDN.
 */
export const VENDORED_INDEX_URL = "pyodide/";

export interface SandboxRuntimeChoice {
  readonly runtime: AnalyticalRuntime;
  /** Which implementation was chosen, for the trace (§71). */
  readonly kind: "worker" | "in_process";
  /** §12 — false means this runtime cannot bound CPU-bound code. */
  readonly hardTimeout: boolean;
  /** Why the worker was not used, when it was not. */
  readonly reason?: string;
}

export interface RuntimeFactoryOptions {
  readonly limits?: SandboxLimits;
  readonly indexURL?: string;
  /** Test seam: supply a worker instead of constructing one. */
  readonly workerFactory?: () => SandboxWorkerLike;
}

function canConstructWorker(): boolean {
  return typeof Worker === "function" && typeof URL === "function";
}

/**
 * The browser worker, constructed the way a bundler can see.
 *
 * `new URL("./sandbox-worker.ts", import.meta.url)` is the form vite statically
 * analyses: it emits the worker as its own chunk and rewrites the specifier.
 * Building the URL from a string at runtime would produce a worker that works
 * in dev and 404s in the packaged add-in.
 */
function browserWorkerFactory(): SandboxWorkerLike {
  return new Worker(new URL("./sandbox-worker.ts", import.meta.url), { type: "module", name: "sheet-agent-analysis" }) as unknown as SandboxWorkerLike;
}

export function createSandboxRuntime(options: RuntimeFactoryOptions = {}): SandboxRuntimeChoice {
  const indexURL = options.indexURL ?? VENDORED_INDEX_URL;
  const factory = options.workerFactory ?? (canConstructWorker() ? browserWorkerFactory : null);

  if (factory) {
    return {
      runtime: new WorkerSandboxRuntime({
        factory,
        indexURL,
        ...(options.limits ? { limits: options.limits } : {}),
      }),
      kind: "worker",
      hardTimeout: true,
    };
  }

  return {
    runtime: new PyodideSandboxRuntime({
      indexURL,
      ...(options.limits ? { limits: options.limits } : {}),
    }),
    kind: "in_process",
    hardTimeout: false,
    reason: "this host has no Worker; the analysis cannot be bounded in time",
  };
}

/**
 * §12 — may this runtime be given generated code?
 *
 * The one place the rule is written down, so the answer cannot drift between
 * call sites. A runtime that cannot stop a loop is fine for a test and wrong
 * for a user's workbook.
 */
export function isProductionSafe(choice: SandboxRuntimeChoice): boolean {
  return choice.hardTimeout;
}
