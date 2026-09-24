// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createNodeSandbox, HARNESS_INDEX_URL } from "./node-sandbox.js";
import { benchmarkPortfolio } from "./sandbox-tables.js";
import { buildDataset } from "../sandbox/dataset.js";
import { runAnalysisAgent, type AgentContext, type SessionRuntime } from "../sandbox/analysis-agent.js";
import { renderObservation } from "../sandbox/analysis-observation.js";
import type { SandboxPlan } from "../sandbox/types.js";

const BOOT_MS = 180_000;
const NEWLINE = String.fromCharCode(10);
const vendored = existsSync(HARNESS_INDEX_URL);
const sandbox = createNodeSandbox();

afterAll(async () => {
  await sandbox.dispose();
});

const table = benchmarkPortfolio();
const built = buildDataset({ schema: table.schema, grids: table.grids });

function dataset(): Parameters<SessionRuntime["step"]>[2] {
  if (!built.ok) throw new Error("the benchmark dataset did not build");
  return built.dataset;
}

const py = (...lines: readonly string[]): string => lines.join(NEWLINE);

const EXECUTE = (code: string): string => JSON.stringify({ action: "EXECUTE_CODE", purpose: "step", code });
const COMPLETE = (...refs: string[]): string => JSON.stringify({ action: "COMPLETE", primaryResultRefs: refs, supportingResultRefs: [] });

function plan(over: Partial<SandboxPlan> = {}): SandboxPlan {
  return {
    objective: "group the products by how they moved",
    datasetRefs: [dataset().datasetId],
    requestedOutputs: [{ id: "o1", description: "the products, grouped", shape: "table" }],
    ...over,
  };
}

/**
 * A deterministic stand-in for the analytical agent.
 *
 * `first` is the opening action. Every subsequent action comes from `react`,
 * which is handed the LAST OBSERVATION as the agent would see it — the
 * rendered text, not the internal object — and must decide from that. If it
 * returns null the run completes with `refs`.
 *
 * The important constraint is what `react` does NOT receive: no access to the
 * runtime, no list of pre-written fixes, and no signal other than the
 * observation. A responder that cannot recover from the observation alone
 * fails these tests, which is the property §7 exists to give.
 */
function observationDriven(params: {
  readonly first: string;
  readonly react: (observation: string, round: number) => string | null;
  readonly refs: readonly string[];
}): { readonly decide: (c: AgentContext) => Promise<string>; readonly seen: string[] } {
  const seen: string[] = [];
  let round = 0;
  return {
    seen,
    decide: async (context: AgentContext) => {
      round += 1;
      if (round === 1) return params.first;
      const last = context.observations[context.observations.length - 1];
      const rendered = last ? renderObservation(last) : "";
      seen.push(rendered);
      return params.react(rendered, round) ?? COMPLETE(...params.refs);
    },
  };
}

const EMIT_GROUPS = py(
  "profile = numeric_data.dropna()",
  'result.missing_policy("exclude", "rows with gaps are dropped", affected_rows=int(numeric_data.isna().any(axis=1).sum()))',
  'result.method("summary", {}, random_state=0)',
  'frame = pd.DataFrame({"metric": entity_data.iloc[:, 0].loc[profile.index], "total": profile.sum(axis=1)})',
  'result.emit("table", "product_totals", value=frame)',
);

async function runWith(decide: (c: AgentContext) => Promise<string>, sessionId: string) {
  return runAnalysisAgent({
    runtime: sandbox.runtime as unknown as SessionRuntime,
    sessionId,
    request: "Сгруппируй продукты по динамике",
    plan: plan(),
    dataset: dataset(),
    decide,
    currentSourceVersion: () => dataset().freshnessToken,
  });
}

// --- §28–§31 the four controlled recoveries --------------------------------

describe.skipIf(!vendored)("Stage 27.2A §28–§31 — controlled recovery against real Python", () => {
  it(
    "§28 — NameError: the observation names what exists, and the next step uses it",
    async () => {
      const script = observationDriven({
        // The exact mistake the live runs produced.
        first: EXECUTE('labels = entity_df["metric"]'),
        react: (observation) => {
          // Recover ONLY from what the observation says. If Python did not
          // report the real name, this cannot succeed — which is the test.
          if (observation.includes("NameError") && observation.includes("entity_data")) return EXECUTE(EMIT_GROUPS);
          return null;
        },
        refs: ["product_totals"],
      });
      const outcome = await runWith(script.decide, "live-nameerror");

      expect(script.seen[0]).toContain("NameError");
      expect(script.seen[0]).toContain("entity_df");
      expect(script.seen[0]).toContain("entity_data");
      expect(outcome.status).toBe("complete");
      expect(outcome.metrics.selfRecoveryOpportunity).toBe(true);
      expect(outcome.metrics.selfRecoverySuccess).toBe(true);
    },
    BOOT_MS,
  );

  it(
    "§29 — a wrong pandas call on an ndarray comes back as something actionable",
    async () => {
      const script = observationDriven({
        first: EXECUTE("clean = X.fillna(0)"),
        react: (observation) => {
          // The observation must identify the type that does not have the
          // method; without that the agent has nothing to change.
          if (/AttributeError|TypeError/.test(observation) && observation.includes("fillna")) return EXECUTE(EMIT_GROUPS);
          return null;
        },
        refs: ["product_totals"],
      });
      const outcome = await runWith(script.decide, "live-wrongapi");

      expect(script.seen[0]).toMatch(/AttributeError|TypeError/);
      expect(script.seen[0]).toContain("X.fillna");
      expect(outcome.status).toBe("complete");
      expect(outcome.metrics.executionErrors).toBe(1);
    },
    BOOT_MS,
  );

  it(
    "§30 — a shape mismatch reports the shapes",
    async () => {
      const script = observationDriven({
        first: EXECUTE(py("mask = np.array([True, False])", "subset = numeric_data[mask]")),
        react: (observation, round) => {
          // §30: "observation includes relevant shapes → model inspects/fixes
          // alignment". The inspection is a real INSPECT action.
          if (round === 2) return JSON.stringify({ action: "INSPECT", purpose: "check the row count", target: "variable.summary", variable: "numeric_data" });
          if (observation.includes("shape:")) return EXECUTE(EMIT_GROUPS);
          return null;
        },
        refs: ["product_totals"],
      });
      const outcome = await runWith(script.decide, "live-shape");

      expect(script.seen[0]).toMatch(/ValueError|IndexError|Boolean index/);
      // The inspection answered with the real row count, from Python.
      expect(script.seen[1]).toContain("shape:");
      expect(outcome.status).toBe("complete");
      expect(outcome.metrics.inspections).toBe(1);
    },
    BOOT_MS,
  );

  it(
    "§31 — a SyntaxError returns its failing line and the session stays clean",
    async () => {
      const script = observationDriven({
        first: EXECUTE(py("features = numeric_data.dropna(", "print(features)")),
        react: (observation) => (observation.includes("SyntaxError") ? EXECUTE(EMIT_GROUPS) : null),
        refs: ["product_totals"],
      });
      const outcome = await runWith(script.decide, "live-syntax");

      expect(script.seen[0]).toContain("SyntaxError");
      // §1 lists SyntaxError first among what an agent recovers from: it must
      // be an observation, never a refusal that ends the turn.
      expect(outcome.status).toBe("complete");
    },
    BOOT_MS,
  );
});

// --- §45 multi-step, persistence and emission ------------------------------

describe.skipIf(!vendored)("Stage 27.2A §45 — multi-step work against real Python", () => {
  it(
    "builds a result across three steps, each using the last one's variables",
    async () => {
      const steps = [
        EXECUTE("profile = numeric_data.dropna()"),
        EXECUTE("totals = profile.sum(axis=1)"),
        EXECUTE(
          py(
            'result.missing_policy("exclude", "rows with gaps are dropped", affected_rows=int(numeric_data.isna().any(axis=1).sum()))',
            'result.method("row_totals", {}, random_state=0)',
            'frame = pd.DataFrame({"metric": entity_data.iloc[:, 0].loc[totals.index], "total": totals})',
            'result.emit("table", "product_totals", value=frame)',
          ),
        ),
      ];
      let i = 0;
      const outcome = await runWith(async () => steps[i++] ?? COMPLETE("product_totals"), "live-multistep");

      expect(outcome.status).toBe("complete");
      if (outcome.status !== "complete") return;
      expect(outcome.metrics.codeExecutions).toBe(3);
      // §42 — provenance survives iterative execution.
      expect(outcome.result.sourceLineage.freshnessToken).toBe(dataset().freshnessToken);
      expect(outcome.result.sourceLineage.datasetIds).toContain(dataset().datasetId);
      const emitted = outcome.result.tables.find((t) => t.name === "product_totals");
      expect(emitted?.rows.length).toBeGreaterThan(0);
      // The first column holds real labels, not row positions (§20 label check).
      expect(typeof emitted?.rows[0]?.[0]).toBe("string");
    },
    BOOT_MS,
  );

  it(
    "§19 — naming a result that was never emitted is refused by real collection",
    async () => {
      const steps = [EXECUTE(EMIT_GROUPS), COMPLETE("anomaly_scores"), COMPLETE("product_totals")];
      let i = 0;
      const outcome = await runWith(async () => steps[i++] ?? COMPLETE("product_totals"), "live-badref");

      // The first COMPLETE was rejected against the real envelope; the second,
      // naming what was actually there, was accepted.
      expect(outcome.status).toBe("complete");
      expect(outcome.metrics.completionRejections).toBe(1);
    },
    BOOT_MS,
  );

  it(
    "a failed step does not cost the work of the steps before it",
    async () => {
      const steps = [
        EXECUTE("profile = numeric_data.dropna()"),
        EXECUTE("boom = profile.this_method_does_not_exist()"),
        EXECUTE(
          py(
            'result.method("row_totals", {}, random_state=0)',
            'frame = pd.DataFrame({"metric": entity_data.iloc[:, 0].loc[profile.index], "total": profile.sum(axis=1)})',
            'result.emit("table", "product_totals", value=frame)',
          ),
        ),
      ];
      let i = 0;
      const outcome = await runWith(async () => steps[i++] ?? COMPLETE("product_totals"), "live-survives");

      // Step 3 used `profile` from step 1, across the failure in step 2.
      expect(outcome.status).toBe("complete");
      expect(outcome.metrics.executionErrors).toBe(1);
      expect(outcome.metrics.selfRecoverySuccess).toBe(true);
    },
    BOOT_MS,
  );
});

// --- §40/§41 security across rounds ----------------------------------------

describe.skipIf(!vendored)("Stage 27.2A §40/§41 — a session earns no concessions", () => {
  it(
    "§40 — a safe first step does not buy an unsafe second one",
    async () => {
      const steps = [EXECUTE("profile = numeric_data.dropna()"), EXECUTE(py("import os", "os.listdir('.')"))];
      let i = 0;
      const outcome = await runWith(async () => steps[i++] ?? COMPLETE("product_totals"), "live-security");

      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.failure).toBe("SECURITY_FAILURE");
        expect(outcome.error.code).toBe("UNSAFE_CODE");
      }
      // §68 of Stage 27 — and it is not retried.
      expect(outcome.metrics.codeExecutions).toBe(2);
    },
    BOOT_MS,
  );

  it(
    "§41 — a workbook string stays data through every round",
    async () => {
      // The benchmark table carries the injection canary. Reading it in one
      // step and observing it in the next must not turn it into an instruction.
      const steps = [
        EXECUTE(py("hostile = [str(v) for v in data.iloc[:, 0].tolist()]", "kind = type(hostile[0]).__name__", "print(kind)")),
        EXECUTE(
          py(
            'result.method("row_totals", {}, random_state=0)',
            'frame = pd.DataFrame({"metric": entity_data.iloc[:, 0], "total": numeric_data.sum(axis=1)})',
            'result.emit("table", "product_totals", value=frame)',
          ),
        ),
      ];
      let i = 0;
      const outcome = await runWith(async () => steps[i++] ?? COMPLETE("product_totals"), "live-injection");

      expect(outcome.status).toBe("complete");
      // Nothing executed a shell; the canary is a string and stayed one.
      expect(outcome.metrics.executionErrors).toBe(0);
    },
    BOOT_MS,
  );
});
