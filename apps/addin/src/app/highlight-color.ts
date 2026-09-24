/** The three approved fills. Values satisfy `HEX_COLOR` in workbook-actions.ts. */
export const HIGHLIGHT_PALETTE = {
  red: "#FFC7CE",
  yellow: "#FFF2CC",
  green: "#C6EFCE",
} as const;

export type HighlightColorName = keyof typeof HIGHLIGHT_PALETTE;

/** The fill used when a highlight is requested with no explicit colour. */
export const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_PALETTE.yellow;

export interface HighlightColor {
  readonly name: HighlightColorName;
  readonly hex: string;
}

const RED_RE = /\b(?:red)\b|красн[а-яё]*|красным/i;
const YELLOW_RE = /\b(?:yellow|amber)\b|жёлт[а-яё]*|желт[а-яё]*/i;
const GREEN_RE = /\b(?:green)\b|зелён[а-яё]*|зелен[а-яё]*/i;

/**
 * Reads a colour word out of a highlight phrase. Returns `null` when no approved
 * colour word is present — callers then use {@link DEFAULT_HIGHLIGHT_COLOR}.
 */
export function parseHighlightColor(text: string): HighlightColor | null {
  if (RED_RE.test(text)) return { name: "red", hex: HIGHLIGHT_PALETTE.red };
  if (GREEN_RE.test(text)) return { name: "green", hex: HIGHLIGHT_PALETTE.green };
  if (YELLOW_RE.test(text)) return { name: "yellow", hex: HIGHLIGHT_PALETTE.yellow };
  return null;
}
