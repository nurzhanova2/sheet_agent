import { Worker as NodeWorker } from "node:worker_threads";
import { BOOTSTRAP_SOURCES } from "../sandbox/python-runtime.js";
import { SEALED_GLOBALS } from "../sandbox/sandbox-worker.js";
import { WorkerSandboxRuntime, type SandboxWorkerLike } from "../sandbox/worker-runtime.js";
import type { SandboxLimits } from "../sandbox/types.js";

/**
 * The worker body.
 *
 * Written with string concatenation rather than template literals so the
 * source can live inside a TypeScript string without escaping every `${`.
 * Everything it needs arrives in `workerData`; it decides nothing.
 */
const WORKER_SOURCE = [
  'import { loadPyodide } from "pyodide";',
  'import { parentPort, workerData } from "node:worker_threads";',
  "",
  "const send = (m) => parentPort.postMessage(m);",
  "let py = null;",
  "",
  "// The same list the browser worker removes, passed in rather than repeated.",
  "const seal = () => {",
  "  for (const name of workerData.seal) {",
  "    if (!(name in globalThis)) continue;",
  "    try { delete globalThis[name]; }",
  "    catch { try { globalThis[name] = undefined; } catch { /* frozen */ } }",
  "  }",
  "};",
  "",
  "const boot = async (indexURL, packages) => {",
  "  // A worker thread has no process.stdout.fd, so Pyodide's default writer",
  "  // throws ERR_INVALID_ARG_TYPE on every print. Routing both streams also",
  "  // keeps a 30-question benchmark readable (§88).",
  "  const opts = { stdout: () => {}, stderr: () => {} };",
  "  if (indexURL) opts.indexURL = indexURL;",
  "  const runtime = await loadPyodide(opts);",
  '  await runtime.loadPackage(packages ?? ["numpy", "pandas", "scikit-learn"]);',
  "  seal();",
  "  for (const source of workerData.bootstrap) runtime.runPython(source);",
  "  py = runtime;",
  "};",
  "",
  "parentPort.on('message', (message) => {",
  "  void (async () => {",
  "    try {",
  "      if (message.type === 'init') {",
  "        await boot(message.indexURL, message.packages);",
  "        send({ type: 'ready' });",
  "        return;",
  "      }",
  "      if (!py) {",
  "        send({ type: 'failed', id: message.id, code: 'SANDBOX_UNAVAILABLE', message: 'the runtime is not initialised' });",
  "        return;",
  "      }",
  "      if (message.type === 'validate') {",
  "        const raw = String(py.runPython('__sa_validate(' + JSON.stringify(message.code) + ')'));",
  "        send({ type: 'violations', id: message.id, violations: JSON.parse(raw) });",
  "        return;",
  "      }",
  "      if (message.type === 'run') {",
  "        const payload = JSON.stringify(message.dataset);",
  "        const call = '__sa_run(' + JSON.stringify(message.code) + ', ' + JSON.stringify(payload) + ', ' + message.maxRows + ')';",
  "        const raw = String(py.runPython(call));",
  "        send({ type: 'result', id: message.id, envelope: JSON.parse(raw) });",
  "        return;",
  "      }",
  "      // Stage 27.2 §15/§16 - the iterative session, mirroring the browser",
  "      // worker branch for branch. This file exists so the benchmark runs",
  "      // the SHIPPED hardening and limits; a session handled here but not",
  "      // there (or the reverse) would make it test a runtime nobody ships.",
  "      if (message.type === 'step') {",
  "        const payload = JSON.stringify(message.dataset);",
  "        const call = '__sa_step(' + JSON.stringify(message.sessionId) + ', ' + JSON.stringify(message.code) + ', ' + JSON.stringify(payload) + ', ' + message.maxRows + ')';",
  "        send({ type: 'observation', id: message.id, observation: JSON.parse(String(py.runPython(call))) });",
  "        return;",
  "      }",
  "      if (message.type === 'look') {",
  "        const payload = JSON.stringify(message.dataset);",
  "        const call = '__sa_look(' + JSON.stringify(message.sessionId) + ', ' + JSON.stringify(message.target) + ', ' + JSON.stringify(message.variable) + ', ' + JSON.stringify(payload) + ', ' + message.limit + ')';",
  "        send({ type: 'observation', id: message.id, observation: JSON.parse(String(py.runPython(call))) });",
  "        return;",
  "      }",
  "      if (message.type === 'inspect') {",
  "        const payload = JSON.stringify(message.dataset);",
  "        const call = '__sa_inspect(' + JSON.stringify(message.sessionId) + ', ' + JSON.stringify(payload) + ')';",
  "        send({ type: 'observation', id: message.id, observation: JSON.parse(String(py.runPython(call))) });",
  "        return;",
  "      }",
  "      if (message.type === 'finish') {",
  "        const call = '__sa_finish(' + JSON.stringify(message.sessionId) + ', ' + message.maxRows + ')';",
  "        send({ type: 'result', id: message.id, envelope: JSON.parse(String(py.runPython(call))) });",
  "        return;",
  "      }",
  "      if (message.type === 'dispose') {",
  "        py.runPython('__sa_dispose(' + JSON.stringify(message.sessionId) + ')');",
  "        send({ type: 'observation', id: message.id, observation: { status: 'ok' } });",
  "        return;",
  "      }",
  "    } catch (err) {",
  "      const text = String(err);",
  "      if (typeof message.id !== 'number') { send({ type: 'boot_error', message: text }); return; }",
  "      send({",
  "        type: 'failed',",
  "        id: message.id,",
  "        code: /not available in the analytical sandbox|ModuleNotFoundError/.test(text) ? 'UNSUPPORTED_LIBRARY' : 'SANDBOX_RUNTIME_ERROR',",
  "        message: text.split('\\n').filter(Boolean).pop() ?? text,",
  "      });",
  "    }",
  "  })();",
  "});",
].join("\n");

export interface NodeSandboxOptions {
  /**
   * Where the runtime assets live. Defaults to the VENDORED directory rather
   * than to `node_modules`, so the benchmark exercises the same 39 MB the
   * installer ships (§8) instead of a copy that only exists on a dev machine.
   */
  readonly indexURL?: string;
  readonly packages?: readonly string[];
  readonly limits?: SandboxLimits;
}

/** The vendored assets, relative to `apps/addin` — where the benchmark runs. */
export const HARNESS_INDEX_URL = "./public/pyodide";

/**
 * The worker itself needs no options: `indexURL` and the package list travel
 * in the `init` message, which is the same path the browser worker uses.
 */
export function nodeWorkerFactory(): () => SandboxWorkerLike {
  return () =>
    new NodeWorker(WORKER_SOURCE, {
      eval: true,
      workerData: { bootstrap: BOOTSTRAP_SOURCES, seal: SEALED_GLOBALS },
      // §11 — the analysis gets no argv and no environment. A Node worker
      // inherits `process.env` by default, and the benchmark runs on a machine
      // that has the model endpoint and whatever else in it (§7).
      env: {},
      argv: [],
    }) as unknown as SandboxWorkerLike;
}

/**
 * A runtime the analysis runner will actually accept.
 *
 * Returns the disposer as well: a benchmark that leaves Pyodide workers alive
 * pins a core per question and the suite never exits.
 */
export function createNodeSandbox(options: NodeSandboxOptions = {}): { readonly runtime: WorkerSandboxRuntime; readonly dispose: () => Promise<void> } {
  const runtime = new WorkerSandboxRuntime({
    factory: nodeWorkerFactory(),
    indexURL: options.indexURL ?? HARNESS_INDEX_URL,
    ...(options.packages ? { packages: options.packages } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return { runtime, dispose: async () => { await runtime.dispose(); } };
}
