// @vitest-environment node
// ---------------------------------------------------------------------------
// Stage 26.3 §21 — writes the compatibility matrix to artifacts/.
//
// Gated on SHEET_AGENT_WRITE_MATRIX so an ordinary test run never writes files;
// the matrix's CONTENT is asserted by `interop.test.ts`, which runs always.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renderCompatibilityMatrix } from "./compatibility-matrix.gen.js";

const out = process.env["SHEET_AGENT_WRITE_MATRIX"];

describe("Stage 26.3 §21 — compatibility matrix", () => {
  it("renders every tool and argument", () => {
    const text = renderCompatibilityMatrix();
    expect(text).toContain("series.get");
    expect(text).toContain("metric / metricRef");
    expect(text).not.toContain("[object Object]");
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, text, "utf8");
    }
  });
});
