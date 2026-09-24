export type ResultActionKind = "chart" | "insert_chart" | "highlight" | "copy" | "write";

export interface ResultActionIntent {
  readonly kind: ResultActionKind;
  /** Destination worksheet named in the phrase (copy / write), if any. */
  readonly sheetName?: string;
  /** True when the phrase asks for a NEW sheet ("on a new Summary sheet"). */
  readonly newSheet: boolean;
  /** Destination cell if explicitly named ("to Summary!C1"). */
  readonly anchor?: string;
  readonly phrase: string;
}

const DEMONSTRATIVE = "(?:that|this|it|those|these|them|him|her|the (?:result|table|rows|matching rows|chart|top \\d+))";
// Stage 24.5 — "по ним" / "них" (about them). Stage 24.5.1 — "его / её / ее"
// (him / her / it) so a single-entity follow-up ("выдели его красным") routes
// deterministically instead of falling through to the answer model.
const DEMONSTRATIVE_RU = "(?:это|эту|этот|эти|те|их|его|её|ее|ним|них|этой таблиц[а-яё]*|эту таблицу|таблицу)";

const CHART_RE = new RegExp(`\\b(?:chart|plot|graph|visuali[sz]e)\\b[^.?!]*?\\b${DEMONSTRATIVE}\\b`, "i");
// "построй по ним график" — the reference may precede or follow the noun.
const CHART_RE_RU = new RegExp(
  `(?:построй|нарисуй|сделай|постройте)[а-яё]*\\s+(?:${DEMONSTRATIVE_RU}\\s+)?(?:график|диаграмм[а-яё]*)|(?:построй|нарисуй|сделай)[а-яё]*\\s+(?:график|диаграмм[а-яё]*)[^.?!]*?${DEMONSTRATIVE_RU}`,
  "i",
);
const INSERT_CHART_RE = /\b(?:insert|place|put|add|embed)\b[^.?!]*?\b(?:that|the|this|it)\s+(?:chart|image|picture)\b|\b(?:insert|embed)\s+it\b/i;
const INSERT_CHART_RE_RU = /встав[а-яё]*\s+(?:этот\s+|тот\s+)?(?:график|диаграмм[а-яё]*|его|её|ее)/i;
const HIGHLIGHT_RE = new RegExp(`\\b(?:highlight|mark|shade|colou?r)\\b[^.?!]*?\\b${DEMONSTRATIVE}\\b`, "i");
const HIGHLIGHT_RE_RU = new RegExp(`(?:выдели|подсвети|отметь|закрась)[а-яё]*\\s+(?:${DEMONSTRATIVE_RU}|строк[а-яё]*)`, "i");
// Stage 24.5 §22 — "highlight the worst manager red" / "выдели самого проблемного
// менеджера красным": a highlight verb + a superlative entity phrase, no
// demonstrative. Resolved against the previous analytical result (§5 selection
// drift — the live selection is not consulted).
const HIGHLIGHT_SUPERLATIVE_RE =
  /\b(?:highlight|mark|shade|colou?r)\b[^.?!]*?\b(?:worst|best|most\s+problematic|under[-\s]?performing|lowest|highest|weakest|strongest|top|bottom)\b/i;
const HIGHLIGHT_SUPERLATIVE_RE_RU =
  /(?:выдели|подсвети|отметь|закрась)[а-яё]*\s+(?:сам[а-яё]+\s+)?(?:проблемн|худш|отстающ|лучш|слаб|наибол|наимень|максимальн|минимальн|нарушител)[а-яё]*/i;

const SHEET_NAME = "([A-Za-z0-9][A-Za-z0-9 _'-]{0,39})";
const COPY_RE = new RegExp(
  `\\b(?:copy|move)\\b[^.?!]*?\\b${DEMONSTRATIVE}\\b[^.?!]*?\\b(?:to|into|onto)\\s+${SHEET_NAME}`,
  "i",
);
const COPY_RE_RU = new RegExp(
  `(?:скопир|перенес)[а-яё]*\\s+(?:${DEMONSTRATIVE_RU}|строк[а-яё]*)[^.?!]*?\\s+(?:в|на)\\s+${SHEET_NAME}`,
  "i",
);
const WRITE_RE = new RegExp(
  `\\b(?:put|write|place|send|export|save|drop)\\b[^.?!]*?\\b${DEMONSTRATIVE}\\b[^.?!]*?\\b(?:to|on|onto|into)\\s+(?:a\\s+new\\s+)?${SHEET_NAME}`,
  "i",
);
const WRITE_RE_RU = new RegExp(
  `(?:вынес|запиш|помест|полож|сохран)[а-яё]*\\s+(?:${DEMONSTRATIVE_RU})[^.?!]*?\\s+(?:на|в)\\s+(?:новый\\s+лист\\s+)?${SHEET_NAME}`,
  "i",
);
const NEW_SHEET_RE = /\bon a new\s+([A-Za-z0-9][A-Za-z0-9 _'-]{0,39}?)\s+sheet\b|\bto a new\s+([A-Za-z0-9][A-Za-z0-9 _'-]{0,39}?)\s+sheet\b/i;
const NEW_SHEET_RE_RU = /нов(?:ый|ым)\s+лист\s+([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 _'-]{0,39})/i;
const ANCHOR_RE = /\b(?:at|starting at|to)\s+([A-Za-z]{1,3}\d{1,7})\b/i;

function cleanSheet(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const name = raw
    .trim()
    .replace(/^["'«]|["'»]$/g, "")
    .replace(/\s+(?:sheet|worksheet|tab|лист[а-яё]*)$/i, "")
    .replace(/[.?!,;:]+$/, "")
    .trim();
  return name.length > 0 ? name : undefined;
}

/** Reads a follow-up as an action on the last remembered result / row set. */
export function detectResultAction(text: string): ResultActionIntent | null {
  const t = text.trim();

  const insertChart = INSERT_CHART_RE.exec(t) ?? INSERT_CHART_RE_RU.exec(t);
  if (insertChart) return { kind: "insert_chart", newSheet: false, phrase: insertChart[0].trim() };

  const chart = CHART_RE.exec(t) ?? CHART_RE_RU.exec(t);
  if (chart) return { kind: "chart", newSheet: false, phrase: chart[0].trim() };

  const copy = COPY_RE.exec(t) ?? COPY_RE_RU.exec(t);
  if (copy) {
    const anchorM = ANCHOR_RE.exec(t);
    const dest = cleanSheet(copy[1]);
    return {
      kind: "copy",
      newSheet: false,
      ...(dest ? { sheetName: dest } : {}),
      ...(anchorM?.[1] ? { anchor: anchorM[1].toUpperCase() } : {}),
      phrase: copy[0].trim(),
    };
  }

  const write = WRITE_RE.exec(t) ?? WRITE_RE_RU.exec(t);
  if (write) {
    const newM = NEW_SHEET_RE.exec(t) ?? NEW_SHEET_RE_RU.exec(t);
    const newSheetName = cleanSheet(newM?.[1] ?? newM?.[2]);
    const sheetName = newSheetName ?? cleanSheet(write[1]);
    const anchorM = ANCHOR_RE.exec(t);
    return {
      kind: "write",
      newSheet: Boolean(newM),
      ...(sheetName ? { sheetName } : {}),
      ...(anchorM?.[1] ? { anchor: anchorM[1].toUpperCase() } : {}),
      phrase: write[0].trim(),
    };
  }

  const highlight =
    HIGHLIGHT_RE.exec(t) ??
    HIGHLIGHT_RE_RU.exec(t) ??
    HIGHLIGHT_SUPERLATIVE_RE.exec(t) ??
    HIGHLIGHT_SUPERLATIVE_RE_RU.exec(t);
  if (highlight) return { kind: "highlight", newSheet: false, phrase: highlight[0].trim() };

  return null;
}
