export type RolloutRing = "internal" | "pilot" | "ga";
export interface PerformanceBudgets { readonly startupMs: number; readonly selectionMs: number; readonly toolMs: number; readonly llmFirstTokenMs: number; readonly changePreviewMs: number; }
export const DEFAULT_PERFORMANCE_BUDGETS: PerformanceBudgets = Object.freeze({ startupMs: 2_000, selectionMs: 500, toolMs: 3_000, llmFirstTokenMs: 3_000, changePreviewMs: 1_000 });
export function isBudgetCompliant(measured: Partial<PerformanceBudgets>, budgets: PerformanceBudgets = DEFAULT_PERFORMANCE_BUDGETS): boolean { return Object.entries(measured).every(([key, value]) => typeof value !== "number" || value <= budgets[key as keyof PerformanceBudgets]); }
export function canPromote(current: RolloutRing, stability: { readonly errorRate: number; readonly dataLossIncidents: number }): boolean { if (stability.dataLossIncidents > 0 || stability.errorRate > 0.02) return false; return current === "internal" || current === "pilot"; }
