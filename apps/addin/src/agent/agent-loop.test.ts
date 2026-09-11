import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, summariseAgentRun } from "./agent-loop.js";
import { AGENT_BOUNDS } from "./bounds.js";
import { createAgentToolRegistry } from "./tool-registry.js";
import type { AgentDecisionContext, AgentStep, AgentLoopState } from "./types.js";
import { financialStabilityDeps } from "./__fixtures__/financial-stability.js";

const registry = createAgentToolRegistry();
const deps = financialStabilityDeps();

function scripted(script: readonly unknown[]): (ctx: AgentDecisionContext) => unknown {
  let i = 0;
  return () => script[Math.min(i++, script.length - 1)];
}

const base = { taskId: "task", registry, deps, now: () => 0 } as const;

describe("runAgentLoop", () => {
  it("runs tool → observation → final and stops", async () => {
    const state = await runAgentLoop({
      ...base,
      request: "how many sheets are there?",
      decide: scripted([
        { kind: "tool_call", tool: "list_sheets", input: {} },
        { kind: "final", answer: "There are 4 sheets." },
      ]),
    });
    expect(state.status).toBe("done");
    expect(state.terminationReason).toBe("final_answer");
    expect(state.finalAnswer).toBe("There are 4 sheets.");
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0]!.ok).toBe(true);
    expect(state.modelCalls).toBe(2);
  });

  it("assigns a referenceable result id to a successful table observation", async () => {
    const state = await runAgentLoop({
      ...base,
      request: "mean NPL rate by sector for 2025",
      decide: scripted([
        { kind: "tool_call", tool: "group_by", input: { sheet: "Portfolio 2025", by: ["Sector"], metrics: [{ metric: "mean", column: "NPL Rate", name: "Mean NPL Rate" }] } },
        { kind: "final", answer: "Corporate is highest." },
      ]),
    });
    expect(state.referencedResultIds).toEqual(["task-r1"]);
    expect(state.observations[0]!.resultId).toBe("task-r1");
    expect(state.observations[0]!.rows?.some((r) => r[0] === "Corporate")).toBe(true);
  });

  it("stops at the step budget and preserves completed observations", async () => {
    let n = 0;
    const state = await runAgentLoop({
      ...base,
      request: "loop forever",
      // readCost-0 tool, distinct input each time → never 'repeated', never a read
      decide: () => ({ kind: "tool_call", tool: "describe_result", input: { result: `missing-${n++}` } }),
    });
    expect(state.status).toBe("terminated");
    expect(state.terminationReason).toBe("step_budget");
    expect(state.steps.length).toBe(AGENT_BOUNDS.maxAgentSteps);
    expect(state.observations.length).toBe(AGENT_BOUNDS.maxAgentSteps);
  });

  it("stops at the workbook-read budget", async () => {
    let n = 0;
    const state = await runAgentLoop({
      ...base,
      request: "read everything",
      decide: () => ({ kind: "tool_call", tool: "find_column", input: { name: `col-${n++}` } }),
    });
    expect(state.terminationReason).toBe("read_budget");
    expect(state.workbookReads).toBe(AGENT_BOUNDS.maxWorkbookReads);
    expect(state.observations.length).toBe(AGENT_BOUNDS.maxWorkbookReads);
  });

  it("stops on a repeated identical tool call after one retry", async () => {
    const state = await runAgentLoop({
      ...base,
      request: "spin",
      decide: scripted([{ kind: "tool_call", tool: "list_sheets", input: {} }]),
    });
    expect(state.terminationReason).toBe("repeated_tool_call");
    expect(state.observations).toHaveLength(2); // original + one retry executed, third refused
  });

  it("stops on repeated malformed decisions", async () => {
    const state = await runAgentLoop({ ...base, request: "garbage", decide: scripted([{ not: "a decision" }]) });
    expect(state.terminationReason).toBe("model_error");
    expect(state.modelCalls).toBe(2);
    expect(state.observations).toHaveLength(0);
  });

  it("treats a throwing decide as a malformed decision", async () => {
    const state = await runAgentLoop({
      ...base,
      request: "boom",
      decide: () => {
        throw new Error("provider down");
      },
    });
    expect(state.terminationReason).toBe("model_error");
  });

  it("surfaces a clarify decision as awaiting_clarification and persists the question", async () => {
    const state = await runAgentLoop({
      ...base,
      request: "what changed between 2024 and 2025?",
      decide: scripted([{ kind: "clarify", question: "Portfolio or Deposits?", candidates: ["Portfolio", "Deposits"] }]),
    });
    expect(state.status).toBe("awaiting_clarification");
    expect(state.terminationReason).toBe("clarification");
    expect(state.pendingClarification).toEqual({ question: "Portfolio or Deposits?", candidates: ["Portfolio", "Deposits"] });
  });

  it("invokes onStep for every step with a live state view", async () => {
    const seen: { status: AgentLoopState["status"]; step: number }[] = [];
    const onStep = vi.fn((step: AgentStep, state: AgentLoopState) => {
      seen.push({ status: state.status, step: step.iteration });
    });
    await runAgentLoop({
      ...base,
      request: "x",
      onStep,
      decide: scripted([
        { kind: "tool_call", tool: "list_sheets", input: {} },
        { kind: "final", answer: "done" },
      ]),
    });
    expect(onStep).toHaveBeenCalledTimes(2);
    expect(seen[0]).toEqual({ status: "running", step: 1 });
    expect(seen[1]).toEqual({ status: "done", step: 2 });
  });

  // ----- Increment 4.4 §10 — loop-termination hardening ------------------
  it("a tool that keeps failing on the SAME call terminates via repeated_tool_call", async () => {
    const state = await runAgentLoop({
      ...base,
      request: "spin on a failing call",
      decide: scripted([{ kind: "tool_call", tool: "inspect_table", input: { sheet: "Ghost" } }]),
    });
    expect(state.terminationReason).toBe("repeated_tool_call");
    expect(state.observations.every((o) => !o.ok)).toBe(true);
  });

  it("an alternating two-tool loop terminates at the step budget", async () => {
    let i = 0;
    const state = await runAgentLoop({
      ...base,
      request: "ping pong",
      decide: () =>
        i++ % 2 === 0
          ? { kind: "tool_call", tool: "describe_result", input: { result: `a-${i}` } }
          : { kind: "tool_call", tool: "describe_result", input: { result: `b-${i}` } },
    });
    expect(state.terminationReason).toBe("step_budget");
    expect(state.steps.length).toBe(AGENT_BOUNDS.maxAgentSteps);
  });

  it("a final decision on the 8th step is honoured (not pre-empted by the step budget)", async () => {
    let i = 0;
    const state = await runAgentLoop({
      ...base,
      request: "seven tools then final",
      decide: () =>
        ++i <= 7
          ? { kind: "tool_call", tool: "describe_result", input: { result: `x-${i}` } }
          : { kind: "final", answer: "done on step 8" },
    });
    expect(state.status).toBe("done");
    expect(state.finalAnswer).toBe("done on step 8");
    expect(state.steps.length).toBe(8);
  });

  it("model failure DURING a resumed clarification still terminates safely", async () => {
    const first = await runAgentLoop({
      ...base,
      request: "compare the two years",
      decide: scripted([{ kind: "clarify", question: "Portfolio or Deposits?", candidates: ["Portfolio", "Deposits"] }]),
    });
    const resumed = await runAgentLoop({
      ...base,
      request: "compare the two years",
      resume: { state: first, answer: "Portfolio" },
      decide: scripted(["garbage"]),
    });
    expect(resumed.status).toBe("terminated");
    expect(resumed.terminationReason).toBe("model_error");
  });

  it("resumes a clarified task: carries prior observations + budgets, injects the answer", async () => {
    const first = await runAgentLoop({
      ...base,
      request: "what changed between the two years?",
      decide: scripted([
        { kind: "tool_call", tool: "list_sheets", input: {} },
        { kind: "clarify", question: "Portfolio or Deposits?", candidates: ["Portfolio", "Deposits"] },
      ]),
    });
    expect(first.status).toBe("awaiting_clarification");
    expect(first.workbookReads).toBe(1);

    const resumed = await runAgentLoop({
      ...base,
      request: "what changed between the two years?",
      resume: { state: first, answer: "Portfolio" },
      decide: scripted([{ kind: "final", answer: "Portfolio NPL rose." }]),
    });
    expect(resumed.status).toBe("done");
    // prior list_sheets observation + the synthetic clarification answer are both present
    expect(resumed.observations.some((o) => o.tool === "list_sheets")).toBe(true);
    expect(resumed.observations.some((o) => o.tool === "user_clarification" && /Portfolio/.test(o.note ?? ""))).toBe(true);
    // the read budget did NOT reset on resume
    expect(resumed.workbookReads).toBe(1);
    expect(resumed.modelCalls).toBe(first.modelCalls + 1);
  });

  it("summariseAgentRun reports decisions/actions/results only — no chain-of-thought", async () => {
    const state = await runAgentLoop({
      ...base,
      request: "x",
      decide: scripted([
        { kind: "tool_call", tool: "list_sheets", input: {} },
        { kind: "final", answer: "done" },
      ]),
    });
    const trace = summariseAgentRun(state);
    expect(trace.terminationReason).toBe("final_answer");
    expect(trace.steps.map((s) => s.decision)).toEqual(["tool_call", "final"]);
    expect(trace.steps[0]!.tool).toBe("list_sheets");
    // only decision/action/result metadata — never model prose or a decision payload
    for (const step of trace.steps) {
      expect(Object.keys(step).sort()).toEqual(
        expect.arrayContaining(["decision", "durationMs", "iteration", "observationCells"]),
      );
      expect(step).not.toHaveProperty("answer");
      expect(step).not.toHaveProperty("question");
      expect(step).not.toHaveProperty("input");
    }
  });
});
