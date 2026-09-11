import { describe, expect, it } from "vitest";
import { parseAgentDecision } from "./decision-schema.js";

describe("parseAgentDecision", () => {
  it("accepts a well-formed tool_call (object and JSON string)", () => {
    const object = parseAgentDecision({ kind: "tool_call", tool: "group_by", input: { sheet: "Portfolio 2025" } });
    expect(object).toEqual({ ok: true, decision: { kind: "tool_call", tool: "group_by", input: { sheet: "Portfolio 2025" } } });

    const json = parseAgentDecision('{"kind":"tool_call","tool":"list_sheets"}');
    expect(json).toEqual({ ok: true, decision: { kind: "tool_call", tool: "list_sheets", input: {} } });
  });

  it("accepts clarify and final", () => {
    expect(parseAgentDecision({ kind: "clarify", question: "Portfolio or Deposits?", candidates: ["Portfolio", "Deposits"] })).toEqual({
      ok: true,
      decision: { kind: "clarify", question: "Portfolio or Deposits?", candidates: ["Portfolio", "Deposits"] },
    });
    expect(parseAgentDecision({ kind: "final", answer: "Corporate deteriorated most." })).toEqual({
      ok: true,
      decision: { kind: "final", answer: "Corporate deteriorated most." },
    });
  });

  it("fails closed on malformed shapes", () => {
    for (const bad of [
      null,
      42,
      [],
      "not json",
      { kind: "act" },
      { kind: "tool_call" },
      { kind: "tool_call", tool: "" },
      { kind: "tool_call", tool: "x", input: [] },
      { kind: "tool_call", tool: "x", input: {}, mutate: true },
      { kind: "clarify", candidates: ["a"] },
      { kind: "clarify", question: "q", candidates: [1, 2] },
      { kind: "final" },
      { kind: "final", answer: "  " },
      { kind: "final", answer: "ok", extra: 1 },
    ]) {
      const parsed = parseAgentDecision(bad);
      expect(parsed.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("trims and drops blank clarify candidates", () => {
    const parsed = parseAgentDecision({ kind: "clarify", question: " pick ", candidates: [" Portfolio ", "", "  "] });
    expect(parsed).toEqual({ ok: true, decision: { kind: "clarify", question: "pick", candidates: ["Portfolio"] } });
  });

  // §7 — production decision-contract robustness. No permissive JSON scraping.
  it("rejects plausible model deviations (fences, commentary, arrays, multiple objects)", () => {
    for (const bad of [
      '```json\n{"kind":"final","answer":"x"}\n```',
      'Here is my decision: {"kind":"final","answer":"x"}',
      '{"kind":"final","answer":"x"}  // done',
      '[{"kind":"final","answer":"x"}]',
      '{"kind":"final","answer":"x"}{"kind":"final","answer":"y"}',
      '{"kind":"tool_call","tool":"group_by","input":{},"mutate":true}',
      '{"kind":"tool_call","tool":"delete_sheet","input":{}}', // invented tool is still shape-valid — loop rejects it as unknown
      '{"kind":"tool_call","tool":"derive_metric","input":{},"__proto__":{}}',
      '{"kind":"final","answer":null}',
      '{"kind":"clarify","question":"q","candidates":"Portfolio"}',
    ]) {
      const parsed = parseAgentDecision(bad);
      // an invented but well-formed tool_call parses OK (the loop refuses it); everything else fails here
      if (bad.includes('"delete_sheet"')) {
        expect(parsed.ok).toBe(true);
      } else {
        expect(parsed.ok, bad).toBe(false);
      }
    }
  });
});
