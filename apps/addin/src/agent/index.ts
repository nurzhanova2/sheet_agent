// Stage 24.4 — bounded agentic analysis loop (public surface).
export { AGENT_BOUNDS, type AgentBounds, type AgentTerminationReason } from "./bounds.js";
export { parseAgentDecision } from "./decision-schema.js";
export { clampObservation, observationCellCount } from "./observation.js";
export { createAgentToolRegistry, defaultAgentTools } from "./tool-registry.js";
export { deriveMetric, DERIVED_METRIC_OPERATORS, type DerivedMetricOperator, type DerivedMetricSpec } from "./derived-metrics.js";
export { agentEvidenceFacts, validateAgentAnswer, type AgentAnswerCheck } from "./evidence.js";
export { runAgentLoop, summariseAgentRun, type RunAgentLoopParams, type AgentRunTrace, type AgentStepTrace } from "./agent-loop.js";
export type {
  AgentDecision,
  AgentDecisionContext,
  AgentDecisionKind,
  AgentDecisionRequest,
  AgentLanguage,
  AgentResume,
  AgentLoopState,
  AgentLoopStatus,
  AgentObservation,
  AgentObservationKind,
  AgentPendingClarification,
  AgentResultLike,
  AgentStep,
  AgentTool,
  AgentToolContext,
  AgentToolDeps,
  AgentToolRegistry,
  AgentToolSchema,
  ChartBuildResult,
  ParsedDecision,
  SheetSnapshotResult,
  ToolInputResult,
} from "./types.js";
