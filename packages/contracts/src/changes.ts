import type { ChangeSetId, OperationId } from "./ids.js";

export type ChangeRisk = "low" | "medium" | "high";

export interface RangeReference {
  readonly sheet: string;
  readonly address: string;
}

export interface ChangeOperation {
  readonly operationId: OperationId;
  readonly type: string;
  readonly target: RangeReference;
  readonly before: unknown;
  readonly after: unknown;
  readonly risk: ChangeRisk;
}

export interface ChangeSet {
  readonly schemaVersion: "1";
  readonly id: ChangeSetId;
  readonly description: string;
  readonly operations: readonly ChangeOperation[];
  readonly affectedRanges: readonly RangeReference[];
  readonly createdAt: string;
  readonly risk: ChangeRisk;
}
