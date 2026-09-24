import type { ChatClient } from "../../app/chat-client.js";
import { runAnalyticalEngine, type EngineTurn } from "../engine.js";
import { EMPTY_ANALYTICAL_STATE, type AnalyticalConversationState } from "../state/conversation-state.js";
import type { AnalyticalTraceV2 } from "../debug/analytical-trace.js";
import type { SyntheticTable } from "../__fixtures__/synthetic-tables.js";
import { conversationPrimary, conversationSecondary, type Conversation, type ConversationTurn } from "./conversation-suite.js";

export interface ConversationTurnReport {
  readonly conversationId: string;
  readonly category: string;
  readonly index: number;
  readonly text: string;
  readonly concepts: readonly string[];
  readonly environment: string;
  readonly outcome: "answered" | "clarify" | "failed";
  readonly toolSequence: readonly string[];
  readonly plannerRounds: number;
  readonly toolCalls: number;
  readonly elapsedMs: number;
  readonly promptChars: number;
  readonly usedFallback: boolean;
  readonly primaryType: string | null;
  readonly primaryMetrics: readonly string[];
  readonly primaryPeriods: readonly string[];
  // §37
  readonly referenceAvailable: boolean;
  readonly referenceRequired: boolean;
  readonly referenceUsed: boolean;
  readonly referenceCorrect: boolean | null;
  readonly referenceToolLookup: number;
  readonly referenceDirectUse: number;
  readonly referenceClarification: boolean;
  readonly referenceStaleRejected: number;
  readonly referenceIncompatibleRejected: number;
  readonly mismatches: readonly string[];
  readonly failureClass: string | null;
  readonly failureReason: string | null;
  readonly question: string | null;
  readonly trace: AnalyticalTraceV2;
}

const REFERENCE_TOOLS = /^reference\./;
const REF_ARG = /^(inputRef|metricRef|periodRef|ofRef|startPeriodRef|endPeriodRef|leftRef|rightRef)$/;

/** §65 — one class per failure, serialization and semantics kept apart. */
function classify(turn: EngineTurn, mismatches: readonly string[], expected: ConversationTurn): string | null {
  if (turn.kind === "failed") {
    const reason = turn.detail ?? "";
    if (turn.reason === "invalid_decision") {
      return /decisions in one response|not valid JSON|cut off|no JSON object/.test(reason) ? "SERIALIZATION" : "PROTOCOL";
    }
    if (turn.reason === "planner_rounds" || turn.reason === "tool_calls" || turn.reason === "workbook_reads") return "BUDGET";
    if (turn.reason === "repeated_invalid_call") return "TOOL_ARGUMENT";
    return "OTHER";
  }
  if (turn.kind === "clarify") return expected.expect?.clarifies ? null : "CLARIFICATION_RESUME";
  if (expected.expect?.clarifies) return "REFERENCE_WRONG";
  if (mismatches.length === 0) return null;
  if (mismatches.some((m) => m.startsWith("reference:"))) {
    if (mismatches.some((m) => m.includes("foreign"))) return "REFERENCE_INCOMPATIBLE";
    if (mismatches.some((m) => m.includes("stale"))) return "REFERENCE_STALE";
    return "REFERENCE_WRONG";
  }
  if (mismatches.some((m) => m.startsWith("primaryType"))) return "SEMANTIC_PRIMARY";
  return "SEMANTIC_ANALYTICAL";
}

interface PreviousFacts {
  readonly metric: string | null;
  readonly metricSet: readonly string[];
  readonly periods: readonly string[];
}

/** §38 — did the turn reach the right earlier fact? Answer-shaped, never route-shaped. */
function judge(turn: EngineTurn, spec: ConversationTurn, previous: PreviousFacts): readonly string[] {
  const e = spec.expect;
  if (!e) return [];
  if (e.clarifies) return turn.kind === "clarify" ? [] : ["reference: expected a clarification, got an answer"];
  if (turn.kind !== "answered") return [`outcome: expected an answer, got ${turn.kind}`];
  const out: string[] = [];
  const { primary, supporting } = turn.analysis;

  if (e.primaryType && primary.type !== e.primaryType) out.push(`primaryType: expected ${e.primaryType}, got ${primary.type}`);
  if (e.winnerMetric && !(primary.metricKeys.length === 1 && primary.metricKeys[0] === e.winnerMetric)) {
    out.push(`winner: expected "${e.winnerMetric}", got [${primary.metricKeys.join(", ")}]`);
  }
  if (e.metricUniverse) {
    const got = [...primary.metricKeys].sort();
    const want = [...e.metricUniverse].sort();
    if (got.length !== want.length || got.some((k, i) => k !== want[i])) out.push(`universe: expected [${want.join(", ")}], got [${got.join(", ")}]`);
  }
  if (e.notMetric && primary.metricKeys.includes(e.notMetric)) {
    out.push(`reference: foreign — answered about "${e.notMetric}" from a different table`);
  }
  if (e.sameMetricAsPrevious) {
    if (!previous.metric) out.push("reference: no metric was established to continue from");
    else if (!(primary.metricKeys.length === 1 && primary.metricKeys[0] === previous.metric)) {
      out.push(`reference: expected the metric already in focus "${previous.metric}", got [${primary.metricKeys.join(", ")}]`);
    }
  }
  if (e.universeWithinPrevious && previous.metricSet.length > 0) {
    const outside = primary.metricKeys.filter((k) => !previous.metricSet.includes(k));
    if (outside.length > 0) out.push(`reference: widened outside the established set — [${outside.join(", ")}]`);
  }
  if (e.universeNarrowerThanPrevious && previous.metricSet.length > 0) {
    if (primary.metricKeys.length >= previous.metricSet.length) {
      out.push(`reference: expected fewer than ${previous.metricSet.length} metrics, got ${primary.metricKeys.length}`);
    }
  }
  if (e.samePeriodAsPrevious && previous.periods.length > 0) {
    if (!previous.periods.some((p) => primary.periodCanonicals.includes(p))) {
      out.push(`reference: expected the period already in focus [${previous.periods.join(", ")}], got [${primary.periodCanonicals.join(", ")}]`);
    }
  }
  if (e.minSupporting !== undefined && supporting.length < e.minSupporting) {
    out.push(`supporting: expected at least ${e.minSupporting}, got ${supporting.length}`);
  }
  return out;
}

export interface ConversationRunParams {
  readonly chatClient: ChatClient;
  readonly conversation: Conversation;
  readonly model: string;
  /** §41 — the table the conversation starts on. */
  readonly primaryTable?: SyntheticTable;
}

export async function runConversation(params: ConversationRunParams): Promise<readonly ConversationTurnReport[]> {
  const base = params.primaryTable ?? conversationPrimary();
  const changed = conversationPrimary("v2");
  const other = conversationSecondary();
  const { chatClient } = params;
  if (typeof chatClient.planAnalyticalTurn !== "function") throw new Error("this ChatClient cannot plan analytical turns");
  const plan = chatClient.planAnalyticalTurn.bind(chatClient);
  const narrate = typeof chatClient.narrate === "function" ? chatClient.narrate.bind(chatClient) : null;
  let state: AnalyticalConversationState = EMPTY_ANALYTICAL_STATE;
  const reports: ConversationTurnReport[] = [];

  for (const [index, spec] of params.conversation.turns.entries()) {
    const env = spec.environment ?? "same_table";
    // §45/§46/§47 — the workbook under the conversation. Selection drift keeps
    // the same table and version; the other two deliberately do not.
    const table = env === "other_table" ? other : env === "data_changed" ? changed : base;

    const before: PreviousFacts = {
      metric: state.lastMetric?.metricKey ?? null,
      metricSet: state.lastMetricSet?.metricKeys ?? [],
      periods: state.lastPeriod ? [state.lastPeriod.startCanonical, ...(state.lastPeriod.endCanonical ? [state.lastPeriod.endCanonical] : [])] : [],
    };
    const referenceAvailable = Boolean(state.lastResult ?? state.lastMetric ?? state.lastMetricSet ?? state.lastEvent);

    let promptChars = 0;
    const started = Date.now();
    const turn = await runAnalyticalEngine({
      turnId: `${params.conversation.id}-${index + 1}`,
      request: spec.text,
      schema: table.schema,
      grids: table.grids,
      language: spec.language ?? "ru",
      state,
      decide: async (messages) => {
        promptChars = Math.max(promptChars, messages.reduce((n, m) => n + m.content.length, 0));
        const controller = new AbortController();
        return plan(messages.map((m) => ({ role: m.role, content: m.content })), controller.signal, params.model);
      },
      // §35/§44 — one conversation deliberately breaks the narrator, to prove
      // that analytical memory does not live in what the user was shown.
      narrate: async (messages) => {
        if (spec.concepts.includes("narrator-fails")) throw new Error("narrator unavailable");
        if (!narrate) return "";
        const controller = new AbortController();
        return narrate(messages.map((m) => ({ role: m.role, content: m.content })), controller.signal, params.model);
      },
    });
    const elapsedMs = Date.now() - started;

    const trace = turn.trace;
    const toolSequence = trace.rounds.filter((r) => r.decision?.kind === "tool_call").map((r) => (r.decision as { tool: string }).tool);
    const referenceToolLookup = toolSequence.filter((t) => REFERENCE_TOOLS.test(t)).length;
    const referenceDirectUse = trace.rounds.filter((r) => {
      const d = r.decision;
      if (!d || d.kind !== "tool_call" || REFERENCE_TOOLS.test(d.tool)) return false;
      // a structured reference passed straight into a tool, without a lookup
      return Object.keys(d.arguments).some((k) => REF_ARG.test(k));
    }).length;
    const referenceStaleRejected = trace.rounds.filter((r) => r.toolError?.code === "STALE_REFERENCE").length;
    const referenceIncompatibleRejected = trace.rounds.filter((r) => r.toolError?.code === "INCOMPATIBLE_REFERENCE").length;

    const mismatches = judge(turn, spec, before);
    const required = Boolean(spec.needsReference);
    const answered = turn.kind === "answered";

    reports.push({
      conversationId: params.conversation.id,
      category: params.conversation.category,
      index: index + 1,
      text: spec.text,
      concepts: spec.concepts,
      environment: env,
      outcome: turn.kind,
      toolSequence,
      plannerRounds: trace.budget?.plannerRounds ?? 0,
      toolCalls: trace.budget?.toolCalls ?? 0,
      elapsedMs,
      promptChars,
      usedFallback: turn.kind === "answered" ? turn.usedFallback : false,
      primaryType: answered ? turn.analysis.primary.type : null,
      primaryMetrics: answered ? turn.analysis.primary.metricKeys : [],
      primaryPeriods: answered ? turn.analysis.primary.periodCanonicals : [],
      referenceAvailable,
      referenceRequired: required,
      referenceUsed: referenceToolLookup + referenceDirectUse > 0,
      // §38 — only a turn that NEEDED prior state is evidence about references.
      referenceCorrect: required ? mismatches.every((m) => !m.startsWith("reference:")) && (turn.kind !== "failed") : null,
      referenceToolLookup,
      referenceDirectUse,
      referenceClarification: turn.kind === "clarify",
      referenceStaleRejected,
      referenceIncompatibleRejected,
      mismatches,
      failureClass: classify(turn, mismatches, spec),
      failureReason: trace.failureReason ?? null,
      question: turn.kind === "clarify" ? turn.question : null,
      trace,
    });

    // the conversation carries its state forward exactly as production would
    if (turn.kind === "answered" || turn.kind === "clarify") state = turn.state;
  }

  return reports;
}
