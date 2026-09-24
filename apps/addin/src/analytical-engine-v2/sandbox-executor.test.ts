// ---------------------------------------------------------------------------
// Stage 27 §5/§29/§66/§67/§69 — the repair loop and what it refuses.
//
// A fake runtime on purpose: these are decisions the executor makes, and a
// real Pyodide boot would only make them slower to assert. The runtime's own
// behaviour is covered against real Pyodide in `sandbox.test.ts`.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { executeAnalysis, hashCode, validateAgainstPlan, validateEnvelope, type AnalyticalRuntime, type CodeRequest } from "./sandbox/executor.js";
import type { ExecuteOutcome } from "./sandbox/pyodide-runtime.js";
import { SANDBOX_LIMITS, type SandboxDataset, type SandboxError, type SandboxPlan, type SandboxResult } from "./sandbox/types.js";

function dataset(token = "v1"): SandboxDataset {
  return {
    datasetId: "ds1",
    tableRef: "S!A1:C3",
    sheet: "S",
    sourceRange: "S!A1:C3",
    freshnessToken: token,
    columns: [
      { name: "metric", semanticType: "metric_label", missingCount: 0, zeroCount: 0 },
      { name: "Jan", semanticType: "amount", missingCount: 0, zeroCount: 0 },
    ],
    rows: [["a", 1] as readonly CellValue[], ["b", 2] as readonly CellValue[]],
  };
}

function plan(shape: SandboxPlan["requestedOutputs"][number]["shape"] = "groups"): SandboxPlan {
  return {
    objective: "segment the metrics by the shape of their monthly dynamics",
    datasetRefs: ["ds1"],
    requestedOutputs: [{ id: "o1", description: "the segments", shape }],
  };
}

function emptyResult(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    executionId: "exec_1",
    status: "ok",
    tables: [],
    scalars: {},
    series: [],
    groups: [],
    models: [],
    diagnostics: {},
    findingsCandidates: [],
    warnings: [],
    artifacts: [],
    sourceLineage: { datasetIds: ["ds1"], sheet: "S", sourceRange: "S!A1:C3", freshnessToken: "v1" },
    ...overrides,
  };
}

/** A runtime whose every execution outcome is scripted. */
function fakeRuntime(outcomes: readonly ExecuteOutcome[]): AnalyticalRuntime & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    hardTimeout: true,
    validate: async () => [],
    execute: async (code) => {
      calls.push(code);
      const next = outcomes[Math.min(i, outcomes.length - 1)]!;
      i += 1;
      return next;
    },
  };
}

const ok = (result: SandboxResult): ExecuteOutcome => ({ ok: true, result, stdout: "", durationMs: 1 });
const err = (error: SandboxError): ExecuteOutcome => ({ ok: false, error, durationMs: 1 });

describe("Stage 27 §29 — a result must contain what the plan asked for", () => {
  it("accepts a result carrying the requested shape", () => {
    const result = emptyResult({ groups: [{ label: "A", members: ["a"] }] });
    expect(validateAgainstPlan(plan("groups"), result)).toHaveLength(0);
  });

  it("rejects a result that answers a different shape", () => {
    // §5 in structural form: segmentation was requested, tables came back.
    const result = emptyResult({ tables: [{ name: "trend", columns: ["m"], rows: [["a"]] }] });
    const problems = validateAgainstPlan(plan("groups"), result);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/did not return the requested groups/);
  });

  it("catches a malformed envelope independently of the plan", () => {
    const ragged = emptyResult({ tables: [{ name: "t", columns: ["a", "b"], rows: [[1]] }] });
    expect(validateEnvelope(ragged, SANDBOX_LIMITS)[0]).toMatch(/row of 1 values against 2 columns/);

    const mismatched = emptyResult({ series: [{ name: "s", index: ["a", "b"], values: [1] }] });
    expect(validateEnvelope(mismatched, SANDBOX_LIMITS)[0]).toMatch(/index entries against/);

    const empty = emptyResult({ groups: [{ label: "A", members: [] }] });
    expect(validateEnvelope(empty, SANDBOX_LIMITS)[0]).toMatch(/no members/);
  });
});

describe("Stage 27 §66 — bounded repair, driven by the generator", () => {
  it("retries a runtime error and succeeds on the second attempt", async () => {
    const runtime = fakeRuntime([
      err({ code: "SANDBOX_RUNTIME_ERROR", message: "KeyError: 'Feb'", repairHint: "KeyError: 'Feb'" }),
      ok(emptyResult({ groups: [{ label: "A", members: ["a"] }] })),
    ]);
    const generate = vi.fn(async (req: CodeRequest) => `code_v${req.attempt}`);
    const outcome = await executeAnalysis({ runtime, plan: plan(), dataset: dataset(), generate, currentSourceVersion: () => "v1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);
    // §66 — the failure went BACK to the generator, with the code that failed
    expect(generate.mock.calls[1]?.[0]).toMatchObject({ previous: "code_v1", failure: { code: "SANDBOX_RUNTIME_ERROR" } });
  });

  it("treats a plan-coverage miss as repairable and says what was missing", async () => {
    const runtime = fakeRuntime([
      ok(emptyResult({ tables: [{ name: "t", columns: ["m"], rows: [["a"]] }] })),
      ok(emptyResult({ groups: [{ label: "A", members: ["a"] }] })),
    ]);
    const generate = vi.fn(async (req: CodeRequest) => `code_v${req.attempt}`);
    const outcome = await executeAnalysis({ runtime, plan: plan("groups"), dataset: dataset(), generate, currentSourceVersion: () => "v1" });

    expect(outcome.ok).toBe(true);
    // Stage 27.x.1 §12 — the first attempt RETURNED a table, so something was
    // computed and only the filing was wrong. The repair says so, quotes the
    // contract, and tells the generator not to touch the method: a model told
    // "the analysis did not produce what was asked for" rewrites an analysis
    // that was working, and turns a shape mismatch into a second failure.
    const hint = generate.mock.calls[1]?.[0]?.failure?.repairHint ?? "";
    expect(hint).toMatch(/computation completed/);
    expect(hint).toMatch(/Do not change the analytical method/);
    expect(hint).toContain('RESULT["groups"]');
    expect(generate.mock.calls[1]?.[0]?.failure?.subtype).toBe("OUTPUT_SHAPE_MISMATCH");
  });

  it("does NOT claim the computation completed when the script returned nothing", async () => {
    // §12's cheap repair is only safe because it is gated on evidence that a
    // number was produced. An empty envelope did not get that far, and telling
    // it to keep a method that never ran would be advice about nothing.
    const runtime = fakeRuntime([ok(emptyResult({})), ok(emptyResult({ groups: [{ label: "A", members: ["a"] }] }))]);
    const generate = vi.fn(async (req: CodeRequest) => `code_v${req.attempt}`);
    const outcome = await executeAnalysis({ runtime, plan: plan("groups"), dataset: dataset(), generate, currentSourceVersion: () => "v1" });

    expect(outcome.ok).toBe(true);
    expect(generate.mock.calls[1]?.[0]?.failure?.repairHint).toMatch(/did not produce what was asked for/);
    expect(generate.mock.calls[1]?.[0]?.failure?.subtype).toBeUndefined();
  });

  it("never retries unsafe code", async () => {
    // §68 — each retry of attacker-shaped code is another execution of it.
    const runtime = fakeRuntime([err({ code: "UNSAFE_CODE", message: "IMPORT:os" })]);
    const generate = vi.fn(async () => "import os");
    const outcome = await executeAnalysis({ runtime, plan: plan(), dataset: dataset(), generate, currentSourceVersion: () => "v1" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("UNSAFE_CODE");
    expect(outcome.attempts).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("stops at the attempt budget and reports the failure (§67)", async () => {
    const runtime = fakeRuntime([err({ code: "SANDBOX_RUNTIME_ERROR", message: "boom" })]);
    const generate = vi.fn(async (req: CodeRequest) => `code_v${req.attempt}`);
    const outcome = await executeAnalysis({ runtime, plan: plan(), dataset: dataset(), generate, currentSourceVersion: () => "v1" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(SANDBOX_LIMITS.maxAttempts);
    // §67 — no substituted analysis, no partial result dressed as an answer
    expect(outcome.error.code).toBe("SANDBOX_RUNTIME_ERROR");
  });
});

describe("Stage 27 §69 — freshness is checked twice", () => {
  it("refuses to start when the workbook has already moved", async () => {
    const runtime = fakeRuntime([ok(emptyResult({ groups: [{ label: "A", members: ["a"] }] }))]);
    const outcome = await executeAnalysis({ runtime, plan: plan(), dataset: dataset("v1"), generate: async () => "code", currentSourceVersion: () => "v2" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("STALE_DATASET");
    // nothing was even executed
    expect(runtime.calls).toHaveLength(0);
  });

  it("refuses to commit a result whose data moved while it ran", async () => {
    const runtime = fakeRuntime([ok(emptyResult({ groups: [{ label: "A", members: ["a"] }] }))]);
    let version = "v1";
    const outcome = await executeAnalysis({
      runtime,
      plan: plan(),
      dataset: dataset("v1"),
      generate: async () => {
        // the user edits a cell while the analysis is in flight
        version = "v2";
        return "code";
      },
      currentSourceVersion: () => version,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("STALE_DATASET");
    expect(outcome.error.message).toMatch(/while the analysis was running/);
  });
});

describe("Stage 27 §70/§62 — cancellation and identity", () => {
  it("stops before generating when already cancelled", async () => {
    const runtime = fakeRuntime([ok(emptyResult())]);
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn(async () => "code");
    const outcome = await executeAnalysis({
      runtime,
      plan: plan(),
      dataset: dataset(),
      generate,
      currentSourceVersion: () => "v1",
      signal: controller.signal,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("CANCELLED");
    expect(generate).not.toHaveBeenCalled();
  });

  it("hashes the exact code that ran, stably (§62)", () => {
    const a = hashCode("RESULT = {}");
    expect(a).toBe(hashCode("RESULT = {}"));
    expect(a).not.toBe(hashCode("RESULT = {} "));
    expect(a).toHaveLength(16);
  });

  it("reports every attempt to the observer (§71)", async () => {
    const runtime = fakeRuntime([err({ code: "SANDBOX_RUNTIME_ERROR", message: "boom" }), ok(emptyResult({ groups: [{ label: "A", members: ["a"] }] }))]);
    const seen: { attempt: number; ok: boolean }[] = [];
    await executeAnalysis({
      runtime,
      plan: plan(),
      dataset: dataset(),
      generate: async (req) => `code_v${req.attempt}`,
      currentSourceVersion: () => "v1",
      onAttempt: (info) => seen.push({ attempt: info.attempt, ok: info.ok }),
    });
    expect(seen).toEqual([
      { attempt: 1, ok: false },
      { attempt: 2, ok: true },
    ]);
  });
});
