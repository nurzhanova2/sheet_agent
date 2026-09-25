import { validateClaimsAgainstFacts, type VerifiedFact } from "../analysis/facts.js";
import { formatNumber } from "../analysis/format-number.js";
import type { AgentObservation } from "./types.js";

// Mirrors chat-client.ts CAUSAL_OVERCLAIM_TOKENS — the agent must not claim the
// data proves / guarantees a cause.
const CAUSAL_OVERCLAIM_TOKENS: readonly string[] = [
  "proves that", "is proof that", "proof that", "guarantees that",
  "доказывает, что", "доказывает что", "гарантирует, что", "является доказательством",
];

// §3/§10 — an unsupported causal claim about the numbers ("X caused Y",
// "because lending standards weakened", "driven by …"). Deliberately narrow to
// avoid rejecting legitimate hedged interpretation.
const CAUSAL_CLAIM_RE =
  /\b(?:caus(?:e|ed|es|ing)\s+(?:the|this|it|a|an|its|their)|led\s+to\s+the|drove\s+the|attributable\s+to|because\s+(?:of\s+)?(?:weak|poor|lax|lending|risk|management|policy|underwriting|standards|the\s+bank))|из-за\s+(?:слаб|плох|недостаточн)|привело\s+к/i;

/**
 * VerifiedFacts from the agent's successful table observations:
 *  - one ScalarFact per numeric cell (labelled by the row key), and
 *  - one RankingFact + max/min ExtremeFacts per numeric column,
 * so "X rose by N" AND "X deteriorated the most" are both grounded.
 */
export function agentEvidenceFacts(observations: readonly AgentObservation[]): VerifiedFact[] {
  const facts: VerifiedFact[] = [];
  let seq = 0;
  const push = (fact: Record<string, unknown>, obs: AgentObservation): void => {
    seq += 1;
    facts.push({
      id: `AF${seq}`,
      sourceOperationId: obs.operation ?? obs.tool,
      sourceRange: obs.source ?? "agent",
      ...fact,
    } as unknown as VerifiedFact);
  };

  for (const obs of observations) {
    if (!obs.ok || obs.kind !== "table" || !obs.columns || !obs.rows) continue;
    const cols = obs.columns;
    const rows = obs.rows;
    const labelIdx = cols.findIndex((_, ci) => rows.every((r) => typeof r[ci] !== "number"));

    for (const row of rows) {
      const group = labelIdx >= 0 ? String(row[labelIdx] ?? "") : "";
      for (let ci = 0; ci < cols.length; ci += 1) {
        const v = row[ci];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        push(
          {
            kind: "scalar",
            label: `${cols[ci] ?? ""}${group ? ` — ${group}` : ""}`,
            formatted: formatNumber(v),
            value: v,
            metric: cols[ci] ?? "",
            ...(group ? { group } : {}),
          },
          obs,
        );
      }
    }

    if (labelIdx >= 0) {
      for (let ci = 0; ci < cols.length; ci += 1) {
        if (ci === labelIdx) continue;
        const pairs = rows
          .map((r) => [String(r[labelIdx] ?? ""), r[ci]] as const)
          .filter((p): p is readonly [string, number] => typeof p[1] === "number" && Number.isFinite(p[1]));
        if (pairs.length < 2) continue;
        const desc = [...pairs].sort((a, b) => b[1] - a[1]);
        push(
          {
            kind: "ranking",
            label: `${cols[ci] ?? ""} ranking`,
            formatted: desc.map(([g, v]) => `${g} (${formatNumber(v)})`).join(" > "),
            metric: cols[ci] ?? "",
            direction: "desc",
            order: desc.map(([g]) => g),
            values: desc.map(([, v]) => v),
          },
          obs,
        );
        const top = desc[0]!;
        const bot = desc[desc.length - 1]!;
        push({ kind: "extreme", which: "max", group: top[0], value: top[1], metric: cols[ci] ?? "", label: `max ${cols[ci] ?? ""}`, formatted: `${top[0]} (${formatNumber(top[1])})` }, obs);
        push({ kind: "extreme", which: "min", group: bot[0], value: bot[1], metric: cols[ci] ?? "", label: `min ${cols[ci] ?? ""}`, formatted: `${bot[0]} (${formatNumber(bot[1])})` }, obs);

        // §3 — one ComparisonFact per adjacent pair so "A > B" / "A changed more
        // than B" grounds without the model doing arithmetic. Bounded.
        if (desc.length <= 8) {
          for (let k = 0; k + 1 < desc.length; k += 1) {
            const a = desc[k]!;
            const b = desc[k + 1]!;
            push(
              {
                kind: "comparison",
                label: `${a[0]} vs ${b[0]} (${cols[ci] ?? ""})`,
                formatted: `${a[0]} ${formatNumber(a[1])} > ${b[0]} ${formatNumber(b[1])}`,
                subject: a[0],
                relation: a[1] === b[1] ? "equal" : "greater_than",
                object: b[0],
                subjectValue: a[1],
                objectValue: b[1],
              },
              obs,
            );
          }
        }
      }
    }
    if (facts.length > 400) break;
  }
  return facts;
}

export interface AgentAnswerCheck {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/**
 * Validates the agent's final answer: no causal over-claim, and every
 * workbook-derived number is backed by an evidence fact (years / small ordinals
 * / observation row counts are structural and exempt, exactly as for a normal
 * analytical turn).
 */
export function validateAgentAnswer(
  finalAnswer: string,
  facts: readonly VerifiedFact[],
  dataRowCounts: readonly number[] = [],
  // Stage 27.x.1 §25 — numbers an upstream resolver has already adjudicated.
  //
  // The V2 narration gate resolves every numeric token against NarrationFacts,
  // which know each value's UNIT, its deterministic rendering, and which spans
  // of the text are entity names rather than claims — none of which is visible
  // here. Where the two disagreed, this one was wrong: it rejected «снижение
  // на 70,00%» because the fact reads -0.7 and the sign lives in the verb, and
  // it rejected an answer for the digits inside «… и верни 999», which is a
  // row LABEL. So the caller that has done that work says so, and the numeric
  // clause below steps aside for exactly those tokens.
  //
  // It is not a way to silence the check. An empty set — every caller that
  // does no resolution of its own, which is every Stage 26 path — leaves this
  // function behaving precisely as it did.
  resolvedNumbers: ReadonlySet<number> = new Set(),
): AgentAnswerCheck {
  const reasons: string[] = [];
  const lower = finalAnswer.toLowerCase();
  for (const token of CAUSAL_OVERCLAIM_TOKENS) {
    if (lower.includes(token)) {
      reasons.push(`the answer claims the data proves a cause ("${token.trim()}")`);
      break;
    }
  }
  // §3/§10 — a bare causal claim about the workbook's numbers is not supported by
  // any observation; the workbook has no causal dimension. Narrow patterns only.
  if (
    CAUSAL_CLAIM_RE.test(finalAnswer) &&
    !/\b(cannot be established|can'?t be established|not established|no (?:dimension|variable|column))\b/i.test(finalAnswer)
  ) {
    reasons.push("the answer states a cause the workbook does not establish");
  }
  const structural = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 100, ...dataRowCounts, ...resolvedNumbers]);
  reasons.push(...validateClaimsAgainstFacts(finalAnswer, facts, structural));
  return { ok: reasons.length === 0, reasons };
}
