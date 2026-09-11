// ---------------------------------------------------------------------------
// Stage 24.3A / 24.5 — deterministic planning for autonomous cross-sheet
// comparison from a natural-language turn ("what changed between 2024 and
// 2025?", "compare Fact between Sales Test Data and Agent Test").
//
// This module NEVER reads the workbook and NEVER guesses between material
// alternatives:
//   • two targets that each resolve to exactly one sheet (or one is the current
//     selection) → a concrete compare plan;
//   • a target that matches two or more distinct dataset families → ambiguous;
//   • a target with no candidate sheet at all → missing;
//   • more candidate sheets than the discovery budget → budget stop.
//
// The caller resolves the plan into bounded reads + the Stage 23 compare
// builder, or into a PendingClarification / missing-data message.
// ---------------------------------------------------------------------------

import type { WorkbookMap, WorkbookMapSheet } from "./commands/workbook-map.js";
import { detectComparison } from "./conversation-route.js";

/** Hard budgets for one autonomous discovery turn. Never exposed to the user. */
export const DISCOVERY_BUDGET = {
  maxWorkbookMapBuilds: 1,
  maxRangeReads: 4,
  maxCandidateSheetsPerTarget: 6,
  maxTotalCandidateSheets: 8,
  maxAnalysisOperations: 6,
} as const;

export type CrossSheetPlan =
  | { readonly kind: "no_targets" }
  | { readonly kind: "budget"; readonly detail: string }
  | { readonly kind: "missing"; readonly missing: string; readonly found: string }
  | { readonly kind: "dataset_ambiguous"; readonly candidates: readonly string[] }
  | {
      readonly kind: "compare";
      readonly sheetA: string;
      readonly sheetB: string;
      readonly targetA: string;
      readonly targetB: string;
      /** Metric column named in the text, if any (resolved later against both sheets). */
      readonly metric?: string;
    };

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Strips a trailing / leading year or short number token, leaving the "family" name. */
export function datasetFamily(sheetName: string): string {
  return sheetName
    .replace(/(?:fy|q[1-4]|h[12])\s?(?:19|20)?\d{2,4}/gi, "")
    .replace(/\b(?:19|20)\d{2}\b/g, "")
    .replace(/\b(?:q[1-4]|fy|h[12])\b/gi, "")
    .replace(/[_\-–—]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function candidateSheets(map: WorkbookMap, target: string): WorkbookMapSheet[] {
  const wanted = norm(target);
  const visible = map.sheets.filter((s) => s.visibility === "visible" && s.usedAddress);
  const exact = visible.filter((s) => norm(s.name) === wanted);
  if (exact.length > 0) return exact;
  return visible.filter((s) => norm(s.name).includes(wanted) || wanted.includes(norm(s.name)));
}

/** Reads a metric column name from "compare <Metric> between …" style phrasing. */
function metricHint(text: string): string | null {
  const m =
    /\bcompare\s+([A-Za-z][A-Za-z0-9 _%]{0,30}?)\s+between\b/i.exec(text) ??
    /\b(?:for|of|in)\s+([A-Za-z][A-Za-z0-9 _%]{0,30}?)\s+between\b/i.exec(text) ??
    /сравн\w*\s+([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 _%]{0,30}?)\s+между\b/i.exec(text);
  return m?.[1]?.trim() || null;
}

/**
 * Plans an autonomous comparison. `currentSheet` (the active selection's sheet)
 * can satisfy one of the two targets so only the other side needs discovery.
 */
export function planCrossSheetComparison(
  map: WorkbookMap,
  text: string,
  currentSheet?: string,
  forcedFamily?: string,
): CrossSheetPlan {
  const cmp = detectComparison(text);
  if (!cmp || cmp.targets.length < 2) return { kind: "no_targets" };
  const [ta, tb] = cmp.targets as [string, string];

  const familyOk = (name: string): boolean => {
    if (!forcedFamily) return true;
    const f = norm(forcedFamily);
    return norm(datasetFamily(name)).includes(f) || norm(name).includes(f);
  };
  const rawA = candidateSheets(map, ta).filter((s) => familyOk(s.name));
  const rawB = candidateSheets(map, tb).filter((s) => familyOk(s.name));

  const currentMatches = (t: string): WorkbookMapSheet | undefined => {
    if (!currentSheet) return undefined;
    const s = map.sheets.find((x) => x.name === currentSheet);
    if (!s) return undefined;
    return norm(s.name).includes(norm(t)) ? s : undefined;
  };
  const candA = rawA.length > 0 ? rawA : currentMatches(ta) ? [currentMatches(ta)!] : [];
  const candB = rawB.length > 0 ? rawB : currentMatches(tb) ? [currentMatches(tb)!] : [];

  if (
    candA.length > DISCOVERY_BUDGET.maxCandidateSheetsPerTarget ||
    candB.length > DISCOVERY_BUDGET.maxCandidateSheetsPerTarget ||
    candA.length + candB.length > DISCOVERY_BUDGET.maxTotalCandidateSheets
  ) {
    return { kind: "budget", detail: `${candA.length}+${candB.length} candidate sheets` };
  }

  if (candA.length === 0 || candB.length === 0) {
    const missing = candA.length === 0 ? ta : tb;
    const found = candA.length === 0 ? tb : ta;
    return { kind: "missing", missing, found };
  }

  // One unambiguous sheet per side → compare.
  if (candA.length === 1 && candB.length === 1) {
    const plan: CrossSheetPlan = {
      kind: "compare",
      sheetA: candA[0]!.name,
      sheetB: candB[0]!.name,
      targetA: ta,
      targetB: tb,
    };
    const metric = metricHint(text);
    return metric ? { ...plan, metric } : plan;
  }

  // Several sheets per side: only safe if they resolve to ONE shared family.
  const famA = new Set(candA.map((s) => datasetFamily(s.name)).filter(Boolean));
  const famB = new Set(candB.map((s) => datasetFamily(s.name)).filter(Boolean));
  const shared = [...famA].filter((f) => famB.has(f));

  if (shared.length === 1) {
    const fam = shared[0]!;
    const pickA = candA.find((s) => datasetFamily(s.name) === fam);
    const pickB = candB.find((s) => datasetFamily(s.name) === fam);
    if (pickA && pickB) {
      const plan: CrossSheetPlan = { kind: "compare", sheetA: pickA.name, sheetB: pickB.name, targetA: ta, targetB: tb };
      const metric = metricHint(text);
      return metric ? { ...plan, metric } : plan;
    }
  }

  const candidates = [...new Set([...famA, ...famB])].filter(Boolean);
  return { kind: "dataset_ambiguous", candidates: candidates.length > 0 ? candidates : candA.concat(candB).map((s) => s.name) };
}

/** Numeric columns common (case-insensitively) to both header lists. */
export function commonNumericColumns(
  headersA: readonly string[],
  headersB: readonly string[],
  numericA: ReadonlySet<string>,
  numericB: ReadonlySet<string>,
): string[] {
  const bLower = new Map(headersB.map((h) => [norm(h), h] as const));
  const out: string[] = [];
  for (const h of headersA) {
    const match = bLower.get(norm(h));
    if (match && numericA.has(h) && numericB.has(match)) out.push(h);
  }
  return out;
}
