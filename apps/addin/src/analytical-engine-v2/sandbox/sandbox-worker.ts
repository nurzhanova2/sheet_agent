// ---------------------------------------------------------------------------
// Stage 27 §7/§8/§11 — the worker that hosts the analytical runtime.
//
// This file runs on the far side of the boundary. Before Pyodide is even
// loaded it deletes the JavaScript capabilities a compromised analysis would
// reach for — `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts` — so
// that the `js` bridge, if it were ever reopened, would find an empty room.
//
// That ordering is the point. `python-runtime.ts` closes the bridge from the
// Python side; this closes the room from the JavaScript side. §8's "offline by
// default" is then true of the environment rather than of a policy: there is
// no network primitive in this scope to call.
// ---------------------------------------------------------------------------

import { BOOTSTRAP_SOURCES } from "./python-runtime.js";
import type { HostMessage, WorkerMessage } from "./worker-runtime.js";

interface WorkerPyodide {
  runPython(code: string): unknown;
  loadPackage(names: readonly string[]): Promise<unknown>;
}

/**
 * §8 — remove the network and loader primitives from the worker scope.
 *
 * Deleting rather than stubbing: a stub is a function a determined caller can
 * inspect and work around, while a missing global is a TypeError at the call
 * site. Pyodide itself does not need these once its assets are fetched, which
 * is why the deletion happens after the dynamic import resolves.
 */
function sealScope(scope: Record<string, unknown>): readonly string[] {
  const sealed: string[] = [];
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Request", "Response", "navigator", "indexedDB", "caches"]) {
    if (name in scope) {
      try {
        delete scope[name];
        sealed.push(name);
      } catch {
        try {
          scope[name] = undefined;
          sealed.push(`${name} (stubbed)`);
        } catch {
          /* frozen by the host; nothing further to do */
        }
      }
    }
  }
  return sealed;
}

/** Both worker flavours, addressed through one send. */
type Send = (message: WorkerMessage) => void;

async function makeSend(): Promise<Send> {
  const selfScope = globalThis as unknown as { postMessage?: (m: unknown) => void };
  if (typeof selfScope.postMessage === "function") return (message) => selfScope.postMessage?.(message);
  const { parentPort } = (await import("node:worker_threads")) as { parentPort: { postMessage(m: unknown): void } | null };
  return (message) => parentPort?.postMessage(message);
}

async function onEachMessage(handler: (message: HostMessage) => void): Promise<void> {
  const selfScope = globalThis as unknown as { addEventListener?: (t: string, cb: (e: { data: HostMessage }) => void) => void };
  if (typeof selfScope.addEventListener === "function") {
    selfScope.addEventListener("message", (event) => handler(event.data));
    return;
  }
  const { parentPort } = (await import("node:worker_threads")) as { parentPort: { on(t: string, cb: (m: HostMessage) => void): void } | null };
  parentPort?.on("message", handler);
}

export async function startSandboxWorker(): Promise<void> {
  const send = await makeSend();
  let py: WorkerPyodide | null = null;

  const boot = async (indexURL: string | undefined, packages: readonly string[] | undefined): Promise<void> => {
    const mod = (await import("pyodide")) as unknown as { loadPyodide: (o: { indexURL?: string }) => Promise<WorkerPyodide> };
    const runtime = await mod.loadPyodide(indexURL !== undefined ? { indexURL } : {});
    await runtime.loadPackage(packages ?? ["numpy", "pandas", "scikit-learn"]);
    // §8 — assets are in; the network primitives are no longer needed by
    // anyone, so they leave the scope entirely.
    sealScope(globalThis as unknown as Record<string, unknown>);
    for (const source of BOOTSTRAP_SOURCES) runtime.runPython(source);
    py = runtime;
  };

  await onEachMessage((message) => {
    void (async () => {
      try {
        if (message.type === "init") {
          await boot(message.indexURL, message.packages);
          send({ type: "ready" });
          return;
        }
        if (!py) {
          send({ type: "failed", id: (message as { id: number }).id, code: "SANDBOX_UNAVAILABLE", message: "the runtime is not initialised" });
          return;
        }
        if (message.type === "validate") {
          const raw = String(py.runPython(`__sa_validate(${JSON.stringify(message.code)})`));
          send({ type: "violations", id: message.id, violations: JSON.parse(raw) });
          return;
        }
        if (message.type === "run") {
          const payload = JSON.stringify(message.dataset);
          const raw = String(py.runPython(`__sa_run(${JSON.stringify(message.code)}, ${JSON.stringify(payload)}, ${message.maxRows})`));
          send({ type: "result", id: message.id, envelope: JSON.parse(raw) });
        }
      } catch (err) {
        const id = (message as { id?: number }).id;
        const text = String(err);
        if (typeof id !== "number") {
          send({ type: "boot_error", message: text });
          return;
        }
        send({
          type: "failed",
          id,
          code: /not available in the analytical sandbox|ModuleNotFoundError/.test(text) ? "UNSUPPORTED_LIBRARY" : "SANDBOX_RUNTIME_ERROR",
          message: text.split("\n").filter(Boolean).pop() ?? text,
        });
      }
    })();
  });
}

// A worker module starts working the moment it is loaded.
void startSandboxWorker();
