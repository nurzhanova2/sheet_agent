import type { ConversationId, EventId, RunId } from "./ids.js";

export type AgentEventType =
  | "run.started"
  | "status.changed"
  | "message.delta"
  | "tool.started"
  | "tool.completed"
  | "change.proposed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface AgentEvent<TPayload = unknown> {
  readonly schemaVersion: "1";
  readonly conversationId: ConversationId;
  readonly runId: RunId;
  readonly eventId: EventId;
  readonly timestamp: string;
  readonly type: AgentEventType;
  readonly payload: TPayload;
}
