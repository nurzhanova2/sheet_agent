// @vitest-environment node
// ---------------------------------------------------------------------------
// Stage 27 §7/§8/§12/§15/§16/§23/§25/§27/§29/§72 — the analytical sandbox.
//
// These tests boot a REAL Pyodide runtime and run the same bootstrap the
// product ships. That is the point: §16 says AST validation is defence in
// depth and not the sandbox, so a test suite that mocks the runtime proves
// nothing about the property the section is asking for.
//
// jsdom cannot host the runtime, hence the node environment above.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, it } from "vitest";
import { executedMethods, validateMethodComparison } from "./sandbox/method-comparison.js";
import type { CellValue } from "@sheet-agent/application";
import { Worker as NodeWorker } from "node:worker_threads";
import { PyodideSandboxRuntime } from "./sandbox/pyodide-runtime.js";
import { WorkerSandboxRuntime, type SandboxWorkerLike } from "./sandbox/worker-runtime.js";
import { SANDBOX_LIMITS, type SandboxDataset } from "./sandbox/types.js";

const BOOT_MS = 240_000;

let runtime: PyodideSandboxRuntime;

function dataset(rows: readonly (readonly CellValue[])[] = SAMPLE_ROWS): SandboxDataset {
  return {
    datasetId: "ds_test",
    tableRef: "Ops!A1:D4",
    sheet: "Ops",
    sourceRange: "Ops!A1:D4",
    freshnessToken: "v1",
    columns: [
      { name: "metric", semanticType: "metric_label", missingCount: 0, zeroCount: 0 },
      { name: "Jan", semanticType: "amount", missingCount: 0, zeroCount: 1 },
      { name: "Feb", semanticType: "amount", missingCount: 1, zeroCount: 0 },
      { name: "Mar", semanticType: "amount", missingCount: 0, zeroCount: 0 },
    ],
    rows,
    periods: ["Jan", "Feb", "Mar"],
  };
}

const SAMPLE_ROWS: readonly (readonly CellValue[])[] = [
  ["Output", 100, 110, 130],
  ["Defects", 0, null, 4],
  ["Downtime", 46, 39, 61],
];

beforeAll(async () => {
  runtime = new PyodideSandboxRuntime({ indexURL: "./node_modules/pyodide" });
  await runtime.ready();
}, BOOT_MS);

// --- §27/§28: it actually computes, and returns structure -------------------

describe("Stage 27 §27/§28 — the sandbox returns structure, never prose", () => {
  it("runs a real analysis and returns a typed envelope", async () => {
    const code = `
import numpy as np
values = data[["Jan", "Feb", "Mar"]].to_numpy(dtype=float)
spread = np.nanstd(values, axis=1) / np.nanmean(values, axis=1)
RESULT = {
    "method": {"name": "coefficient_of_variation", "parameters": {"axis": 1}},
    "tables": {"spread": pd.DataFrame({"metric": data["metric"], "cv": spread})},
    "scalars": {"rows": float(len(data))},
    "findings": [{"kind": "dispersion", "subject": str(data["metric"].iloc[int(np.nanargmax(spread))]), "values": {"cv": float(np.nanmax(spread))}}],
}
`;
    const outcome = await runtime.execute(code, dataset());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.method?.name).toBe("coefficient_of_variation");
    expect(outcome.result.tables[0]?.name).toBe("spread");
    expect(outcome.result.tables[0]?.rows).toHaveLength(3);
    expect(outcome.result.findingsCandidates[0]?.kind).toBe("dispersion");
    // §32 — lineage is attached by the engine, not by the code
    expect(outcome.result.sourceLineage.freshnessToken).toBe("v1");
  }, BOOT_MS);

  it("treats stdout as a side effect, not an analytical result", async () => {
    // §27 — "Do NOT treat stdout as the analytical result."
    const outcome = await runtime.execute(`print("the answer is 42")`, dataset());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("SANDBOX_RUNTIME_ERROR");
    expect(outcome.error.message).toMatch(/RESULT/);
  }, BOOT_MS);

  it("sklearn is present, so an open-ended method is actually available", async () => {
    const code = `
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
X = StandardScaler().fit_transform(data[["Jan", "Mar"]].to_numpy(dtype=float))
km = KMeans(n_clusters=2, n_init=10, random_state=0).fit(X)
RESULT = {
    "method": {"name": "kmeans", "parameters": {"n_clusters": 2}, "random_state": 0},
    "groups": [{"label": str(c), "members": [str(m) for m in data["metric"][km.labels_ == c]]} for c in sorted(set(km.labels_.tolist()))],
}
`;
    const outcome = await runtime.execute(code, dataset());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.groups.length).toBe(2);
    // §30 — a stochastic method records its seed
    expect(outcome.result.method?.randomState).toBe(0);
  }, BOOT_MS);
});

// --- §23/§25: missing is not zero ------------------------------------------

describe("Stage 27 §23/§25 — a missing observation never becomes a zero", () => {
  it("arrives as NaN, distinguishable from a recorded zero", async () => {
    const code = `
jan = data["Jan"]
feb = data["Feb"]
RESULT = {"scalars": {
    "feb_missing": float(feb.isna().sum()),
    "jan_missing": float(jan.isna().sum()),
    "jan_zeros": float((jan == 0).sum()),
    "feb_zeros": float((feb == 0).sum()),
}}
`;
    const outcome = await runtime.execute(code, dataset());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Defects/Feb is empty; Defects/Jan is a recorded 0. The two must not merge.
    expect(outcome.result.scalars["feb_missing"]).toBe(1);
    expect(outcome.result.scalars["feb_zeros"]).toBe(0);
    expect(outcome.result.scalars["jan_missing"]).toBe(0);
    expect(outcome.result.scalars["jan_zeros"]).toBe(1);
  }, BOOT_MS);

  it("reports the two counts separately in the column metadata", async () => {
    const outcome = await runtime.execute(
      `RESULT = {"scalars": {"declared_missing": float(meta[2]["missingCount"]), "declared_zero": float(meta[1]["zeroCount"])}}`,
      dataset(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.scalars["declared_missing"]).toBe(1);
    expect(outcome.result.scalars["declared_zero"]).toBe(1);
  }, BOOT_MS);
});

// --- §29: no NaN or Infinity leaks -----------------------------------------

describe("Stage 27 §29 — the envelope is validated on the way out", () => {
  it("never lets NaN or Infinity into a result", async () => {
    const code = `
import numpy as np
RESULT = {"scalars": {"nan": float("nan"), "inf": float("inf"), "real": 1.5}}
`;
    const outcome = await runtime.execute(code, dataset());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.scalars["nan"]).toBeNull();
    expect(outcome.result.scalars["inf"]).toBeNull();
    expect(outcome.result.scalars["real"]).toBe(1.5);
  }, BOOT_MS);
});

// --- §19/§20: the comparison crosses the boundary intact --------------------

describe("Stage 27 §19/§20 — a real multi-method run, round-tripped", () => {
  it("carries the comparison out of Python in the shape the engine checks", async () => {
    // Written the way a model actually writes it: snake_case keys, a metric
    // that failed to compute, and a flag among the numbers. What comes back
    // has to be the TypeScript shape, with the non-measurements gone.
    const code = [
      "import numpy as np",
      "RESULT = {",
      '  "groups": [{"label": "steady", "members": ["a", "b"], "profile": {"mean": 1.5}}],',
      '  "method": {"name": "k-means", "parameters": {"k": 2}, "random_state": 0},',
      '  "method_comparison": {',
      '    "methods": [',
      '      {"name": "k-means", "parameters": {"k": 2}, "metrics": {"silhouette": 0.62, "converged": True}},',
      '      {"name": "ward", "parameters": {"k": 2}, "metrics": {"silhouette": 0.48, "gap": float("nan")}},',
      '    ],',
      '    "selected": "k-means",',
      '    "selection_criteria": ["separation"],',
      '    "selection_evidence": {"silhouette_gap": 0.14},',
      "  },",
      "}",
    ].join("\n");
    const outcome = await runtime.execute(code, dataset());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const comparison = outcome.result.methodComparison;
    expect(comparison).toBeDefined();
    expect(comparison?.selectedMethod).toBe("k-means");
    expect(comparison?.selectionCriteria).toEqual(["separation"]);
    expect(comparison?.selectionEvidence["silhouette_gap"]).toBeCloseTo(0.14);

    // §19 — `converged: True` is a flag, not a measurement, and a NaN gap is
    // not one either. Both are dropped, and both methods still count as run
    // because each reported a real silhouette.
    expect(comparison?.methods[0]?.metrics).toEqual({ silhouette: 0.62 });
    expect(comparison?.methods[1]?.metrics).toEqual({ silhouette: 0.48 });
    expect(executedMethods(comparison!)).toHaveLength(2);
    expect(validateMethodComparison(comparison!)).toEqual([]);
  }, BOOT_MS);

  it("returns nothing at all when the script did not compare anything", async () => {
    const outcome = await runtime.execute(`RESULT = {"scalars": {"n": 1.0}}`, dataset());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.methodComparison ?? null).toBeNull();
  }, BOOT_MS);
});

// --- §72: security ----------------------------------------------------------

describe("Stage 27 §72 — every escape attempt fails safely", () => {
  /** Each entry is a real attempt, not a paraphrase of one. */
  const ATTEMPTS: readonly (readonly [string, string])[] = [
    ["filesystem — read a host path", `RESULT = {"scalars": {"n": float(len(open("C:/Windows/win.ini").read()))}}`],
    ["filesystem — list the root", `import os\nRESULT = {"scalars": {"n": float(len(os.listdir("/")))}}`],
    ["filesystem — pathlib traversal", `import pathlib\nRESULT = {"scalars": {"n": float(len(list(pathlib.Path("/").iterdir())))}}`],
    ["network — urllib", `import urllib.request\nRESULT = {"scalars": {"n": float(urllib.request.urlopen("https://example.com").status)}}`],
    ["network — requests", `import requests\nRESULT = {"scalars": {"n": float(requests.get("https://example.com").status_code)}}`],
    ["network — raw socket", `import socket\ns = socket.socket()\ns.connect(("1.1.1.1", 80))\nRESULT = {"scalars": {"n": 1.0}}`],
    ["network — pandas reads a URL", `df = pd.read_csv("https://example.com/data.csv")\nRESULT = {"scalars": {"n": float(len(df))}}`],
    ["subprocess", `import subprocess\nsubprocess.run(["cmd", "/c", "dir"])\nRESULT = {"scalars": {"n": 1.0}}`],
    ["process — os.system", `import os\nRESULT = {"scalars": {"n": float(os.system("dir"))}}`],
    ["environment", `import os\nRESULT = {"scalars": {"n": float(len(os.environ))}}`],
    ["dynamic import of the JS bridge", `js = __import__("js")\nRESULT = {"scalars": {"n": 1.0}}`],
    ["importlib reaches for the JS bridge", `import importlib\nimportlib.import_module("js")\nRESULT = {"scalars": {"n": 1.0}}`],
    ["from-import of the JS bridge", `from js import fetch\nRESULT = {"scalars": {"n": 1.0}}`],
    ["eval", `RESULT = {"scalars": {"n": float(eval("1+1"))}}`],
    ["exec", `exec("RESULT = {'scalars': {'n': 1.0}}")`],
    ["compile", `c = compile("x=1", "<s>", "exec")\nRESULT = {"scalars": {"n": 1.0}}`],
    ["introspection escape chain", `cls = ().__class__.__bases__[0]\nRESULT = {"scalars": {"n": float(len(cls.__subclasses__()))}}`],
    ["getattr laundering", `f = getattr(__builtins__, "ev" + "al")\nRESULT = {"scalars": {"n": float(f("1+1"))}}`],
    ["ctypes", `import ctypes\nRESULT = {"scalars": {"n": 1.0}}`],
  ];

  for (const [label, code] of ATTEMPTS) {
    it(`blocks: ${label}`, async () => {
      const outcome = await runtime.execute(code, dataset());
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      // Whatever the layer that caught it, the attempt must not have produced
      // an analytical result the user could be shown.
      expect(["UNSAFE_CODE", "CODE_VALIDATION_ERROR", "SANDBOX_RUNTIME_ERROR", "UNSUPPORTED_LIBRARY"]).toContain(outcome.error.code);
    }, BOOT_MS);
  }

  it("refuses the JS bridge at BOTH layers, not only the AST", async () => {
    // §16 — the AST check is defence in depth. Prove the runtime denies it too
    // by asking the runtime directly, bypassing validation entirely.
    const py = await runtime.ready();
    const bypass = (source: string): unknown =>
      py.runPython(`_sa_exec(_sa_compile(${JSON.stringify(source)}, "<t>", "exec"), {"__builtins__": _SA_SAFE_BUILTINS})`);
    expect(() => bypass("import js")).toThrow(/not available in the analytical sandbox/);
    expect(() => bypass("import os")).toThrow(/not available in the analytical sandbox/);
    // and the restricted namespace simply has no `eval` to reach for
    expect(() => bypass("eval('1+1')")).toThrow(/NameError/);
    expect(py.runPython(`str("eval" in _SA_SAFE_BUILTINS)`)).toBe("False");
  }, BOOT_MS);

  it("keeps the analytical stack working after hardening", async () => {
    const outcome = await runtime.execute(
      `import math\nimport numpy as np\nRESULT = {"scalars": {"root": float(math.sqrt(16)), "mean": float(np.mean([1.0, 2.0, 3.0]))}}`,
      dataset(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.scalars["root"]).toBe(4);
    expect(outcome.result.scalars["mean"]).toBe(2);
  }, BOOT_MS);
});

// --- §12: resource limits ---------------------------------------------------

describe("Stage 27 §12/§70 — bounded and cancellable", () => {
  /**
   * §12, measured rather than assumed.
   *
   * `runPython` is synchronous, so while WASM runs the event loop on that
   * thread does not, and a `setTimeout` scheduled beside it cannot fire. An
   * in-process runtime therefore CANNOT bound a tight loop — which is why the
   * shipping runtime is the Worker one, and why this is asserted rather than
   * left as a comment someone may later doubt.
   */
  it("the in-process runtime declares that it cannot bound CPU-bound code", () => {
    expect(runtime.hardTimeout).toBe(false);
  });

  it("terminating the worker DOES stop a runaway analysis", async () => {
    // The mechanism the shipping runtime relies on, against real Pyodide:
    // boot, enter an endless Python loop, terminate, and observe that the
    // thread actually dies instead of pinning a core forever.
    const source = [
      'import { loadPyodide } from "pyodide";',
      'import { parentPort } from "node:worker_threads";',
      'const py = await loadPyodide({ indexURL: "./node_modules/pyodide" });',
      'parentPort.postMessage("ready");',
      'py.runPython("while True:\\n    pass");',
      'parentPort.postMessage("finished");',
    ].join("\n");

    const worker = new NodeWorker(source, { eval: true });
    const messages: unknown[] = [];
    worker.on("message", (m) => messages.push(m));
    await new Promise<void>((resolve) => worker.once("message", () => resolve()));

    const started = Date.now();
    const exitCode = await worker.terminate();
    const elapsed = Date.now() - started;

    expect(messages).toEqual(["ready"]);
    // §70 — nothing arrived after the kill, so nothing can commit late.
    expect(messages).not.toContain("finished");
    expect(elapsed).toBeLessThan(15_000);
    expect(typeof exitCode).toBe("number");
  }, BOOT_MS);


  it("refuses code longer than the contract allows", async () => {
    const outcome = await runtime.execute(`RESULT = {}\n${"# padding\n".repeat(2000)}`, dataset());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("CODE_VALIDATION_ERROR");
  }, BOOT_MS);

  it("honours cancellation (§70)", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runtime.execute(`RESULT = {"scalars": {"n": 1.0}}`, dataset(), controller.signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("CANCELLED");
  }, BOOT_MS);
});

// --- §15/§66: validation feedback -------------------------------------------

describe("Stage 27 §15/§66 — refusals are specific enough to repair", () => {
  it("names the module it denied", async () => {
    const violations = await runtime.validate(`import os\nRESULT = {}`);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("IMPORT");
    expect(violations[0]?.detail).toBe("os");
  }, BOOT_MS);

  it("reports a syntax error with its line, separately from a policy refusal", async () => {
    const violations = await runtime.validate(`RESULT = {`);
    expect(violations[0]?.code).toBe("SYNTAX");
    expect(violations[0]?.line).toBeGreaterThan(0);
  }, BOOT_MS);

  it("hands the generator a hint it can act on", async () => {
    const outcome = await runtime.execute(`import os\nRESULT = {}`, dataset());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.repairHint).toMatch(/numpy, pandas/);
  }, BOOT_MS);

  it("accepts ordinary analytical code without complaint", async () => {
    const violations = await runtime.validate(`
import numpy as np
from sklearn.cluster import KMeans
x = data[["Jan"]].to_numpy(dtype=float)
RESULT = {"scalars": {"n": float(np.nansum(x))}}
`);
    expect(violations).toHaveLength(0);
  }, BOOT_MS);
});

// --- §12/§70: the host that ships -------------------------------------------

/**
 * A worker stand-in. The real termination of a runaway WASM loop is proven
 * above against Pyodide itself; what is exercised here is the HOST's decision
 * logic — when it gives up, what it reports, and whether a reply that arrives
 * after the kill can still be mistaken for an answer (§70).
 */
class FakeWorker implements SandboxWorkerLike {
  readonly sent: unknown[] = [];
  terminated = 0;
  #listeners = new Map<string, ((payload: unknown) => void)[]>();
  /** When set, a "run" is answered after this delay instead of at once. */
  replyDelayMs = 0;

  postMessage(message: unknown): void {
    this.sent.push(message);
    const msg = message as { type: string; id?: number };
    if (msg.type === "init") {
      queueMicrotask(() => this.#emit("message", { type: "ready" }));
      return;
    }
    if (msg.type === "run") {
      const reply = { type: "result", id: msg.id, envelope: { scalars: { n: 1 }, stdout: "" } };
      if (this.replyDelayMs > 0) setTimeout(() => this.#emit("message", reply), this.replyDelayMs);
      else queueMicrotask(() => this.#emit("message", reply));
    }
  }

  terminate(): void {
    this.terminated += 1;
  }

  addEventListener(type: string, listener: (payload: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  #emit(type: string, payload: unknown): void {
    // A terminated worker is silent — that is the whole point of terminating it.
    if (this.terminated > 0) return;
    for (const listener of this.#listeners.get(type) ?? []) listener({ data: payload });
  }
}

describe("Stage 27 §12/§70 — the worker host decides when to give up", () => {
  it("reports a normal result and declares a hard timeout", async () => {
    const fake = new FakeWorker();
    const host = new WorkerSandboxRuntime({ factory: () => fake });
    expect(host.hardTimeout).toBe(true);
    const outcome = await host.execute(`RESULT = {"scalars": {"n": 1.0}}`, dataset());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.scalars["n"]).toBe(1);
    expect(outcome.result.sourceLineage.sheet).toBe("Ops");
  });

  it("kills the worker at the timeout and reports it", async () => {
    const fake = new FakeWorker();
    fake.replyDelayMs = 5_000;
    const host = new WorkerSandboxRuntime({ factory: () => fake, limits: { ...SANDBOX_LIMITS, executionTimeoutMs: 50 } });
    const outcome = await host.execute(`RESULT = {}`, dataset());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("SANDBOX_TIMEOUT");
    expect(fake.terminated).toBe(1);
  });

  it("no late result can commit after the kill (§70)", async () => {
    const fake = new FakeWorker();
    fake.replyDelayMs = 60;
    const host = new WorkerSandboxRuntime({ factory: () => fake, limits: { ...SANDBOX_LIMITS, executionTimeoutMs: 20 } });
    const first = await host.execute(`RESULT = {}`, dataset());
    expect(first.ok).toBe(false);
    // Let the delayed reply fire into a worker that is already dead.
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.terminated).toBe(1);
  });

  it("cancellation kills the worker too", async () => {
    const fake = new FakeWorker();
    fake.replyDelayMs = 5_000;
    const host = new WorkerSandboxRuntime({ factory: () => fake });
    const controller = new AbortController();
    const running = host.execute(`RESULT = {}`, dataset(), controller.signal);
    setTimeout(() => controller.abort(), 20);
    const outcome = await running;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("CANCELLED");
    expect(fake.terminated).toBe(1);
  });
});
