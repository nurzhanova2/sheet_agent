// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VENDORED_INDEX_URL, resolvedAgainstDocument } from "./sandbox/runtime-factory.js";
import { analyticalAgentLoopEnabled, analyticalAgentLoopFlagSource } from "./feature-flag.js";

const DIST = "dist";
const built = existsSync(join(DIST, "taskpane.html"));

describe("Stage 27.4 §39 — the packaged sandbox finds its runtime", () => {
  const documentUrl = "https://localhost:47831/taskpane.html";
  const workerUrl = "https://localhost:47831/assets/sandbox-worker-BTL-dq9S.js";

  const withDocumentAt = <T,>(baseURI: string, run: () => T): T => {
    const host = globalThis as { document?: { baseURI: string } };
    const previous = host.document;
    host.document = { baseURI };
    try {
      return run();
    } finally {
      if (previous === undefined) delete host.document;
      else host.document = previous;
    }
  };

  it("hands the worker an absolute URL rooted at the served document", () => {
    expect(withDocumentAt(documentUrl, () => resolvedAgainstDocument(VENDORED_INDEX_URL))).toBe("https://localhost:47831/pyodide/");
  });

  it("follows the document when the add-in is served from a sub-path", () => {
    expect(withDocumentAt("https://localhost:47831/addin/taskpane.html", () => resolvedAgainstDocument(VENDORED_INDEX_URL))).toBe(
      "https://localhost:47831/addin/pyodide/",
    );
  });

  it("does not leave the bare path for the worker to resolve against its own chunk directory", () => {
    expect(new URL(VENDORED_INDEX_URL, workerUrl).toString()).toBe("https://localhost:47831/assets/pyodide/");
    expect(withDocumentAt(documentUrl, () => resolvedAgainstDocument(VENDORED_INDEX_URL))).not.toBe(new URL(VENDORED_INDEX_URL, workerUrl).toString());
  });

  it("leaves the path alone where there is no document, which is the Node harness", () => {
    expect(resolvedAgainstDocument("./public/pyodide")).toBe("./public/pyodide");
    expect(resolvedAgainstDocument(VENDORED_INDEX_URL)).toBe(VENDORED_INDEX_URL);
  });
});

describe.skipIf(!built)("Stage 27.4 §39/§47 — the build output carries what Pyodide needs", () => {
  const required = ["pyodide.asm.wasm", "pyodide.asm.mjs", "pyodide.mjs", "pyodide-lock.json", "python_stdlib.zip"];

  it.each(required)("ships %s at the document root", (name) => {
    expect(existsSync(join(DIST, "pyodide", name))).toBe(true);
  });

  it("ships the analytical wheels the sandbox loads", () => {
    const wheels = readdirSync(join(DIST, "pyodide")).filter((f) => f.endsWith(".whl"));
    for (const required_wheel of ["numpy", "pandas", "scikit_learn", "scipy"]) {
      expect(wheels.some((w) => w.startsWith(required_wheel))).toBe(true);
    }
  });

  it("emits the analysis worker as its own module chunk", () => {
    const assets = readdirSync(join(DIST, "assets"));
    expect(assets.some((f) => f.startsWith("sandbox-worker-") && f.endsWith(".js"))).toBe(true);
  });

  it("constructs that worker as a module, which is what lets Pyodide code-split", () => {
    const taskpane = readdirSync(join(DIST, "assets")).find((f) => f.startsWith("taskpane-") && f.endsWith(".js"));
    expect(taskpane).toBeDefined();
    const source = readFileSync(join(DIST, "assets", taskpane!), "utf8");
    expect(source).toMatch(/new Worker\(new URL\("[^"]*sandbox-worker-[^"]*"[^)]*\),\{type:"module"/u);
  });

  it("references no content delivery network for the analytical runtime", () => {
    const worker = readdirSync(join(DIST, "assets")).find((f) => f.startsWith("sandbox-worker-"));
    const source = readFileSync(join(DIST, "assets", worker!), "utf8");
    expect(source).not.toMatch(/cdn\.jsdelivr\.net\/pyodide/u);
  });
});

describe("Stage 27.4 §13 — the one remaining agent flag", () => {
  it("keeps the iterative agent loop off by default", () => {
    expect(analyticalAgentLoopEnabled()).toBe(false);
    expect(analyticalAgentLoopFlagSource()).toBe("default(off)");
  });
});

describe("Stage 27.4 §51 — benchmark instrumentation is not on the user's path", () => {
  const sourceFiles = (dir: string): readonly string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
      return entry.isFile() && /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
    });

  it("no shipped module imports the live harness", () => {
    const offenders = sourceFiles("src")
      .filter((path) => !path.includes(join("analytical-engine-v2", "harness")))
      .filter((path) => /from ["'][^"']*harness\//u.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
