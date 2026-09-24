import type { TurnRoute } from "../../app/conversation-route.js";

export type TurnOwner = "V2_OWNED" | "NON_V2";

/**
 * Machine-readable reason, recorded on the turn and asserted by the §43 routing
 * tests. Never shown to a user.
 */
export type OwnershipReason =
  | "flag_off"
  | "no_planner_transport"
  | "slash_command"
  | "undo"
  | "v1_clarification_pending"
  | "v2_clarification_reply"
  | "result_action"
  | "mutation_request"
  | "general_knowledge"
  | "v1_conversation_standing"
  | "not_analytical"
  | "no_table"
  | "analytical_request"
  | "analytical_followup";

export interface OwnershipContext {
  /** §9 — UNIFIED_ANALYTICAL_ENGINE_V2. */
  readonly flagEnabled: boolean;
  /** Without a planner transport the engine cannot run at all. */
  readonly canPlan: boolean;
  readonly isSlash: boolean;
  readonly isUndo: boolean;
  /** A Stage 24.x result action — "chart that", "highlight those" (§36 mutation). */
  readonly hasResultAction: boolean;
  /** `isMutationRequest` — a write the deterministic Preview flow owns (§36). */
  readonly isMutation: boolean;
  /**
   * A deterministic transform of an EXISTING stored result — "show only the top
   * 2", "sort that by date". Stage 24 owns the result it would transform.
   */
  readonly isResultTransform: boolean;
  /** Stage 24/25 has a standing structured result this conversation could continue. */
  readonly hasV1Result: boolean;
  /** A Stage 24/25 clarification is outstanding; its reply belongs to its own loop. */
  readonly v1ClarificationPending: boolean;
  /** A V2 clarification is outstanding; its reply resumes the V2 task (§30). */
  readonly v2ClarificationPending: boolean;
  /**
   * This message is a TURN OF ITS OWN, not an answer to the outstanding
   * question. Stage 24.6 makes the same call at `use-agent.ts`'s pending-
   * clarification interception; without it one unanswered question captures
   * every message after it, whatever the person actually typed.
   */
  readonly isTopicSwitch: boolean;
  /** This conversation already has a V2 analytical table (§5 follow-ups). */
  readonly hasV2Table: boolean;
  /** A concept/definition question — "что такое кредитный риск" (§7). */
  readonly isConceptQuestion: boolean;
  /** The sentence points at the workbook ("эта таблица", "here") (§7). */
  readonly hasWorkbookDeixis: boolean;
  /** Analytical by CAPABILITY, from the existing detectors — never by phrase list (§5). */
  readonly isAnalytical: boolean;
  /** A short continuation of an analytical conversation ("а теперь по кварталам"). */
  readonly isAnalyticalFollowUp: boolean;
  /** §14 — a table identity is available for this turn (live selection or V2 state). */
  readonly hasTable: boolean;
  /**
   * The live selection DOES resolve to a table, and it is one V2 does not
   * analyse — a flat records list. Different from "no table": the person is
   * looking at data, just not V2's kind, so V2's own remembered table must not
   * pull the turn back (§6/§39).
   */
  readonly selectionIsForeign: boolean;
  readonly route: TurnRoute;
}

export interface OwnershipDecision {
  readonly owner: TurnOwner;
  readonly reason: OwnershipReason;
  /**
   * A V2 clarification was outstanding and this turn is NOT its reply. The
   * caller must drop the suspension before running, or the engine will resume a
   * task the person has walked away from.
   */
  readonly dropSuspension?: boolean;
}

const nonV2 = (reason: OwnershipReason): OwnershipDecision => ({ owner: "NON_V2", reason });
const v2 = (reason: OwnershipReason): OwnershipDecision => ({ owner: "V2_OWNED", reason });

/**
 * §4 — the ONE routing decision. Ordered, and the order is the contract:
 *
 *  1. the flag and the transport, because without either there is no V2;
 *  2. the turn shapes another route OWNS outright (§6) — a slash command, an
 *     undo, a pending V1 question;
 *  3. a reply to V2's OWN question, before anything reads the reply as a
 *     request in its own right ("20%" is not a mutation, but it is not an
 *     analytical request either — it is an answer);
 *  4. mutations (§36 — V2 is read-only);
 *  5. general knowledge (§7);
 *  6. analytical capability, then a resolvable table (§14).
 */
export function classifyTurnOwner(ctx: OwnershipContext): OwnershipDecision {
  if (!ctx.flagEnabled) return nonV2("flag_off");
  if (!ctx.canPlan) return nonV2("no_planner_transport");
  if (ctx.isSlash) return nonV2("slash_command");
  if (ctx.isUndo) return nonV2("undo");

  // A V1 suspension outranks everything below it: its reply carries no
  // analytical wording of its own and must reach the loop that asked.
  if (ctx.v1ClarificationPending) return nonV2("v1_clarification_pending");

  // An outstanding V2 question does NOT outrank these. A mutation is a
  // mutation and a definition question is a definition question, whatever was
  // asked a moment ago — and each of them means the person has moved on, so
  // the suspension goes with them.
  const stale = ctx.v2ClarificationPending ? { dropSuspension: true } : {};
  if (ctx.hasResultAction) return { ...nonV2("result_action"), ...stale };
  if (ctx.isMutation) return { ...nonV2("mutation_request"), ...stale };

  // §4 — a follow-up belongs to WHOEVER PRODUCED the thing it follows up on.
  // "Show only the top 2" restricts a result that already exists; if that result
  // is Stage 24's and V2 has no table of its own, this turn continues a Stage 24
  // conversation, and taking it would be mixed ownership by another name. Once
  // V2 has its own table the same request is V2's, answered with set.top.
  if (ctx.isResultTransform && ctx.hasV1Result && !ctx.hasV2Table) return { ...nonV2("v1_conversation_standing"), ...stale };

  // §7 — a definition question stays a definition question with a workbook
  // open and a table already analysed. Only workbook deixis ("в этой таблице")
  // turns one into an analytical turn.
  if (ctx.isConceptQuestion && !ctx.hasWorkbookDeixis) return { ...nonV2("general_knowledge"), ...stale };
  if (ctx.route.route === "general_chat" && !ctx.hasWorkbookDeixis && !ctx.isAnalyticalFollowUp && !ctx.v2ClarificationPending) {
    return nonV2("general_knowledge");
  }

  // §30 — NOW the reply. Everything above is a turn in its own right; what is
  // left is either an answer to the question ("20%", "за первый квартал") or a
  // new analytical request, and `isTopicSwitch` is which.
  if (ctx.v2ClarificationPending && !ctx.isTopicSwitch) return v2("v2_clarification_reply");

  // §5 — capability, not phrases: an analytical request, or a continuation of an
  // analytical conversation V2 itself established.
  const followUp = ctx.hasV2Table && (ctx.isAnalyticalFollowUp || ctx.isAnalytical || ctx.route.route !== "general_chat");
  if (!ctx.isAnalytical && !followUp) return { ...nonV2("not_analytical"), ...stale };

  // §14 — nothing to analyse means nothing to own; the V1 cascade may still
  // have a deterministic answer (a workbook-structure question, say).
  if (!ctx.hasTable && (ctx.selectionIsForeign || !ctx.hasV2Table)) return { ...nonV2("no_table"), ...stale };

  return { ...v2(ctx.isAnalytical ? "analytical_request" : "analytical_followup"), ...stale };
}
