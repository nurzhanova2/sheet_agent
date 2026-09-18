// ---------------------------------------------------------------------------
// Stage 25 §7 — execution budget for the analytical planner loop.
//
// Every analytical tool has `readCost: 1` (tool-registry.ts), so
// `maxWorkbookReads` below doubles as "max analytical tool calls" — no change
// needed to the shared `agent/agent-loop.ts` runtime to enforce it.
// ---------------------------------------------------------------------------

import type { AgentBounds } from "../agent/bounds.js";

export const ANALYTICAL_PLANNER_BOUNDS: AgentBounds = {
  maxAgentSteps: 12,
  maxWorkbookReads: 8,
  maxRowsPerObservation: 100,
  maxColumnsPerObservation: 30,
  maxObservationCells: 3000,
  maxIdenticalRetries: 1,
};
