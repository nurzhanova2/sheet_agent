// Stage 24.5.2 §2/§8 — bounded runtime trace ring buffer.
import { describe, expect, it } from "vitest";
import { commitTrace, getResultActionTraces, lastResultActionTrace, type MutableResultActionTrace } from "./result-action-trace.js";

function draft(text: string, over: Partial<MutableResultActionTrace> = {}): MutableResultActionTrace {
  return { text, ...over };
}

describe("result-action trace", () => {
  it("fills required fields with safe defaults and keeps the most recent", () => {
    commitTrace(draft("выдели его красным", { detectedResultAction: "highlight", outcome: "highlight_proposed", proposalCreated: true }));
    const last = lastResultActionTrace()!;
    expect(last.text).toBe("выдели его красным");
    expect(last.detectedResultAction).toBe("highlight");
    expect(last.proposalCreated).toBe(true);
    expect(last.detectedMutationIntent).toBe(false); // default
    expect(typeof last.at).toBe("string");
  });

  it("keeps at most 10 traces (ring buffer)", () => {
    for (let i = 0; i < 15; i += 1) commitTrace(draft(`t${i}`));
    const traces = getResultActionTraces();
    expect(traces.length).toBeLessThanOrEqual(10);
    expect(traces.at(-1)!.text).toBe("t14");
  });

  it("carries grounding + actionBuild + rejection reasons when present", () => {
    commitTrace(
      draft("выдели их", {
        grounding: { matchedCount: 3, unmatchedCount: 0, sheetRowsCount: 71, sheetRowsMin: 2, sheetRowsMax: 119 },
        actionBuild: { sourceWidth: 12, contiguousRuns: 29, chunkedRuns: 29, actionsBuilt: 29, rejectedActions: 0, rejectReasons: [] },
      }),
    );
    const last = lastResultActionTrace()!;
    expect(last.grounding?.sheetRowsCount).toBe(71);
    expect(last.actionBuild?.actionsBuilt).toBe(29);
    expect(last.actionBuild?.rejectReasons).toEqual([]);
  });
});
