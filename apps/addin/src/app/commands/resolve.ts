// ---------------------------------------------------------------------------
// Stage 22 — turns a parsed slash command into the two things the existing
// pipeline needs: a natural-language prompt (so the planner and the deterministic
// floors behave exactly as they do for the equivalent typed request) and a
// locked TurnIntent (so planner output can never change the command's identity).
// ---------------------------------------------------------------------------

import type { TurnIntent } from "../intent.js";
import type { ResponseLanguage } from "../language.js";
import type { SlashCommandName } from "./registry.js";

/**
 * The intent for a slash turn is fixed by the command, NOT by scanning the
 * argument text. `/filter Fact less than Plan` can never be treated as a chart;
 * `/chart …` is always a visualization.
 */
export function slashTurnIntent(name: SlashCommandName): TurnIntent {
  const visualization = name === "chart";
  const analytical =
    visualization ||
    name === "analyze" ||
    name === "summary" ||
    name === "filter" ||
    name === "sort" ||
    name === "pivot" ||
    name === "clean";
  // Stage 23 workbook commands (`workbook`, `sheets`, `find`, `compare`,
  // `new-sheet`, `copy`) resolve deterministically and early-return before the
  // plan phase, so they are neither analytical reads nor charts.
  return { analytical, visualization, matched: [`/${name}`] };
}

/** True when the command may change the workbook (approval + undo apply). */
export function slashIsMutation(name: SlashCommandName): boolean {
  return name === "formula" || name === "highlight" || name === "new-sheet" || name === "copy";
}

/** Stage 23 — commands that need the deterministic workbook map / resolver. */
export function slashNeedsWorkbookMap(name: SlashCommandName): boolean {
  return (
    name === "workbook" ||
    name === "sheets" ||
    name === "find" ||
    name === "compare" ||
    name === "new-sheet" ||
    name === "copy" ||
    name === "summary" ||
    name === "analyze"
  );
}

/**
 * A natural-language phrasing of the command + arguments. This is what the
 * planner and the RU/EN language detector see, so `/chart` and the equivalent
 * "построй график …" request resolve identically.
 */
export function slashPrompt(name: SlashCommandName, args: string, language: ResponseLanguage): string {
  const ru = language === "ru";
  const tail = args.trim();
  switch (name) {
    case "chart":
      return ru ? `Построй график: ${tail}` : `Build a chart: ${tail}`;
    case "filter":
      return ru
        ? `Оставь строки, где ${tail}. Покажи совпавшие строки и их количество; ничего не меняй в книге.`
        : `Keep the rows where ${tail}. Show the matching rows and how many there are; do not change the workbook.`;
    case "sort":
      return ru
        ? `Отсортируй данные: ${tail}. Покажи результат; ничего не меняй в книге.`
        : `Sort the data by ${tail}. Show the result; do not change the workbook.`;
    case "pivot":
      return ru ? `Сводная таблица: ${tail}` : `Pivot table: ${tail}`;
    case "formula":
      return tail;
    case "highlight":
      return ru
        ? `Выдели заливкой ячейки, где ${tail}.`
        : `Highlight with a fill colour the cells where ${tail}.`;
    case "summary":
      return tail || (ru ? "Кратко опиши выделенные данные." : "Summarise the selected data.");
    case "analyze":
      return tail || (ru ? "Проанализируй выделенный диапазон." : "Analyse the selected range.");
    case "clean":
      return tail || (ru ? "Проверь данные на пропуски и дубликаты." : "Inspect the data for blanks and duplicates.");
    case "workbook":
      return ru ? "Опиши структуру книги." : "Describe the workbook structure.";
    case "sheets":
      return ru ? "Покажи список листов." : "List the worksheets.";
    case "find":
      return ru ? `Найди «${tail}» в структуре книги.` : `Find "${tail}" in the workbook structure.`;
    case "compare":
      return ru ? `Сравни: ${tail}` : `Compare: ${tail}`;
    case "new-sheet":
      return ru ? `Создай лист «${tail}».` : `Create a worksheet named "${tail}".`;
    case "copy":
      return ru ? `Скопируй ${tail}` : `Copy ${tail}`;
    case "undo":
      return tail; // never routed through the model; present for exhaustiveness
  }
}
