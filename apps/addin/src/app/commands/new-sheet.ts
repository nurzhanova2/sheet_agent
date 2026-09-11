// ---------------------------------------------------------------------------
// Stage 23 — `/new-sheet <Name>` (deterministic, previewed mutation).
//
//   command → validate → Preview → Approve → port.addWorksheet → confirmation
//           → Undo (port.deleteWorksheet, removing ONLY the sheet we created).
//
// No mutation before Approve. One command = one undo transaction (the shared
// undo stack, a new "sheet" variant alongside the chart-shape variant).
// ---------------------------------------------------------------------------

import type { ResponseLanguage } from "../language.js";
import type { WorkbookMap } from "./workbook-map.js";

export interface NewSheetProposal {
  readonly text: string;
  /** The exact worksheet name to create. */
  readonly name: string;
}
export interface NewSheetError {
  readonly error: string;
}
export function isNewSheetError(v: NewSheetProposal | NewSheetError): v is NewSheetError {
  return "error" in v;
}

// Excel worksheet-name rules: 1..31 chars, none of \ / ? * [ ] :, not blank,
// not wrapped in apostrophes, and "History" is reserved.
const INVALID_CHARS = /[\\/?*[\]:]/;
const RESERVED = /^history$/i;

export type SheetNameProblem = "empty" | "tooLong" | "invalidChars" | "edgeApostrophe" | "reserved";

export function validateSheetName(raw: string): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: SheetNameProblem } {
  // Strip surrounding double quotes / guillemets only — a single quote is both a
  // quote char and an illegal edge character, so leave it for the check below.
  const name = raw.trim().replace(/^["«](.*)["»]$/, "$1").trim();
  if (name === "") return { ok: false, reason: "empty" };
  if (name.length > 31) return { ok: false, reason: "tooLong" };
  if (INVALID_CHARS.test(name)) return { ok: false, reason: "invalidChars" };
  if (name.startsWith("'") || name.endsWith("'")) return { ok: false, reason: "edgeApostrophe" };
  if (RESERVED.test(name)) return { ok: false, reason: "reserved" };
  return { ok: true, name };
}

function problemText(reason: SheetNameProblem, language: ResponseLanguage): string {
  const ru = language === "ru";
  switch (reason) {
    case "empty":
      return ru ? "Укажите имя листа: `/new-sheet Summary`." : "Give a sheet name: `/new-sheet Summary`.";
    case "tooLong":
      return ru ? "Имя листа не может быть длиннее 31 символа." : "A worksheet name cannot be longer than 31 characters.";
    case "invalidChars":
      return ru
        ? "Имя листа не может содержать символы \\ / ? * [ ] :."
        : "A worksheet name cannot contain any of \\ / ? * [ ] :.";
    case "edgeApostrophe":
      return ru ? "Имя листа не может начинаться или заканчиваться апострофом." : "A worksheet name cannot start or end with an apostrophe.";
    case "reserved":
      return ru ? "«History» — зарезервированное имя листа в Excel." : '"History" is a name Excel reserves.';
  }
}

export function buildNewSheetProposal(map: WorkbookMap, rawName: string, language: ResponseLanguage): NewSheetProposal | NewSheetError {
  const ru = language === "ru";
  const validated = validateSheetName(rawName);
  if (!validated.ok) return { error: problemText(validated.reason, language) };

  const duplicate = map.sheets.find((sheet) => sheet.name.toLowerCase() === validated.name.toLowerCase());
  if (duplicate) {
    return {
      error: ru
        ? `Лист «${duplicate.name}» уже существует. Выберите другое имя.`
        : `A worksheet named "${duplicate.name}" already exists. Choose another name.`,
    };
  }

  return {
    name: validated.name,
    text: ru
      ? `Будет создан новый пустой лист «${validated.name}». Подтвердите изменение.`
      : `A new empty worksheet "${validated.name}" will be created. Approve the change.`,
  };
}
