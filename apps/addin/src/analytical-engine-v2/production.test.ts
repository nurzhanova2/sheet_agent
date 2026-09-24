import { describe, expect, it } from "vitest";
import { classifyTurnOwner, type OwnershipContext } from "./production/turn-owner.js";
import {
  containsInternalLeak,
  failureMessage,
  progressLabel,
  referenceMessage,
  type ProgressPhase,
  type ReferenceProblem,
} from "./production/answer-ux.js";
import { beginTurn, enginesThisTurn, finishTurn, lastTurn, recordAnalyticalExecution, resetTurnLedger } from "./production/turn-ledger.js";
import { alreadyAnswered, clarificationSignature, repeatedClarificationFeedback, type AnsweredClarification } from "./state/clarification-loop.js";
import { buildEngineContext, buildToolCatalog, toolCatalogModel } from "./context/build-context.js";
import { capabilityFactsOf } from "./capability/capability-availability.js";
import { selectCapabilities } from "./capability/capability-selection.js";
import { buildToolContext } from "./capability/tool-context.js";
import { buildPlannerMessages } from "./planner/planner-prompt.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { V2_TOOLS } from "./tools/registry.js";
import { ENGINE_BOUNDS, type EngineTerminationReason } from "./types.js";
import { runAnalyticalEngine } from "./engine.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";
import type { AnalyticalConversationState } from "./state/conversation-state.js";

// --- §4/§5/§6/§7: the ownership table ---------------------------------------

const BASE: OwnershipContext = {
  flagEnabled: true,
  canPlan: true,
  isSlash: false,
  isUndo: false,
  hasResultAction: false,
  isMutation: false,
  isResultTransform: false,
  hasV1Result: false,
  v1ClarificationPending: false,
  v2ClarificationPending: false,
  isTopicSwitch: false,
  selectionIsForeign: false,
  hasV2Table: false,
  isConceptQuestion: false,
  hasWorkbookDeixis: false,
  isAnalytical: true,
  isAnalyticalFollowUp: false,
  hasTable: true,
  route: { route: "workbook_analysis", needsSelection: true, needsWorkbookMap: false, reasons: [] },
};

const owner = (over: Partial<OwnershipContext>) => classifyTurnOwner({ ...BASE, ...over });

describe("Stage 26.8 §4 — one ownership decision, in a fixed order", () => {
  it("an ordinary analytical question over a recognised table is V2's", () => {
    expect(owner({})).toEqual({ owner: "V2_OWNED", reason: "analytical_request" });
  });

  it.each<[string, Partial<OwnershipContext>, string]>([
    ["the flag is off", { flagEnabled: false }, "flag_off"],
    ["there is no planner transport", { canPlan: false }, "no_planner_transport"],
    ["it is a slash command", { isSlash: true }, "slash_command"],
    ["it is an undo", { isUndo: true }, "undo"],
    ["a Stage 24/25 question is outstanding", { v1ClarificationPending: true }, "v1_clarification_pending"],
    ["it is a result action", { hasResultAction: true }, "result_action"],
    ["it is a mutation", { isMutation: true }, "mutation_request"],
    ["it transforms a Stage 24 result", { isResultTransform: true, hasV1Result: true }, "v1_conversation_standing"],
    ["it is a definition question", { isConceptQuestion: true, isAnalytical: false, route: { ...BASE.route, route: "general_chat" } }, "general_knowledge"],
    ["it is not analytical at all", { isAnalytical: false, route: { ...BASE.route, route: "workbook_qa" } }, "not_analytical"],
    ["no table can be resolved", { hasTable: false }, "no_table"],
  ])("%s → NON_V2", (_why, over, reason) => {
    expect(owner(over)).toEqual({ owner: "NON_V2", reason });
  });

  it("§30 — a reply to V2's own question is V2's, whatever it looks like", () => {
    // "20%" is not analytical, is not a mutation, and names no table. It is an
    // ANSWER, and only the suspension knows that.
    expect(owner({ v2ClarificationPending: true, isAnalytical: false, hasTable: false, route: { ...BASE.route, route: "general_chat" } })).toEqual({
      owner: "V2_OWNED",
      reason: "v2_clarification_reply",
    });
  });

  // The first production-path run found this the hard way: with the resume
  // check above them, one outstanding question captured a mutation and a
  // definition question and answered both from the workbook.
  it.each<[string, Partial<OwnershipContext>, string]>([
    ["a mutation", { isMutation: true }, "mutation_request"],
    ["a result action", { hasResultAction: true }, "result_action"],
    ["a definition question", { isConceptQuestion: true, isAnalytical: false }, "general_knowledge"],
    ["a new analytical request", { isTopicSwitch: true }, "analytical_request"],
  ])("§30 — %s is NOT an answer to an outstanding question", (_why, over, reason) => {
    const d = owner({ v2ClarificationPending: true, ...over });
    expect(d.reason).toBe(reason);
    // …and the abandoned question is dropped rather than left to catch the next one
    expect(d.dropSuspension).toBe(true);
  });

  it("§30 — a short reply still resumes, and nothing is dropped", () => {
    const d = owner({ v2ClarificationPending: true, isTopicSwitch: false, isAnalytical: false, route: { ...BASE.route, route: "general_chat" } });
    expect(d).toEqual({ owner: "V2_OWNED", reason: "v2_clarification_reply" });
  });

  it("§6/§39 — a flat records list under the cursor is Stage 24's, even mid-conversation", () => {
    expect(owner({ hasTable: false, selectionIsForeign: true, hasV2Table: true })).toMatchObject({ owner: "NON_V2", reason: "no_table" });
  });

  it("§7 — a definition question stays general even with a V2 table standing", () => {
    expect(owner({ isConceptQuestion: true, hasV2Table: true, isAnalytical: false, route: { ...BASE.route, route: "general_chat" } }).owner).toBe("NON_V2");
  });

  it("§7 — until it points at the workbook", () => {
    expect(owner({ isConceptQuestion: true, hasWorkbookDeixis: true, hasV2Table: true }).owner).toBe("V2_OWNED");
  });

  it("§5 — a bare follow-up is V2's once V2 has a table, and nobody's before", () => {
    const followUp = { isAnalytical: false, isAnalyticalFollowUp: true, route: { ...BASE.route, route: "workbook_analysis" as const } };
    expect(owner({ ...followUp, hasV2Table: false }).owner).toBe("NON_V2");
    expect(owner({ ...followUp, hasV2Table: true })).toEqual({ owner: "V2_OWNED", reason: "analytical_followup" });
  });

  it("§4 — the same transform IS V2's once V2 owns the result", () => {
    expect(owner({ isResultTransform: true, hasV1Result: true, hasV2Table: true }).owner).toBe("V2_OWNED");
  });
});

// --- §44: the ledger ---------------------------------------------------------

describe("Stage 26.8 §44 — the ledger answers 'who analysed this turn?'", () => {
  it("records the owner, the engines and the outcome", () => {
    resetTurnLedger();
    beginTurn("t1", "какой показатель вырос?", "V2_OWNED", "analytical_request");
    recordAnalyticalExecution("analytical_engine_v2");
    finishTurn("answered", "turn_9");
    expect(enginesThisTurn()).toEqual(["analytical_engine_v2"]);
    expect(lastTurn()).toMatchObject({ owner: "V2_OWNED", engines: ["analytical_engine_v2"], outcome: "answered", v2TurnId: "turn_9" });
  });

  it("a second distinct engine on one turn is visible, not silent", () => {
    resetTurnLedger();
    beginTurn("t2", "x", "V2_OWNED", "analytical_request");
    recordAnalyticalExecution("analytical_engine_v2");
    recordAnalyticalExecution("stage25_planner");
    expect(enginesThisTurn()).toHaveLength(2);
  });
});

// --- §24/§25: the compact catalogue ------------------------------------------

describe("Stage 26.8 §25 — the compact catalogue hides nothing", () => {
  const table = fixtureOperations();
  const catalog = buildEngineContext(table.schema, table.grids, buildPeriodIndex(table.schema, table.grids), EMPTY_ANALYTICAL_STATE).toolCatalog;
  const model = toolCatalogModel();
  const facts = capabilityFactsOf({ schema: table.schema, periodIndex: buildPeriodIndex(table.schema, table.grids), state: EMPTY_ANALYTICAL_STATE });
  const contextModel = buildToolContext({ facts, selection: selectCapabilities({ facts }) });

  it("contains every exposed tool, its return type, and no [object Object]", () => {
    expect(catalog).not.toContain("[object Object]");
    expect(model.entries).toHaveLength(V2_TOOLS.length);
    const exposed = new Set(contextModel.exposedTools);
    const loaded = new Set(contextModel.loadedTools);
    for (const tool of V2_TOOLS) {
      const entry = model.entries.find((e) => e.name === tool.name);
      expect(entry, tool.name).toBeDefined();
      expect(entry!.returns).toBe(tool.returns);
      if (!exposed.has(tool.name)) continue;
      expect(catalog, tool.name).toContain(`${entry!.signature} → ${tool.returns}`);
      if (loaded.has(tool.name)) expect(catalog, `${tool.name} description`).toContain(tool.description);
    }
  });

  it("names every argument with its type, and marks the required ones", () => {
    for (const tool of V2_TOOLS) {
      const entry = model.entries.find((e) => e.name === tool.name)!;
      for (const [arg, spec] of Object.entries(tool.args)) {
        expect(entry.signature, `${tool.name}.${arg}`).toContain(`${arg}${spec.required ? "!" : ""}:${spec.type}`);
        // required-ness is never dropped in the compaction
        if (spec.required) expect(entry.signature).toContain(`${arg}!:`);
      }
    }
  });

  it("states every loaded argument contract exactly once — shared ones in the shared block", () => {
    const loaded = new Set(contextModel.loadedTools);
    for (const tool of V2_TOOLS) {
      if (!loaded.has(tool.name)) continue;
      for (const [, spec] of Object.entries(tool.args)) {
        expect(catalog, spec.describe.slice(0, 40)).toContain(spec.describe);
      }
    }
    expect(model.shared.length).toBeGreaterThan(10);
    for (const s of model.shared) expect(s.uses).toBeGreaterThan(1);
  });

  it("§31 — the tiered catalogue is materially smaller than the full registry serialization", () => {
    expect(catalog.length).toBeLessThan(buildToolCatalog().length * 0.8);
  });

  it("§23 — every ref alternative is still advertised", () => {
    for (const tool of V2_TOOLS) {
      const entry = model.entries.find((e) => e.name === tool.name)!;
      for (const arg of Object.keys(tool.args)) {
        const ref = tool.args[`${arg}Ref`];
        if (ref) expect(entry.signature, `${tool.name}.${arg}Ref`).toContain(`${arg}Ref`);
      }
    }
  });
});

describe("Stage 26.8 §22/§26 — the prompt budget", () => {
  const table = fixtureOperations();
  const ctx = buildEngineContext(table.schema, table.grids, buildPeriodIndex(table.schema, table.grids), EMPTY_ANALYTICAL_STATE);
  const messages = buildPlannerMessages({ request: "что изменилось сильнее всего?", context: ctx, results: [], errors: [], round: 1, remainingRounds: 9 });
  const total = messages.reduce((n, m) => n + m.content.length, 0);

  it("stays under the Stage 26.7 measured median it was optimised against", () => {
    // 26.7 measured 33,978 chars median in the live suite, on a table larger than
    // this fixture. The guard is against REGROWTH, not a claim about that number:
    // a new tool whose contracts are restated per-tool would push this back up.
    expect(total).toBeLessThan(30_000);
  });

  it("the conversation state block stays small — it was never the problem", () => {
    expect(ctx.stateBlock.length).toBeLessThan(2_000);
  });

  it("the catalogue is still the dominant term, and is reported as such", () => {
    expect(ctx.toolCatalog.length / total).toBeGreaterThan(0.5);
  });
});

// --- §27/§28/§29/§30: clarification that makes progress ----------------------

describe("Stage 26.8 §28 — two questions differing only by metric are one question", () => {
  const terms = ["Доля брака", "Очередь заявок", "Выработка"];

  it("the same parameter asked about different metrics signs the same", () => {
    const a = clarificationSignature("Какой порог считать допустимым для «Доля брака»?", terms);
    const b = clarificationSignature("Какой порог считать допустимым для «Очередь заявок»?", terms);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("a genuinely different question signs differently", () => {
    const threshold = clarificationSignature("Какой порог считать допустимым?", terms);
    const period = clarificationSignature("За какой период выполнить сравнение?", terms);
    expect(threshold).not.toBe(period);
  });

  it("§27 — nothing here knows what a threshold is", () => {
    // the identical mechanism, in English, about something else entirely
    const a = clarificationSignature("Which currency should I use for Доля брака?", terms);
    const b = clarificationSignature("Which currency should I use for Очередь заявок?", terms);
    expect(a).toBe(b);
  });

  it("recognises a question already answered, and hands back the answer, not a value", () => {
    const answered: readonly AnsweredClarification[] = [
      { signature: clarificationSignature("Какой порог считать допустимым?", terms), question: "Какой порог считать допустимым?", reply: "20%" },
    ];
    const again = clarificationSignature("Какой порог считать допустимым для «Выработка»?", terms);
    const prior = alreadyAnswered(again, answered);
    expect(prior).not.toBeNull();
    const feedback = repeatedClarificationFeedback(prior!, "ru");
    // §30 — it repeats what the user said; it does not decide what it means.
    expect(feedback).toContain("20%");
    expect(feedback).not.toMatch(/threshold\s*=|порог\s*=/);
  });

  it("an empty signature never matches anything", () => {
    expect(alreadyAnswered("", [{ signature: "", question: "q", reply: "r" }])).toBeNull();
  });

  it("§29 — the loop is bounded", () => {
    expect(ENGINE_BOUNDS.maxRepeatedClarifications).toBeGreaterThanOrEqual(1);
    expect(ENGINE_BOUNDS.maxRepeatedClarifications).toBeLessThanOrEqual(2);
  });
});

// --- §18/§20/§32: the user-facing surface ------------------------------------

describe("Stage 26.8 §32 — errors become categories, never enum names", () => {
  const reasons: readonly EngineTerminationReason[] = ["planner_rounds", "tool_calls", "workbook_reads", "repeated_invalid_call", "invalid_decision", "model_error"];

  it.each(reasons)("%s reads as something a person can act on", (reason) => {
    for (const language of ["ru", "en"] as const) {
      const message = failureMessage(reason, language);
      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toContain(reason);
      expect(containsInternalLeak(message)).toBe(false);
    }
  });

  it.each<ReferenceProblem>(["stale", "missing", "incompatible", "protocol"])("the %s reference message names no code", (problem) => {
    for (const language of ["ru", "en"] as const) {
      const message = referenceMessage(problem, language);
      expect(message).not.toMatch(/STALE_REFERENCE|NO_PREVIOUS_RESULT|INCOMPATIBLE_REFERENCE|MULTIPLE_DECISIONS/);
      expect(message.length).toBeGreaterThan(20);
    }
  });
});

describe("Stage 26.8 §18 — the leak gate", () => {
  it("catches result ids, decision keys, error codes and tool names", () => {
    for (const bad of [
      "Победил result_2.",
      'Отдаю {"kind":"complete"}',
      "primaryResultRef=result_3",
      "STALE_REFERENCE",
      "посчитано через set.argmax",
      "MULTIPLE_DECISIONS in round 2",
    ]) {
      expect(containsInternalLeak(bad), bad).toBe(true);
    }
  });

  it("passes an ordinary answer through untouched", () => {
    for (const good of [
      "Сильнее всего изменилась «Доля брака»: −18,4% за последний месяц.",
      "Revenue grew 12.5% between January and February, the largest move of the five metrics.",
      "Выработка бригады выросла с 140 до 167.",
    ]) {
      expect(containsInternalLeak(good), good).toBe(false);
    }
  });
});

describe("Stage 26.8 §20 — progress says the phase and nothing else", () => {
  it.each<ProgressPhase>(["reading", "analysing", "composing"])("%s names no tool and no percentage", (phase) => {
    for (const language of ["ru", "en"] as const) {
      const label = progressLabel(phase, language);
      expect(label).not.toMatch(/%|\b(set|metric|period|change|series|aggregate|reference)\./);
      expect(label.length).toBeGreaterThan(5);
    }
  });
});

// --- §29/§30: the loop, through the real engine ------------------------------

describe("Stage 26.8 §29/§30 — a question already answered does not come back", () => {
  const table = fixtureOperations();

  /** A planner that always asks for the same parameter, one metric at a time. */
  function stubbornAsker(): (messages: readonly PlannerMessage[]) => string {
    let n = 0;
    const metrics = table.schema.rowAxis.map((m) => m.display);
    return () => {
      const metric = metrics[n % metrics.length] ?? "показатель";
      n += 1;
      return JSON.stringify({ kind: "clarify", question: `Какой порог считать допустимым для «${metric}»?`, options: [] });
    };
  }

  const run = (request: string, state: AnalyticalConversationState, decide: (m: readonly PlannerMessage[]) => string) =>
    runAnalyticalEngine({
      turnId: "t",
      request,
      schema: table.schema,
      grids: table.grids,
      language: "ru",
      state,
      decide,
      narrate: async () => "",
    });

  it("asks once, then stops asking and says so", async () => {
    const ask = stubbornAsker();
    const first = await run("Отметь показатели, вышедшие за порог.", EMPTY_ANALYTICAL_STATE, ask);
    expect(first.kind).toBe("clarify");
    if (first.kind !== "clarify") return;
    expect(first.exhausted).toBeUndefined();
    expect(first.state.suspended).toBeDefined();

    // the user answers; the planner asks the SAME thing about another metric
    const second = await run("20%", first.state, ask);
    expect(second.kind).toBe("clarify");
    if (second.kind !== "clarify") return;
    // §29 — the loop stopped, and nothing was suspended to feed it again
    expect(second.exhausted).toBe(true);
    expect(second.state.suspended).toBeUndefined();
    // §30 — the message repeats what the user said rather than inventing a value
    expect(second.question).toContain("20%");
  });

  it("§30 — the planner is shown the answer it already has", async () => {
    const ask = stubbornAsker();
    const first = await run("Отметь показатели, вышедшие за порог.", EMPTY_ANALYTICAL_STATE, ask);
    if (first.kind !== "clarify") throw new Error("expected a clarification");
    const prompts: string[] = [];
    await run("20%", first.state, (messages) => {
      prompts.push(messages.map((m) => m.content).join("\n"));
      return ask(messages);
    });
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    // the first round already carries the reply, and the retry carries the
    // engine's protocol feedback about having asked it before
    expect(prompts[0]).toContain("20%");
    expect(prompts[prompts.length - 1]).toContain("Вы уже задавали этот вопрос");
  });

  it("a DIFFERENT question is still asked normally", async () => {
    const first = await run("Отметь показатели, вышедшие за порог.", EMPTY_ANALYTICAL_STATE, stubbornAsker());
    if (first.kind !== "clarify") throw new Error("expected a clarification");
    const second = await run("20%", first.state, () =>
      JSON.stringify({ kind: "clarify", question: "За какой период выполнить сравнение?", options: [] }),
    );
    expect(second.kind).toBe("clarify");
    if (second.kind !== "clarify") return;
    expect(second.exhausted).toBeUndefined();
    expect(second.question).toContain("период");
    expect(second.state.suspended).toBeDefined();
    // §30 — and the earlier answer travels with the new suspension
    expect(second.state.suspended!.answered?.some((a) => a.reply === "20%")).toBe(true);
  });
});
