import { describe, expect, it } from "vitest";
import { AGENT_BOUNDS } from "./bounds.js";

describe("AGENT_BOUNDS", () => {
  it("pins the documented Stage 24.4 loop limits", () => {
    expect(AGENT_BOUNDS).toEqual({
      maxAgentSteps: 8,
      maxWorkbookReads: 6,
      maxRowsPerObservation: 100,
      maxColumnsPerObservation: 30,
      maxObservationCells: 3000,
      maxIdenticalRetries: 1,
    });
  });

  it("keeps the per-observation cell cap consistent with the row/column caps", () => {
    expect(AGENT_BOUNDS.maxRowsPerObservation * 1).toBeLessThanOrEqual(AGENT_BOUNDS.maxObservationCells);
    expect(AGENT_BOUNDS.maxObservationCells).toBeLessThanOrEqual(
      AGENT_BOUNDS.maxRowsPerObservation * AGENT_BOUNDS.maxColumnsPerObservation,
    );
  });
});
