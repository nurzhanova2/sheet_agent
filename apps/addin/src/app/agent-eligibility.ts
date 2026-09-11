// ---------------------------------------------------------------------------
// Stage 24.4 Increment 4.2 §5 — the explicit agent-eligibility decision.
//
// The bounded agent loop is a FALLBACK. It runs only after every deterministic
// route (slash commands, deterministic NL analysis, ResultRef / RowSetRef
// follow-ups, clarification continuations) has declined the turn. This module
// decides whether a still-unhandled analytical turn is broad / investigative
// enough to warrant discovery + multi-step reasoning.
//
// It reuses the router's own classification (`TurnRoute`) plus a small set of
// investigative markers — NOT a growing list of exact phrases. A plain
// single-sheet analytical request ("what is the average Revenue", "which
// category has the highest Fact") stays on the deterministic path.
//
// `\b`/`\w` are ASCII-only, so every Russian alternative uses explicit classes.
// ---------------------------------------------------------------------------

import type { TurnRoute } from "./conversation-route.js";

export interface AgentEligibility {
  readonly eligible: boolean;
  /** Machine-readable reason — transcript / tests only, never shown verbatim. */
  readonly reason: string;
}

// "what is this workbook about", "describe the whole workbook", "what's in this file"
const WORKBOOK_SCOPE_RE =
  /\b(?:workbook|worksheets?|spreadsheet|all (?:the )?(?:sheets|tabs)|whole (?:file|workbook)|entire (?:file|workbook)|this file)\b/i;
const WORKBOOK_SCOPE_RE_RU =
  /(?:вс(?:ю|ей|я)\s+книг|это(?:й|)\s+книг|весь\s+файл|все\s+листы|по\s+всем\s+листам|что\s+в\s+этом\s+файле)/i;

// A genuine discovery / decomposition / causal ask — enough on its own.
const DISCOVERY_RE =
  /\bwhy\b|\bdriv(?:e|es|ing|en)\b|\bexplain(?:s|ed|ing)?\b|\bcaus(?:e|es|ed|ing)\b|\bdeteriorat|\bimprov(?:e|ed|ing|ement)\b|\beach\s+(?:sector|segment|region|category|group|year|bank|manager)\b|\bacross\s+(?:the\s+)?(?:two\s+)?years?\b|\bbreak\s?down\b|\bwhat(?:'s| is| appears to be)?\s+(?:driving|behind|causing|going on)\b|\bwhat\s+changed\b|\bhow\s+did\s+\w+\s+change\b/i;
const DISCOVERY_RE_RU =
  /(?:почему|из[- ]за чего|что\s+(?:стало причиной|привело|повлияло)|объясни(?:те)?|ухудш|улучш|по\s+каждому\s+(?:сектору|сегменту|региону|банку)|разбери\s+по|в\s+разрезе|что\s+измен)/i;

// A superlative ("which … most / worst / highest"). Only makes a turn agentic
// when the router already flagged it as a cross-target comparison.
const SUPERLATIVE_RE =
  /\bwhich\s+\w[\w\s]*?\b(?:most|least|worst|best|biggest|largest|smallest|highest|lowest)\b|\bwhat\s+(?:is|was)\s+the\s+(?:most|biggest|largest)\b/i;
const SUPERLATIVE_RE_RU =
  /как(?:ой|ая|ое|ие)\s+[а-яё\s]*?(?:сильнее всего|больше всего|меньше всего|хуже|лучше|наибольш|наименьш)/i;

function matches(text: string, en: RegExp, ru: RegExp): boolean {
  return en.test(text) || ru.test(text);
}

/**
 * Decides whether an unhandled analytical / structural turn should enter the
 * bounded agent loop. Deterministic: same text + route → same answer.
 */
export function classifyAgentEligibility(text: string, route: TurnRoute): AgentEligibility {
  const trimmed = text.trim();

  if (route.route === "general_chat") return { eligible: false, reason: "general-chat" };
  if (route.route === "workbook_mutation") return { eligible: false, reason: "mutation" };
  if (route.reasons.includes("result-transform")) return { eligible: false, reason: "result-transform" };

  // A workbook-wide "what is this workbook about" — needs structural discovery.
  // The router labels these `workbook_qa` OR falls them through to
  // `workbook_analysis` with only the "fallback" reason (nothing analytical was
  // detected). Either way, a workbook-scope phrasing warrants the agent.
  const scoped = matches(trimmed, WORKBOOK_SCOPE_RE, WORKBOOK_SCOPE_RE_RU);
  if (scoped && (route.route === "workbook_qa" || (route.route === "workbook_analysis" && route.reasons.includes("fallback")))) {
    return { eligible: true, reason: "workbook-scope-question" };
  }

  if (route.route !== "workbook_analysis") return { eligible: false, reason: "not-analytical" };

  // A causal / decomposition / "what changed" ask — multi-step by nature.
  if (matches(trimmed, DISCOVERY_RE, DISCOVERY_RE_RU)) {
    return { eligible: true, reason: "discovery-analysis" };
  }

  // A superlative only counts when the router says this reaches across datasets.
  if (route.reasons.includes("cross-target-comparison") && matches(trimmed, SUPERLATIVE_RE, SUPERLATIVE_RE_RU)) {
    return { eligible: true, reason: "cross-target-superlative" };
  }

  return { eligible: false, reason: "deterministic-analysis" };
}
