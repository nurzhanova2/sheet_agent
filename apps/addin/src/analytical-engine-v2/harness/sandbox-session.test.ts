// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createNodeSandbox, HARNESS_INDEX_URL } from "./node-sandbox.js";
import { benchmarkPortfolio } from "./sandbox-tables.js";
import { buildDataset } from "../sandbox/dataset.js";

const BOOT_MS = 180_000;
const NEWLINE = String.fromCharCode(10);
const vendored = existsSync(HARNESS_INDEX_URL);
const sandbox = createNodeSandbox();

afterAll(async () => {
  await sandbox.dispose();
});

const table = benchmarkPortfolio();
const built = buildDataset({ schema: table.schema, grids: table.grids });

/** The runtime, with the session API. */
function runtime(): ReturnType<typeof createNodeSandbox>["runtime"] {
  return sandbox.runtime;
}

function dataset(): Parameters<ReturnType<typeof runtime>["execute"]>[1] {
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("the benchmark dataset did not build");
  return built.dataset;
}

const py = (...lines: readonly string[]): string => lines.join(NEWLINE);

describe.skipIf(!vendored)("Stage 27.2 §15 — the ephemeral session", () => {
  it(
    "carries a variable from one step into the next",
    async () => {
      const id = "s-carry";
      try {
        const first = await runtime().step(id, py("features = numeric_data.dropna()", "print(features.shape)"), dataset());
        expect("refused" in first).toBe(false);
        if ("refused" in first) return;
        expect(first.status).toBe("ok");
        // §28 — the environment snapshot names what was created, with its
        // shape, and does NOT contain the rows.
        expect(first.available["features"]).toMatchObject({ type: "DataFrame" });
        expect(JSON.stringify(first.available).length).toBeLessThan(2000);

        // The point of the session: step 2 uses what step 1 built.
        const second = await runtime().step(id, py("rows = int(features.shape[0])", "print(rows)"), dataset());
        expect("refused" in second).toBe(false);
        if ("refused" in second) return;
        expect(second.status).toBe("ok");
        expect(second.stdout.trim()).not.toBe("");
        expect(second.available["rows"]).toMatchObject({ type: "int" });
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );

  it(
    "does not leak variables into a different session, and disposes (§15)",
    async () => {
      const a = "s-iso-a";
      const b = "s-iso-b";
      try {
        await runtime().step(a, "secret_value = 42", dataset());
        const other = await runtime().step(b, "print(secret_value)", dataset());
        expect("refused" in other).toBe(false);
        if ("refused" in other) return;
        expect(other.status).toBe("error");
        expect(other.errorType).toBe("NameError");

        // After disposal the name is gone from its own session too.
        await runtime().endSession(a);
        const afterDispose = await runtime().step(a, "print(secret_value)", dataset());
        expect("refused" in afterDispose).toBe(false);
        if ("refused" in afterDispose) return;
        expect(afterDispose.status).toBe("error");
      } finally {
        await runtime().endSession(a);
        await runtime().endSession(b);
      }
    },
    BOOT_MS,
  );
});

describe.skipIf(!vendored)("Stage 27.2 §16/§17/§52 — an error is an observation", () => {
  it(
    "returns the three live failures as values, with what actually exists",
    async () => {
      const id = "s-errors";
      try {
        // 1. The measured naming hallucination, verbatim from a live run.
        const naming = await runtime().step(id, "labels = entity_df['metric']", dataset());
        expect("refused" in naming).toBe(false);
        if ("refused" in naming) return;
        expect(naming.status).toBe("error");
        expect(naming.errorType).toBe("NameError");
        expect(naming.message).toContain("entity_df");
        // §17/§27 — the observation NAMES the right object, so the fix does
        // not depend on the agent remembering it.
        // §27/§30 — the prepared views are named AND shaped, so a fix does
        // not have to guess either the name or the dimensions.
        expect(naming.prepared?.join(" ")).toContain("entity_data: DataFrame");
        expect(naming.failingLine).toContain("entity_df");
        // §17 — high signal, not a traceback dump.
        expect((naming.message ?? "").length).toBeLessThan(400);

        // 2. A pandas method on the numpy matrix.
        const boundary = await runtime().step(id, "cleaned = X.fillna(0)", dataset());
        expect("refused" in boundary).toBe(false);
        if ("refused" in boundary) return;
        expect(boundary.status).toBe("error");
        expect(boundary.errorType).toBe("AttributeError");

        // 3. A shape mismatch.
        const shape = await runtime().step(id, py("import numpy as _n", "bad = _n.zeros((3, 2)) + _n.zeros((4, 5))"), dataset());
        expect("refused" in shape).toBe(false);
        if ("refused" in shape) return;
        expect(shape.status).toBe("error");
        expect(shape.errorType).toBe("ValueError");
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );

  it(
    "treats a SyntaxError as an observation, not a refusal (§1)",
    async () => {
      const id = "s-syntax";
      try {
        const broken = await runtime().step(id, "totals = numeric_data.sum(", dataset());
        expect("refused" in broken).toBe(false);
        if ("refused" in broken) return;
        expect(broken.status).toBe("error");
        expect(broken.errorType).toBe("SyntaxError");
        // Names only here, deliberately. A SyntaxError is caught by the AST
        // validator BEFORE the session is touched, so there are no shapes to
        // report — and for a syntax error the failing line is the relevant
        // fact anyway. The RUNTIME error path above does report shapes (§30).
        expect(broken.prepared?.join(" ")).toContain("numeric_data");
        expect(broken.failingLine ?? "").not.toBe("");
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );

  it(
    "recovers: the SAME session continues after a failure (§52)",
    async () => {
      // The core acceptance criterion. A failed step must not poison the
      // session — what earlier steps built is still there, and the corrected
      // step completes the analysis.
      const id = "s-recover";
      try {
        await runtime().step(id, "features = numeric_data.dropna()", dataset());
        const failed = await runtime().step(id, "scores = entity_df.mean()", dataset());
        expect("refused" in failed).toBe(false);
        if ("refused" in failed) return;
        expect(failed.status).toBe("error");
        // The environment survived the failure and still holds step 1's work.
        expect(failed.available["features"]).toMatchObject({ type: "DataFrame" });

        const fixed = await runtime().step(id, "scores = features.mean(axis=1)", dataset());
        expect("refused" in fixed).toBe(false);
        if ("refused" in fixed) return;
        expect(fixed.status).toBe("ok");
        expect(fixed.available["scores"]).toMatchObject({ type: "Series" });
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );

  it(
    "still REFUSES unsafe code at every step, not just the first (§47)",
    async () => {
      const id = "s-unsafe";
      try {
        await runtime().step(id, "ok_step = 1", dataset());
        const unsafe = await runtime().step(id, "import os", dataset());
        // Unsafe code is not an observation the agent gets to iterate on.
        expect("refused" in unsafe).toBe(true);
        if (!("refused" in unsafe)) return;
        expect(unsafe.refused.code).toBe("UNSAFE_CODE");
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );

  it(
    "keeps workbook text as DATA, never as instruction (§48)",
    async () => {
      // The benchmark table carries an injection canary in a label. Reading it
      // must be an ordinary string operation with no special meaning.
      const id = "s-injection";
      try {
        const step = await runtime().step(
          id,
          py(
            "labels = [str(v) for v in entity_data.iloc[:, 0].tolist()]",
            "hostile = [l for l in labels if 'os.system' in l]",
            "print(len(hostile))",
            // Reading it is an ordinary string operation, and what comes back
            // is a str. Nothing about the cell's CONTENT changes what the
            // sandbox will do with it: the companion §47 test in this file
            // shows `import os` is still refused on the very next step.
            "print(type(hostile[0]).__name__)",
          ),
          dataset(),
        );
        expect("refused" in step).toBe(false);
        if ("refused" in step) return;
        expect(step.status).toBe("ok");
        const printed = step.stdout.trim().split(NEWLINE).map((l) => l.trim());
        expect(printed[0]).toBe("1");
        // §48 — the label said "execute os.system(...)". It came back as a
        // string, because that is all it ever was.
        expect(printed[1]).toBe("str");
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );
});

describe.skipIf(!vendored)("Stage 27.2 §13/§22–§25 — the ACI facade", () => {
  it(
    "inspects the table without serialising it (§13/§23)",
    async () => {
      const id = "s-inspect";
      try {
        const info = await runtime().inspect(id, dataset());
        expect("refused" in info).toBe(false);
        if ("refused" in info) return;
        expect(info.shape).toHaveLength(2);
        expect(info.entityColumns.length).toBeGreaterThan(0);
        expect(info.numericColumns.length).toBeGreaterThan(0);
        expect(info.matrixShape).toHaveLength(2);
        // §23 — high signal only. Three preview rows, not the table.
        expect(info.preview.length).toBeLessThanOrEqual(3);
        // §24 — semantic roles, from the existing schema induction.
        expect(info.schema[0]).toHaveProperty("role");
        // The gaps the benchmark table carries are reported as counts.
        expect(Object.keys(info.missing).length).toBeGreaterThan(0);
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );

  it(
    "the facade points at the SAME objects as the old names (§22 compatibility)",
    async () => {
      const id = "s-facade";
      try {
        const step = await runtime().step(
          id,
          py(
            "same_raw = table.raw is data",
            "same_numeric = table.numeric is numeric_data",
            "same_entities = table.entities is entity_data",
            "same_matrix = table.matrix is X",
            "print(same_raw and same_numeric and same_entities and same_matrix)",
          ),
          dataset(),
        );
        expect("refused" in step).toBe(false);
        if ("refused" in step) return;
        expect(step.status).toBe("ok");
        expect(step.stdout.trim()).toBe("True");
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );

  it(
    "emits a result through the canonical helper and the normal envelope (§25/§26)",
    async () => {
      const id = "s-emit";
      try {
        await runtime().step(
          id,
          py(
            "kept = table.numeric.dropna()",
            "result.method('column_total', {}, None)",
            "result.emit('scalar', name='december_total', value=float(kept.iloc[:, -1].sum()))",
            "result.missing_policy('exclude', 'unobserved months are not zero', int(len(table.numeric) - len(kept)), [])",
          ),
          dataset(),
        );
        const outcome = await runtime().finish(id, dataset());
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // §26 — it lands in the ordinary envelope, with the ordinary lineage.
        expect(outcome.result.scalars["december_total"]).toBeTypeOf("number");
        expect(outcome.result.method?.name).toBe("column_total");
        expect(outcome.result.preprocessing?.missingValuePolicy?.method).toBe("exclude");
        expect(outcome.result.sourceLineage.freshnessToken).toBe(dataset().freshnessToken);
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );

  it(
    "builds a result across SEVERAL steps, which is the whole point (§14)",
    async () => {
      const id = "s-multi";
      try {
        const one = await runtime().step(id, "kept = table.numeric.dropna()", dataset());
        expect("refused" in one ? "refused" : (one as { status: string }).status).toBe("ok");
        const two = await runtime().step(id, py("from sklearn.cluster import KMeans", "model = KMeans(n_clusters=2, n_init=10, random_state=0).fit(kept.to_numpy())"), dataset());
        expect("refused" in two ? "refused" : (two as { status: string }).status).toBe("ok");
        const three = await runtime().step(
          id,
          py(
            "labels = model.labels_",
            "names = [str(v) for v in table.entities.loc[kept.index].iloc[:, 0].tolist()]",
            "groups = []",
            "for lab in sorted(set(labels)):",
            "    members = [n for n, l in zip(names, labels) if l == lab]",
            "    groups.append({'label': 'group_' + str(int(lab) + 1), 'members': members, 'profile': {}})",
            "for g in groups:",
            "    result.emit('group', value=g)",
            "result.method('kmeans', {'n_clusters': 2}, 0)",
            "result.missing_policy('exclude', 'rows with unobserved months cannot be clustered', 1, [])",
          ),
          dataset(),
        );
        expect("refused" in three).toBe(false);
        if ("refused" in three) return;
        expect(three.status).toBe("ok");
        expect(three.hasResult).toBe(true);

        const outcome = await runtime().finish(id, dataset());
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.result.groups.length).toBe(2);
        expect(outcome.result.groups[0]!.members.length).toBeGreaterThan(0);
      } finally {
        await runtime().endSession(id);
      }
    },
    BOOT_MS,
  );
});
