export type SlashCommandName =
  | "analyze"
  | "summary"
  | "formula"
  | "filter"
  | "sort"
  | "highlight"
  | "chart"
  | "pivot"
  | "clean"
  | "undo"
  // Stage 23 — workbook-level intelligence.
  | "workbook"
  | "sheets"
  | "find"
  | "compare"
  | "new-sheet"
  | "copy";

export type SlashCategory = "analyze" | "transform" | "visualize" | "create" | "history";

/**
 * How the resolved turn is forced through the existing pipeline. The route is
 * chosen deterministically from the command — never from planner output.
 *  - "analysis":      read-only deterministic analysis (no workbook mutation).
 *  - "visualization": the existing chart pipeline (ChartData stays the source of truth).
 *  - "mutation":      a workbook change via sheet-agent-actions → Preview / Approve / Reject / Undo.
 *  - "undo":          reuse the existing SheetAgent undo stack.
 */
export type SlashRoute = "analysis" | "visualization" | "mutation" | "undo";

export type SlashArgMode = "none" | "optional" | "required";

export interface SlashCommand {
  readonly name: SlashCommandName;
  /** What the user types, e.g. "/chart". */
  readonly label: string;
  /** One short human-readable line. No GoalIntent IDs or implementation terms. */
  readonly description: string;
  readonly category: SlashCategory;
  readonly args: SlashArgMode;
  readonly route: SlashRoute;
  /** True when approval + undo apply (the command can change the workbook). */
  readonly mutating: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "analyze",
    label: "/analyze",
    description: "Deterministic overview of the selected range — shape, column types, key statistics.",
    category: "analyze",
    args: "optional",
    route: "analysis",
    mutating: false,
  },
  {
    name: "summary",
    label: "/summary",
    description: "Concise summary of the current selection, or of one metric grouped by a category.",
    category: "analyze",
    args: "optional",
    route: "analysis",
    mutating: false,
  },
  {
    name: "formula",
    label: "/formula",
    description: "Add a column or formula described in plain language. Previewed before it is applied.",
    category: "transform",
    args: "required",
    route: "mutation",
    mutating: true,
  },
  {
    name: "filter",
    label: "/filter",
    description: "Keep the rows that match a condition and report how many match.",
    category: "transform",
    args: "required",
    route: "analysis",
    mutating: false,
  },
  {
    name: "sort",
    label: "/sort",
    description: "Order the rows by one or more columns, ascending or descending.",
    category: "transform",
    args: "required",
    route: "analysis",
    mutating: false,
  },
  {
    name: "highlight",
    label: "/highlight",
    description: "Fill the cells that match a condition with a colour. Previewed before it is applied.",
    category: "transform",
    args: "required",
    route: "mutation",
    mutating: true,
  },
  {
    name: "chart",
    label: "/chart",
    description: "Build a chart from the selection using the deterministic engine.",
    category: "visualize",
    args: "required",
    route: "visualization",
    mutating: false,
  },
  {
    name: "pivot",
    label: "/pivot",
    description: "Aggregate one metric across one or two categories as a pivot table.",
    category: "visualize",
    args: "required",
    route: "analysis",
    mutating: false,
  },
  {
    name: "clean",
    label: "/clean",
    description: "Inspect the selection for blanks, duplicates and inconsistent values. Nothing changes without approval.",
    category: "transform",
    args: "optional",
    route: "analysis",
    mutating: false,
  },
  {
    name: "undo",
    label: "/undo",
    description: "Undo the last change SheetAgent applied to the workbook.",
    category: "history",
    args: "none",
    route: "undo",
    mutating: false,
  },
  {
    name: "workbook",
    label: "/workbook",
    description: "Concise deterministic overview of every worksheet in the workbook.",
    category: "analyze",
    args: "none",
    route: "analysis",
    mutating: false,
  },
  {
    name: "sheets",
    label: "/sheets",
    description: "Compact list of worksheets with their row and column dimensions.",
    category: "analyze",
    args: "none",
    route: "analysis",
    mutating: false,
  },
  {
    name: "find",
    label: "/find",
    description: "Locate a name across worksheet titles, tables and column headers.",
    category: "analyze",
    args: "required",
    route: "analysis",
    mutating: false,
  },
  {
    name: "compare",
    label: "/compare",
    description: "Compare one column's aggregates between two named worksheets.",
    category: "analyze",
    args: "required",
    route: "analysis",
    mutating: false,
  },
  {
    name: "new-sheet",
    label: "/new-sheet",
    description: "Create a new empty worksheet. Previewed before it is created.",
    category: "create",
    args: "required",
    route: "mutation",
    mutating: true,
  },
  {
    name: "copy",
    label: "/copy",
    description: "Copy a resolved range to a destination worksheet. Previewed before it is applied.",
    category: "transform",
    args: "required",
    route: "mutation",
    mutating: true,
  },
];

/** Display order and heading for the palette's category groups. */
export const SLASH_CATEGORY_ORDER: readonly SlashCategory[] = ["analyze", "transform", "visualize", "create", "history"];

export const SLASH_CATEGORY_LABEL: Record<SlashCategory, string> = {
  analyze: "ANALYZE",
  transform: "TRANSFORM",
  visualize: "VISUALIZE",
  create: "CREATE",
  history: "HISTORY",
};

const BY_NAME: ReadonlyMap<string, SlashCommand> = new Map(SLASH_COMMANDS.map((command) => [command.name, command]));

/** Looks up a command by bare name ("chart") or label ("/chart"), case-insensitively. */
export function findSlashCommand(nameOrLabel: string): SlashCommand | undefined {
  return BY_NAME.get(nameOrLabel.trim().replace(/^\//, "").toLowerCase());
}

/**
 * Commands whose full result is deterministic and needs no natural-language
 * interpretation of the arguments (they may run with no arguments at all).
 */
export function isDeterministicSlash(name: SlashCommandName): boolean {
  return name === "analyze" || name === "summary" || name === "pivot" || name === "clean";
}

/**
 * Palette filter. `query` is the text after "/" (already lower-cased is fine).
 * Prefix matches rank before substring matches; registry order is otherwise kept.
 */
export function filterSlashCommands(query: string): readonly SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return SLASH_COMMANDS;
  const prefix = SLASH_COMMANDS.filter((command) => command.name.startsWith(q));
  const infix = SLASH_COMMANDS.filter((command) => !command.name.startsWith(q) && command.name.includes(q));
  return [...prefix, ...infix];
}

/** Filtered commands grouped for the palette, in category order, empty groups dropped. */
export function groupedSlashCommands(query: string): readonly (readonly [SlashCategory, readonly SlashCommand[]])[] {
  const items = filterSlashCommands(query);
  const groups: (readonly [SlashCategory, readonly SlashCommand[]])[] = [];
  for (const category of SLASH_CATEGORY_ORDER) {
    const group = items.filter((command) => command.category === category);
    if (group.length > 0) groups.push([category, group]);
  }
  return groups;
}
