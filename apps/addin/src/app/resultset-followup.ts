// ---------------------------------------------------------------------------
// Stage 24.9 §5–§7/§17/§18/§35/§39 — ResultSetRef / DirectionChangeAnalysisRef
// follow-up detection. Pure text classification only — memory lookup and
// rendering happen in use-agent.ts, exactly like event-followup.ts.
// ---------------------------------------------------------------------------

export interface ResultSetFollowupIntent {
  readonly kind: "top1";
  /** A hint at WHICH prior ranking-shaped result "из них" refers to, when the
   *  superlative word names it explicitly ("самый волатильный" → volatility). */
  readonly operationHint?: "volatility" | "stability";
}

// "какой из них самый волатильный?" / "который из них наиболее стабилен?"
const TOP1_RE =
  /как(?:ой|ая|ое)\s+из\s+них\s+(?:сам(?:ый|ая|ое)\s+)?(волатильн\p{L}*|нестабильн\p{L}*|стабильн\p{L}*|устойчив\p{L}*)|which\s+of\s+them\s+is\s+the\s+most\s+(volatile|stable)/iu;

/** Stage 24.9 §7/§35 — "какой из них самый волатильный?": reuse the prior
 *  ResultSetRef's stored order, never recompute a fresh workbook-wide ranking. */
export function detectResultSetFollowup(text: string): ResultSetFollowupIntent | null {
  const m = TOP1_RE.exec(text);
  if (!m) return null;
  const word = (m[1] ?? m[2] ?? "").toLowerCase();
  const operationHint: ResultSetFollowupIntent["operationHint"] =
    /волатильн|нестабильн|volatile/.test(word) ? "volatility" : /стабильн|устойчив|stable/.test(word) ? "stability" : undefined;
  return { kind: "top1", ...(operationHint ? { operationHint } : {}) };
}

// "в какие периоды он менял направление?"
const DIRECTION_PERIODS_RE =
  /в\s+как(?:ие|ой)\s+период\p{L}*\s+(?:он|она|оно|это)?\s*менял\p{L}*\s+направлен\p{L}*|when\s+did\s+(?:it|this)\s+change\s+direction/iu;

/** Stage 24.9 §18/§43 — "В какие периоды он менял направление?": reads the
 *  stored DirectionChangeAnalysisRef's events directly, never re-derived. */
export function detectDirectionPeriodsFollowup(text: string): boolean {
  return DIRECTION_PERIODS_RE.test(text);
}
