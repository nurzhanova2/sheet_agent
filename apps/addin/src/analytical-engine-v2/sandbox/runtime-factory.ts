import type { AnalyticalRuntime } from "./executor.js";
import { PyodideSandboxRuntime } from "./pyodide-runtime.js";
import { WorkerSandboxRuntime, type SandboxEnvironment, type SandboxWorkerLike } from "./worker-runtime.js";
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

/**
 * Where this bundle is served from.
 *
 * Reported instead of the worker's own URL, and the reason is the comment
 * above: vite only emits the worker chunk when `new URL(..., import.meta.url)`
 * is written INSIDE the `new Worker(...)` call, so there is no second place
 * that expression may appear. The worker chunk is a sibling of this module, so
 * this is the base a reader needs to check a 404 against — and it is the value
 * that was wrong in every packaging failure this project has had.
 */
function moduleURL(): string {
  try {
    return import.meta.url;
  } catch (error) {
    return `(unresolvable: ${String(error)})`;
  }
}

function documentBaseURI(): string {
  return (globalThis as { document?: { baseURI?: string } }).document?.baseURI ?? "(no document)";
}

function pageOrigin(): string {
  const location = (globalThis as { location?: { origin?: string } }).location;
  return location?.origin ?? "(no location)";
}

export function describeSandboxEnvironment(indexURL: string, workerAvailable: boolean): SandboxEnvironment {
  return {
    indexURL,
    moduleURL: workerAvailable ? moduleURL() : "(no worker)",
    origin: pageOrigin(),
    baseURI: documentBaseURI(),
    workerType: workerAvailable ? "module" : "none",
  };
}

export function resolvedAgainstDocument(indexURL: string): string {
  try {
    const base = (globalThis as { document?: { baseURI?: string } }).document?.baseURI;
    return base === undefined ? indexURL : new URL(indexURL, base).toString();
  } catch {
    return indexURL;
  }
}

export function createSandboxRuntime(options: RuntimeFactoryOptions = {}): SandboxRuntimeChoice {
  const indexURL = options.indexURL ?? resolvedAgainstDocument(VENDORED_INDEX_URL);
  const supplied = options.workerFactory !== undefined;
  const factory = options.workerFactory ?? (canConstructWorker() ? browserWorkerFactory : null);

  if (factory) {
    return {
      runtime: new WorkerSandboxRuntime({
        factory,
        indexURL,
        environment: describeSandboxEnvironment(indexURL, !supplied && canConstructWorker()),
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
