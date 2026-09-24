import { BOOTSTRAP_SOURCES } from "./python-runtime.js";
import type { HostMessage, WorkerMessage } from "./worker-runtime.js";

interface WorkerPyodide {
  runPython(code: string): unknown;
  loadPackage(names: readonly string[]): Promise<unknown>;
}

/**
 * §8 — the network and loader primitives removed from the worker scope.
 *
 * Deleted rather than stubbed: a missing global is a TypeError at the call
 * site, while a stub can be inspected and worked around. Removal runs after
 * the dynamic import resolves — Pyodide needs the network for its own assets.
 */
export const SEALED_GLOBALS: readonly string[] = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "Request",
  "Response",
  "navigator",
  "indexedDB",
  "caches",
];

function sealScope(scope: Record<string, unknown>): readonly string[] {
  const sealed: string[] = [];
  for (const name of SEALED_GLOBALS) {
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
    // §8 — assets are in; the primitives leave the scope.
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
          return;
        }
        // Stage 27.2 §15/§16 — the iterative session, over the same worker.
        //
        // These are four more `runPython` calls into the same bootstrapped
        // interpreter, carrying no new capability: the session namespace is
        // built by the same `__sa_namespace` a one-shot run uses, under the
        // same restricted builtins. What crosses the boundary is a session
        // id, which is a string the host chose.
        if (message.type === "step") {
          const payload = JSON.stringify(message.dataset);
          const raw = String(
            py.runPython(`__sa_step(${JSON.stringify(message.sessionId)}, ${JSON.stringify(message.code)}, ${JSON.stringify(payload)}, ${message.maxRows})`),
          );
          send({ type: "observation", id: message.id, observation: JSON.parse(raw) });
          return;
        }
        if (message.type === "look") {
          const payload = JSON.stringify(message.dataset);
          const raw = String(
            py.runPython(
              `__sa_look(${JSON.stringify(message.sessionId)}, ${JSON.stringify(message.target)}, ${JSON.stringify(message.variable)}, ${JSON.stringify(payload)}, ${message.limit})`,
            ),
          );
          send({ type: "observation", id: message.id, observation: JSON.parse(raw) });
          return;
        }
        if (message.type === "inspect") {
          const payload = JSON.stringify(message.dataset);
          const raw = String(py.runPython(`__sa_inspect(${JSON.stringify(message.sessionId)}, ${JSON.stringify(payload)})`));
          send({ type: "observation", id: message.id, observation: JSON.parse(raw) });
          return;
        }
        if (message.type === "finish") {
          const raw = String(py.runPython(`__sa_finish(${JSON.stringify(message.sessionId)}, ${message.maxRows})`));
          send({ type: "result", id: message.id, envelope: JSON.parse(raw) });
          return;
        }
        if (message.type === "dispose") {
          py.runPython(`__sa_dispose(${JSON.stringify(message.sessionId)})`);
          send({ type: "observation", id: message.id, observation: { status: "ok" } });
          return;
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
