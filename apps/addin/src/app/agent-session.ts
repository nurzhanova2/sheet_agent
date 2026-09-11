import type { AppliedChange, WorkbookAction } from "./workbook-actions.js";
import type { ChartData } from "../visualization/types.js";

export type AgentActivityKind =
  | "reading"
  | "analyzing"
  | "calculating"
  | "visualizing"
  | "searching"
  | "planning"
  | "writing"
  | "waiting_for_approval"
  | "completed"
  | "failed";

export type ActivityStatus = "running" | "done" | "error";

export interface CommandEntry {
  readonly kind: "command";
  readonly id: string;
  readonly text: string;
}
export interface ActivityEntry {
  readonly kind: "activity";
  readonly id: string;
  readonly activity: AgentActivityKind;
  readonly title: string;
  readonly detail?: string;
  readonly status: ActivityStatus;
}
export interface ResponseEntry {
  readonly kind: "response";
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
}
/** Stage 24.11 — one ordered step of a compound conversational workbook change. */
export type WorkflowStep =
  | { readonly kind: "create_sheet"; readonly name: string }
  | { readonly kind: "cells"; readonly actions: readonly WorkbookAction[]; readonly label: string };

export interface ProposalEntry {
  readonly kind: "proposal";
  readonly id: string;
  readonly actions: readonly WorkbookAction[];
  readonly state: "pending" | "applying" | "applied" | "rejected" | "failed";
  readonly note?: string;
  readonly appliedChangeIds?: readonly string[];
  /**
   * Stage 23 — a non-cell workbook operation previewed through the SAME
   * Preview / Approve / Undo flow. When present, `actions` is empty.
   */
  readonly sheetOp?: { readonly kind: "create_sheet"; readonly name: string };
  /**
   * Stage 24.11 — an ordered compound workbook change (e.g. create a worksheet
   * then write a result table into it) previewed and approved as ONE
   * transaction and reverted by ONE `/undo`. When present, `actions` is empty.
   */
  readonly workflow?: readonly WorkflowStep[];
}
export interface NoticeEntry {
  readonly kind: "notice";
  readonly id: string;
  readonly tone: "warn" | "error";
  readonly text: string;
}
export interface ChartEntry {
  readonly kind: "chart";
  readonly id: string;
  readonly data: ChartData;
}

export type TranscriptEntry =
  | CommandEntry
  | ActivityEntry
  | ResponseEntry
  | ProposalEntry
  | NoticeEntry
  | ChartEntry;

export type UndoableChange =
  // One approved proposal = one undo transaction, however many internal cell
  // actions it applied (e.g. /highlight fans out to many contiguous ranges).
  | { readonly kind: "cells"; readonly changes: readonly AppliedChange[]; readonly label: string }
  | { readonly kind: "shape"; readonly sheetName: string; readonly shapeName: string; readonly label: string }
  // Stage 23 — `/new-sheet`. Undo deletes ONLY the worksheet SheetAgent created.
  | { readonly kind: "sheet"; readonly sheetName: string; readonly label: string }
  // Stage 24.11 — a compound workflow. Revert is reverse execution order:
  // undo each cells step newest-first, then delete any worksheet it created.
  | {
      readonly kind: "workflow";
      readonly label: string;
      readonly steps: readonly (
        | { readonly kind: "create_sheet"; readonly name: string }
        | { readonly kind: "cells"; readonly changes: readonly AppliedChange[] }
      )[];
    };

export const ACTIVITY_LABEL: Record<AgentActivityKind, string> = {
  reading: "Reading",
  analyzing: "Analyzing",
  calculating: "Calculating",
  visualizing: "Visualizing",
  searching: "Searching",
  planning: "Planning",
  writing: "Writing",
  waiting_for_approval: "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
};

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}
