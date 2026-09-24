export interface AgentBounds {
  /** Maximum model reasoning steps (one typed decision each). */
  readonly maxAgentSteps: number;
  /** Maximum cumulative workbook reads across the whole task. */
  readonly maxWorkbookReads: number;
  /** Row cap for a single structured observation handed back to the model. */
  readonly maxRowsPerObservation: number;
  /** Column cap for a single structured observation. */
  readonly maxColumnsPerObservation: number;
  /** Absolute cell cap (rows x columns) for a single observation. */
  readonly maxObservationCells: number;
  /**
   * How many times the SAME tool call (name + canonical input) or an
   * unparseable model decision may be retried before the loop stops. `1` = the
   * original attempt plus one retry; a third identical attempt terminates.
   */
  readonly maxIdenticalRetries: number;
}

export const AGENT_BOUNDS: AgentBounds = {
  maxAgentSteps: 8,
  maxWorkbookReads: 6,
  maxRowsPerObservation: 100,
  maxColumnsPerObservation: 30,
  maxObservationCells: 3000,
  maxIdenticalRetries: 1,
};

/** Why the loop stopped. Every path terminates with exactly one of these. */
export type AgentTerminationReason =
  | "final_answer"
  | "clarification"
  | "step_budget"
  | "read_budget"
  | "repeated_tool_call"
  | "model_error";
