import type { ChangeOperation, ChangeRisk, RangeReference } from "@sheet-agent/contracts";
import { ChangeManagementError, type ChangeSetService, type ManagedChangeSet, type WritableExcelPort } from "@sheet-agent/changes";

export interface WorkflowPort extends WritableExcelPort {
  readonly capabilities: { readonly tables: boolean; readonly charts: boolean; readonly pivots: boolean };
}
const ref = (address: string): RangeReference => { const separator = address.lastIndexOf("!"); return { sheet: address.slice(0, separator), address }; };
const operation = (type: string, target: RangeReference, before: unknown, after: unknown, risk: ChangeRisk = "low"): ChangeOperation => ({ operationId: `op_${crypto.randomUUID()}` as ChangeOperation["operationId"], type, target, before, after, risk });

export class WorkflowEngine {
  constructor(private readonly changes: ChangeSetService, private readonly port: WorkflowPort) {}
  async formulaAssist(input: { readonly range: string; readonly formulas: readonly (readonly string[])[]; readonly mode: "fill" | "fix" | "generate" }): Promise<ManagedChangeSet> {
    const startRow = Number(/![A-Z]+(\d+)/.exec(input.range)?.[1] ?? 1); const after = input.formulas.map((row, index) => row[0] ? [row[0]] : [`=A${startRow + index}+B${startRow + index}`]);
    return this.changes.proposeOperations(`formula ${input.mode} for ${input.range}`, [operation("set-formulas", ref(input.range), input.formulas, after)], "low");
  }
  async clean(input: { readonly range: string; readonly values: readonly (readonly CellValue[])[]; readonly trim?: boolean; readonly normalizeNumbers?: boolean; readonly removeDuplicates?: boolean }): Promise<ManagedChangeSet> {
    let after = input.values.map((row) => row.map((value) => { if (input.trim && typeof value === "string") return value.trim(); if (input.normalizeNumbers && typeof value === "string") { const parsed = Number(value.replace(/\s/g, "").replace(",", ".")); return Number.isFinite(parsed) ? parsed : value; } return value; }));
    if (input.removeDuplicates) { const seen = new Set<string>(); after = after.filter((row) => { const key = JSON.stringify(row); if (seen.has(key)) return false; seen.add(key); return true; }); }
    return this.changes.proposeOperations(`Clean values in ${input.range}`, [operation("clean-values", ref(input.range), input.values, after, input.removeDuplicates ? "high" : "medium")], input.removeDuplicates ? "high" : "medium");
  }
  async sort(input: { readonly range: string; readonly values: readonly (readonly CellValue[])[]; readonly column: number; readonly direction: "asc" | "desc" }): Promise<ManagedChangeSet> { const after = [...input.values].sort((left, right) => String(left[input.column] ?? "").localeCompare(String(right[input.column] ?? "")) * (input.direction === "asc" ? 1 : -1)); return this.changes.proposeOperations(`Sort ${input.range} ${input.direction}`, [operation("sort-range", ref(input.range), input.values, after)]); }
  async createTable(input: { readonly range: string; readonly name: string }): Promise<ManagedChangeSet> { if (!this.port.capabilities.tables) throw new ChangeManagementError("CAPABILITY_UNAVAILABLE", "Tables are not supported"); return this.changes.proposeOperations(`Create table ${input.name}`, [operation("create-table", ref(input.range), null, { name: input.name, range: input.range })]); }
  async createChart(input: { readonly range: string; readonly title: string }): Promise<ManagedChangeSet> { if (!this.port.capabilities.charts) throw new ChangeManagementError("CAPABILITY_UNAVAILABLE", "Charts are not supported"); return this.changes.proposeOperations(`Create chart ${input.title}`, [operation("create-chart", ref(input.range), null, { title: input.title, range: input.range })]); }
  async createPivot(input: { readonly range: string; readonly name: string }): Promise<ManagedChangeSet> { if (!this.port.capabilities.pivots) throw new ChangeManagementError("CAPABILITY_UNAVAILABLE", "Pivot tables are not supported by this host"); return this.changes.proposeOperations(`Create pivot ${input.name}`, [operation("create-pivot", ref(input.range), null, { name: input.name, range: input.range })]); }
  async report(input: { readonly range: string; readonly steps: readonly ("clean" | "chart")[] }): Promise<ManagedChangeSet> { const operations = input.steps.map((step) => step === "clean" ? operation("clean-values", ref(input.range), "bounded-read", "normalized-values", "medium") : operation("create-chart", ref(input.range), null, { title: "Report" })); return this.changes.proposeOperations(`Multi-step report for ${input.range}`, operations, operations.some((item) => item.risk === "high") ? "high" : "medium"); }
}
import type { CellValue } from "@sheet-agent/application";
