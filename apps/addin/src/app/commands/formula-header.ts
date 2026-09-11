// ---------------------------------------------------------------------------
// Stage 22 — deterministic extraction of the intended calculated-column name
// from a `/formula` argument. Shared by the `/formula` column builder.
// `\w` is avoided throughout — it is ASCII-only and would truncate the Cyrillic
// keywords ("колонку" etc.).
// ---------------------------------------------------------------------------

const NAME = "[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 _-]{0,29}?";
const COLUMN_KEYWORD = "(?:колонк[а-яё]*|столбц[а-яё]*|столбец|поле|поля|column)";

/** Best-effort deterministic pull of the intended new-column name from the args. */
export function deriveColumnName(args: string): string | null {
  const text = args.trim();
  const byEquals = new RegExp(`${COLUMN_KEYWORD}\\s+["'«]?(${NAME})["'»]?\\s*=`, "i").exec(text);
  if (byEquals?.[1]) return byEquals[1].trim();
  const byKeyword = new RegExp(
    `(?:в|into|${COLUMN_KEYWORD})\\s+["'«]?(${NAME})["'»]?(?=\\s+(?:добав|напиш|формул|с\\s+формул|write|add|put|with)|\\s*[:=,]|$)`,
    "i",
  ).exec(text);
  if (byKeyword?.[1]) return byKeyword[1].trim();
  const bareEquals = new RegExp(`^["'«]?(${NAME})["'»]?\\s*=`).exec(text);
  if (bareEquals?.[1]) return bareEquals[1].trim();
  return null;
}
