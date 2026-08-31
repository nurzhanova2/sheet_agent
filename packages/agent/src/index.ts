export type AgentStatus = "idle" | "thinking" | "reading" | "executing" | "awaiting_confirmation" | "completed" | "failed" | "cancelled";

import type { ChatMessage, ChatRequest, StreamEvent } from "@sheet-agent/llm";

export type AgentEvent =
  | { readonly type: "state"; readonly status: AgentStatus; readonly step: number }
  | { readonly type: "tool-call"; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly type: "tool-result"; readonly name: string; readonly success: boolean }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "completed"; readonly answer: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export interface AgentGateway { stream(request: ChatRequest, context: { readonly correlationId: string; readonly signal: AbortSignal }): AsyncIterable<StreamEvent>; }
export interface AgentToolRegistry { execute(name: string, arguments_: Readonly<Record<string, unknown>>): Promise<{ readonly success: boolean; readonly data?: unknown; readonly error?: { readonly code: string; readonly message: string } }>; }
export interface AgentLimits { readonly maxSteps?: number; readonly maxTools?: number; readonly maxOutputCharacters?: number; readonly maxContextCharacters?: number; }
export interface AgentRunContext { readonly userId: string; readonly tenantId: string; readonly workbookId: string; readonly sessionId: string; readonly prompt: string; }
export interface AgentResult { readonly status: Extract<AgentStatus, "completed" | "failed" | "cancelled">; readonly answer?: string; readonly error?: { readonly code: string; readonly message: string }; }

const READ_TOOL_NAMES = new Set(["excel.getWorkbookOverview", "excel.readSelection", "excel.readRange", "excel.readFormulas", "excel.readTable", "excel.search"]);

export class AgentRuntime {
  readonly #limits: Required<AgentLimits>;
  constructor(private readonly options: { readonly gateway: AgentGateway; readonly tools: AgentToolRegistry; readonly limits?: AgentLimits; readonly model?: string }) {
    this.#limits = { maxSteps: 8, maxTools: 12, maxOutputCharacters: 16_000, maxContextCharacters: 32_000, ...options.limits };
  }

  async run(context: AgentRunContext, onEvent: (event: AgentEvent) => void = () => undefined, signal: AbortSignal = new AbortController().signal): Promise<AgentResult> {
    const messages: ChatMessage[] = [{ role: "user", content: context.prompt.slice(0, this.#limits.maxContextCharacters) }];
    let answer = "";
    let toolsUsed = 0;
    for (let step = 1; step <= this.#limits.maxSteps; step += 1) {
      if (signal.aborted) return { status: "cancelled" };
      onEvent({ type: "state", status: "thinking", step });
      let toolCall: Extract<StreamEvent, { type: "tool-call" }> | undefined;
      try {
        const request: ChatRequest = { model: this.options.model ?? "default", messages, stream: true, tools: [...READ_TOOL_NAMES].map((name) => ({ name })) };
        for await (const event of this.options.gateway.stream(request, { correlationId: `${context.tenantId}:${context.sessionId}`, signal })) {
          if (signal.aborted) return { status: "cancelled" };
          if (event.type === "delta") { answer += event.text; onEvent(event); if (answer.length > this.#limits.maxOutputCharacters) return { status: "failed", error: { code: "OUTPUT_LIMIT_EXCEEDED", message: "Agent output limit exceeded." } }; }
          else if (event.type === "tool-call") { toolCall = event; onEvent(event); }
          else if (event.type === "error") return { status: event.code === "LLM_CANCELLED" ? "cancelled" : "failed", error: { code: event.code, message: event.message } };
        }
      } catch (error) { return { status: "failed", error: { code: "AGENT_RUNTIME_ERROR", message: error instanceof Error ? error.message : "Agent runtime failed." } }; }
      if (!toolCall) { onEvent({ type: "completed", answer }); return { status: "completed", answer }; }
      if (!READ_TOOL_NAMES.has(toolCall.name)) return { status: "failed", error: { code: "TOOL_NOT_ALLOWED", message: `Tool is not registered: ${toolCall.name}` } };
      if (++toolsUsed > this.#limits.maxTools) return { status: "failed", error: { code: "TOOL_LIMIT_EXCEEDED", message: "Tool call limit exceeded." } };
      onEvent({ type: "state", status: "reading", step });
      const result = await this.options.tools.execute(toolCall.name, { ...toolCall.arguments, permission: "read" });
      onEvent({ type: "tool-result", name: toolCall.name, success: result.success });
      messages.push({ role: "assistant", content: `[tool-call:${toolCall.name}]` }, { role: "tool", name: toolCall.name, content: JSON.stringify(result.data ?? result.error ?? { success: result.success }).slice(0, this.#limits.maxContextCharacters) });
      if (!result.success) return { status: "failed", error: result.error ?? { code: "TOOL_FAILED", message: "Tool failed." } };
    }
    return { status: "failed", error: { code: "STEP_LIMIT_EXCEEDED", message: "Agent step limit exceeded." } };
  }
}

export interface SessionScope { readonly userId: string; readonly tenantId: string; readonly workbookId: string; }
export interface SessionRecord extends SessionScope { readonly id: string; readonly title: string; readonly summary: string; readonly updatedAt: number; }
export class InMemorySessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  async save(record: SessionRecord): Promise<void> { this.#sessions.set(record.id, { ...record, summary: record.summary.slice(0, 2_000) }); }
  async list(scope: SessionScope): Promise<SessionRecord[]> { return [...this.#sessions.values()].filter((session) => this.matches(session, scope)).sort((a, b) => b.updatedAt - a.updatedAt); }
  async resume(id: string, scope: SessionScope): Promise<SessionRecord | undefined> { const session = this.#sessions.get(id); return session && this.matches(session, scope) ? { ...session } : undefined; }
  async rename(id: string, scope: SessionScope, title: string): Promise<void> { const session = await this.resume(id, scope); if (session) this.#sessions.set(id, { ...session, title: title.slice(0, 120), updatedAt: Date.now() }); }
  async delete(id: string, scope: SessionScope): Promise<void> { if (await this.resume(id, scope)) this.#sessions.delete(id); }
  private matches(session: SessionScope, scope: SessionScope): boolean { return session.userId === scope.userId && session.tenantId === scope.tenantId && session.workbookId === scope.workbookId; }
}
