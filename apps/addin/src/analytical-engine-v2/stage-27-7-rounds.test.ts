import { describe, expect, it } from "vitest";
import { runAnalyticalEngine, type EngineTurn } from "./engine.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";

type Script = (messages: readonly PlannerMessage[]) => string;

function lastUser(messages: readonly PlannerMessage[]): string {
  return messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
}

function idOf(prompt: string, tool: string): string | null {
  const header = "=== RESULTS SO FAR ===\n";
  const start = prompt.indexOf(header);
  if (start < 0) return null;
  const block = prompt
    .slice(start + header.length)
    .split("\n\n")
    .find((b) => /^result_\d+ = /.test(b.trim()) && b.includes(`= ${tool} → `));
  return /^(result_\d+) = /.exec(block?.trim() ?? "")?.[1] ?? null;
}

const call = (tool: string, args: Record<string, unknown> = {}, final = false): string =>
  JSON.stringify({ kind: "tool_call", tool, arguments: args, ...(final ? { final: true } : {}) });

async function measure(request: string, script: Script): Promise<EngineTurn> {
  const table = fixtureOperations();
  return runAnalyticalEngine({
    turnId: "turn_rounds",
    request,
    schema: table.schema,
    grids: table.grids,
    language: "ru",
    state: EMPTY_ANALYTICAL_STATE,
    decide: (messages) => script(messages),
    narrate: async () => "Показатели изменились.",
  });
}

const REQUEST = "Как изменились показатели относительно предыдущего периода?";

const discoveryRoute: Script = (m) => {
  const p = lastUser(m);
  const latest = idOf(p, "period.latest");
  if (!latest) return call("period.latest");
  const previous = idOf(p, "period.previous");
  if (!previous) return call("period.previous", { ofRef: latest });
  const compared = idOf(p, "change.compare_periods");
  if (!compared) return call("change.compare_periods", { periodIntent: { kind: "latest_vs_previous" } });
  return JSON.stringify({ kind: "complete", primaryResultRef: compared, supportingResultRefs: [] });
};

const directRoute: Script = () => call("change.compare_periods", { periodIntent: { kind: "latest_vs_previous" } }, true);

describe("Stage 27.7 §3/§4 — the same answer, measured in model round trips", () => {
  it("took four planner rounds and a narration before this stage", async () => {
    const turn = await measure(REQUEST, discoveryRoute);
    expect(turn.kind).toBe("answered");
    expect(turn.timings.plannerRounds).toBe(4);
    expect(turn.timings.llmCallCount).toBe(4);
    expect(turn.timings.toolCallCount).toBe(3);
  });

  it("takes one planner round and no narration now", async () => {
    const turn = await measure(REQUEST, directRoute);
    expect(turn.kind).toBe("answered");
    expect(turn.timings.plannerRounds).toBe(1);
    expect(turn.timings.llmCallCount).toBe(1);
    expect(turn.timings.toolCallCount).toBe(1);
    expect(turn.timings.narrationMs).toBe(0);
  });

  it("reaches the same numbers by both routes", async () => {
    const slow = await measure(REQUEST, discoveryRoute);
    const fast = await measure(REQUEST, directRoute);
    expect(slow.kind).toBe("answered");
    expect(fast.kind).toBe("answered");
    if (slow.kind !== "answered" || fast.kind !== "answered") return;
    expect(fast.analysis.primary.rows).toEqual(slow.analysis.primary.rows);
    expect(fast.analysis.primary.periodCanonicals).toEqual(slow.analysis.primary.periodCanonicals);
  });
});
