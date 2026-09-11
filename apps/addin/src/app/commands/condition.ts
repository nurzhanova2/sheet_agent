// ---------------------------------------------------------------------------
// Stage 22 — deterministic parse of a slash command's natural-language
// condition argument ("Fact меньше Plan", "Variance % > 20%",
// "Category = Accessories") into an engine ConditionInput plus a plain-language
// description for the preview. Reuses the compound requirement extractor for the
// numeric / column-to-column forms; adds the equality / contains form it omits.
// ---------------------------------------------------------------------------

import { extractRequirements, type RequirementCondition } from "../../analysis/compound.js";
import type { Condition, ConditionInput, ConditionOperand } from "../../analysis/types.js";

export interface ResolvedCondition {
  readonly condition: ConditionInput;
  /** e.g. `Fact < Plan`, `|Variance %| > 20%`, `Category = "Accessories"`. */
  readonly describe: string;
}

export interface ConditionError {
  readonly error: string;
}

export function isConditionError(value: ResolvedCondition | ConditionError): value is ConditionError {
  return "error" in value;
}

const OP_SYMBOL: Record<string, string> = { "=": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤" };

function describeValue(value: RequirementCondition["value"]): string {
  if (typeof value === "number") return String(value);
  if ("percent" in value) return `${value.percent}%`;
  return value.column;
}

function requirementToEngine(rc: RequirementCondition): ResolvedCondition {
  const left: ConditionOperand = rc.absolute
    ? { kind: "abs", value: { kind: "column", name: rc.column } }
    : { column: rc.column };
  let value: Condition["value"];
  if (typeof rc.value === "number") value = rc.value;
  else if ("percent" in rc.value) value = { kind: "percent", value: rc.value.percent };
  else value = { column: rc.value.column };
  const head = rc.absolute ? `|${rc.column}|` : rc.column;
  const isPercent = typeof rc.value === "object" && "percent" in rc.value;
  return {
    condition: { left, operator: rc.op, value },
    describe: `${head} ${OP_SYMBOL[rc.op] ?? rc.op} ${describeValue(rc.value)}${isPercent ? "" : ""}`,
  };
}

// <header> (=|==|!=|contains|содержит|equals|равно) <value>
const EQ_RE =
  /^(.+?)\s*(==|=|!=|≠|<>|not\s+contains|не\s+содержит|contains|содержит|equals?|равно|is)\s+(.+?)$/i;

function matchHeader(fragment: string, headers: readonly string[]): string | null {
  const hay = fragment.trim().toLowerCase();
  for (const header of [...headers].sort((a, b) => b.length - a.length)) {
    if (hay === header.toLowerCase() || hay.includes(header.toLowerCase())) return header;
  }
  return null;
}

/**
 * Resolves the argument text to a single engine condition. Returns a
 * ConditionError when nothing recognisable is found or the column is unknown.
 */
export function resolveSlashCondition(args: string, headers: readonly string[]): ResolvedCondition | ConditionError {
  const text = args.trim();
  if (!text) return { error: "no condition was given" };

  // numeric threshold + column-to-column ("Fact < Plan", "|Variance %| > 20%")
  const fromRequirements = extractRequirements(text, headers).conditions;
  if (fromRequirements.length > 0 && fromRequirements[0]) {
    return requirementToEngine(fromRequirements[0]);
  }

  // equality / contains ("Category = Accessories", "Comment содержит urgent")
  const eq = EQ_RE.exec(text);
  if (eq) {
    const column = matchHeader(eq[1] ?? "", headers);
    const opWord = (eq[2] ?? "").toLowerCase();
    const rawValue = (eq[3] ?? "").trim().replace(/^["'«»]|["'«»]$/g, "");
    if (column && rawValue) {
      const operator: Condition["operator"] =
        /not\s+contains|не\s+содержит/.test(opWord) ? "not_contains"
        : /contains|содержит/.test(opWord) ? "contains"
        : /!=|≠|<>/.test(opWord) ? "!="
        : "=";
      const numeric = Number(rawValue.replace(",", "."));
      const value = rawValue !== "" && Number.isFinite(numeric) && /^-?[\d.,]+$/.test(rawValue) ? numeric : rawValue;
      const symbol = operator === "contains" ? "⊃" : operator === "not_contains" ? "⊅" : OP_SYMBOL[operator] ?? operator;
      return {
        condition: { left: { column }, operator, value },
        describe: `${column} ${symbol} ${typeof value === "string" ? `"${value}"` : value}`,
      };
    }
  }

  return { error: `no usable condition was found in "${text}"` };
}
