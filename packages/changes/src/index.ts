export type ChangeSetStatus = "proposed" | "approved" | "applying" | "verifying" | "committed" | "rolling_back" | "rolled_back" | "rejected";

import type { CellValue, RangeSnapshot } from "@sheet-agent/application";
import type { ChangeOperation, ChangeRisk, ChangeSet, RangeReference } from "@sheet-agent/contracts";

export interface WritableExcelPort {
  readRange(address: string): Promise<RangeSnapshot>;
  writeRange(address: string, values: readonly (readonly CellValue[])[]): Promise<void>;
  restoreRange(address: string, snapshot: RangeSnapshot): Promise<void>;
  recalculate(): Promise<void>;
}
export interface ManagedChangeSet extends ChangeSet { readonly status: ChangeSetStatus; readonly approvedAt?: string; readonly destructiveConfirmed?: boolean; readonly snapshot?: RangeSnapshot; }
export class ChangeManagementError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "ChangeManagementError"; } }

function id(prefix: string): string { return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`; }
function equalValues(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export function diffSnapshots(before: unknown, after: unknown, maxChanges = 500): readonly { readonly row: number; readonly column: number; readonly before: unknown; readonly after: unknown }[] {
  if (!Array.isArray(before) || !Array.isArray(after)) return equalValues(before, after) ? [] : [{ row: 1, column: 1, before, after }];
  const changes: { row: number; column: number; before: unknown; after: unknown }[] = [];
  const rows = Math.max(before.length, after.length);
  for (let row = 0; row < rows && changes.length < maxChanges; row += 1) {
    const beforeRow = Array.isArray(before[row]) ? before[row] : []; const afterRow = Array.isArray(after[row]) ? after[row] : [];
    const columns = Math.max(beforeRow.length, afterRow.length);
    for (let column = 0; column < columns && changes.length < maxChanges; column += 1) if (!equalValues(beforeRow[column], afterRow[column])) changes.push({ row: row + 1, column: column + 1, before: beforeRow[column], after: afterRow[column] });
  }
  return changes;
}

export class ChangeSetService {
  readonly #changes = new Map<string, ManagedChangeSet>();
  readonly #queues = new Map<string, Promise<void>>();
  constructor(private readonly excel: WritableExcelPort, private readonly options: { readonly maxDiffChanges?: number; readonly retentionMs?: number } = {}) {}

  async propose(input: { readonly description: string; readonly target: RangeReference; readonly before: unknown; readonly after: unknown; readonly risk: ChangeRisk }): Promise<ManagedChangeSet> {
    if (!input.description.trim() || !input.target.sheet.trim() || !input.target.address.trim()) throw new ChangeManagementError("INVALID_CHANGESET", "Description and target are required");
    const operation: ChangeOperation = { operationId: id("op") as ChangeOperation["operationId"], type: "set-values", target: input.target, before: input.before, after: input.after, risk: input.risk };
    return this.proposeOperations(input.description, [operation], input.risk);
  }

  async proposeOperations(description: string, operations: readonly ChangeOperation[], risk: ChangeRisk = "low"): Promise<ManagedChangeSet> {
    if (!description.trim() || operations.length === 0 || operations.some((operation) => !operation.target.sheet.trim() || !operation.target.address.trim())) throw new ChangeManagementError("INVALID_CHANGESET", "Description and operations are required");
    const change: ManagedChangeSet = { schemaVersion: "1", id: id("cs") as ChangeSet["id"], description, operations, affectedRanges: operations.map((operation) => operation.target), createdAt: new Date().toISOString(), risk, status: "proposed" };
    this.#changes.set(change.id, change); return change;
  }

  async get(id_: string): Promise<ManagedChangeSet | undefined> { const change = this.#changes.get(id_); if (!change) return undefined; if (this.options.retentionMs && Date.now() - Date.parse(change.createdAt) > this.options.retentionMs) { this.#changes.delete(id_); return undefined; } return change; }
  async approve(id_: string, options: { readonly destructiveConfirmed?: boolean } = {}): Promise<ManagedChangeSet> { const change = await this.require(id_); if (change.status !== "proposed") throw new ChangeManagementError("INVALID_STATE", "Only proposed changes can be approved"); if (change.risk === "high" && !options.destructiveConfirmed) throw new ChangeManagementError("DESTRUCTIVE_CONFIRMATION_REQUIRED", "High-risk changes require explicit confirmation"); const approved = { ...change, status: "approved" as const, approvedAt: new Date().toISOString(), ...(options.destructiveConfirmed ? { destructiveConfirmed: true } : {}) }; this.#changes.set(id_, approved); return approved; }
  async reject(id_: string): Promise<ManagedChangeSet> { const change = await this.require(id_); const rejected = { ...change, status: "rejected" as const }; this.#changes.set(id_, rejected); return rejected; }

  async apply(id_: string): Promise<ManagedChangeSet> {
    const existing = await this.require(id_); if (existing.status === "committed") return existing; if (existing.status !== "approved") throw new ChangeManagementError("APPROVAL_REQUIRED", "ChangeSet must be approved before apply");
    const key = existing.affectedRanges[0]?.sheet ?? "workbook"; const prior = this.#queues.get(key) ?? Promise.resolve(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const queued = prior.then(() => gate); this.#queues.set(key, queued); await prior;
    try {
      const current = await this.excel.readRange(existing.affectedRanges[0]?.address ?? ""); const operation = existing.operations[0];
      if (!operation || !equalValues(current.values, operation.before)) throw new ChangeManagementError("PRECONDITION_FAILED", "Workbook changed since preview");
      this.#changes.set(id_, { ...existing, status: "applying", snapshot: current });
      await this.excel.writeRange(operation.target.address, operation.after as readonly (readonly CellValue[])[]); await this.excel.recalculate();
      this.#changes.set(id_, { ...existing, status: "verifying", snapshot: current });
      const actual = await this.excel.readRange(operation.target.address); if (!equalValues(actual.values, operation.after)) { await this.excel.restoreRange(operation.target.address, current); const rolledBack = { ...existing, status: "rolled_back" as const, snapshot: current }; this.#changes.set(id_, rolledBack); throw new ChangeManagementError("VERIFICATION_FAILED", "Read-back verification failed; workbook restored"); }
      const committed = { ...existing, status: "committed" as const, snapshot: current }; this.#changes.set(id_, committed); return committed;
    } finally { release(); if (this.#queues.get(key) === queued) this.#queues.delete(key); }
  }

  async undo(id_: string): Promise<ManagedChangeSet> { const change = await this.require(id_); if (change.status !== "committed" || !change.snapshot) throw new ChangeManagementError("UNDO_UNAVAILABLE", "Only committed changes with a snapshot can be undone"); const operation = change.operations[0]; if (!operation) throw new ChangeManagementError("UNDO_UNAVAILABLE", "No operation to undo"); await this.excel.restoreRange(operation.target.address, change.snapshot); const undone = { ...change, status: "rolled_back" as const }; this.#changes.set(id_, undone); return undone; }
  private async require(id_: string): Promise<ManagedChangeSet> { const change = await this.get(id_); if (!change) throw new ChangeManagementError("CHANGESET_NOT_FOUND", "ChangeSet not found"); return change; }
}
