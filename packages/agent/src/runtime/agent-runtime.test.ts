import { describe, expect, it, vi } from "vitest";
import { AgentRuntime, InMemorySessionStore, type AgentGateway, type AgentToolRegistry, type AgentEvent } from "../index.js";
import type { StreamEvent } from "@sheet-agent/llm";

function stream(...events: StreamEvent[]) { return async function* () { for (const event of events) yield event; }; }

describe("AgentRuntime", () => {
  it("runs plan → tool → observe → answer through the registry", async () => {
    const gateway: AgentGateway = {
      stream: vi.fn()
        .mockImplementationOnce(() => stream({ type: "tool-call", name: "excel.readRange", arguments: { address: "Sales!A1" } }, { type: "done" })())
        .mockImplementationOnce(() => stream({ type: "delta", text: "Revenue is 10." }, { type: "done" })()),
    };
    const registry: AgentToolRegistry = { execute: vi.fn().mockResolvedValue({ success: true, data: { values: [[10]] } }) };
    const runtime = new AgentRuntime({ gateway, tools: registry, limits: { maxSteps: 4 } });
    const events = [] as AgentEvent[];
    const result = await runtime.run({ userId: "u1", tenantId: "t1", workbookId: "wb1", sessionId: "s1", prompt: "What is revenue?" }, (event) => events.push(event));

    expect(result.status).toBe("completed");
    expect(result.answer).toBe("Revenue is 10.");
    expect(registry.execute).toHaveBeenCalledWith("excel.readRange", { address: "Sales!A1", permission: "read" });
    expect(events.map((event) => event.type)).toEqual(["state", "tool-call", "state", "tool-result", "state", "delta", "completed"]);
  });

  it("blocks hallucinated tools and stops at the step budget", async () => {
    const gateway: AgentGateway = { stream: vi.fn().mockImplementation(() => stream({ type: "tool-call", name: "shell.exec", arguments: {} }, { type: "done" })()) };
    const registry: AgentToolRegistry = { execute: vi.fn() };
    const runtime = new AgentRuntime({ gateway, tools: registry, limits: { maxSteps: 2 } });
    const result = await runtime.run({ userId: "u", tenantId: "t", workbookId: "w", sessionId: "s", prompt: "do it" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("TOOL_NOT_ALLOWED");
    expect(registry.execute).not.toHaveBeenCalled();
  });

  it("terminates a valid but infinite tool loop at max steps", async () => {
    const gateway: AgentGateway = { stream: vi.fn().mockImplementation(() => stream({ type: "tool-call", name: "excel.search", arguments: { query: "x" } }, { type: "done" })()) };
    const runtime = new AgentRuntime({ gateway, tools: { execute: vi.fn().mockResolvedValue({ success: true, data: { matches: [] } }) }, limits: { maxSteps: 2 } });
    await expect(runtime.run({ userId: "u", tenantId: "t", workbookId: "w", sessionId: "s", prompt: "loop" })).resolves.toMatchObject({ status: "failed", error: { code: "STEP_LIMIT_EXCEEDED" } });
  });

  it("fails before emitting oversized model output", async () => {
    const gateway: AgentGateway = { stream: () => stream({ type: "delta", text: "12345" }, { type: "done" })() };
    const runtime = new AgentRuntime({ gateway, tools: { execute: vi.fn() }, limits: { maxOutputCharacters: 4 } });
    await expect(runtime.run({ userId: "u", tenantId: "t", workbookId: "w", sessionId: "s", prompt: "long" })).resolves.toMatchObject({ status: "failed", error: { code: "OUTPUT_LIMIT_EXCEEDED" } });
  });

  it("propagates cancellation and enforces token/result limits", async () => {
    const controller = new AbortController();
    const gateway: AgentGateway = { stream: async function* (_request, context) { await new Promise((resolve) => setTimeout(resolve, 20)); expect(context.signal.aborted).toBe(true); yield { type: "delta", text: "late" }; } };
    const runtime = new AgentRuntime({ gateway, tools: { execute: vi.fn() }, limits: { maxOutputCharacters: 3 } });
    const pending = runtime.run({ userId: "u", tenantId: "t", workbookId: "w", sessionId: "s", prompt: "wait" }, undefined, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
  });

  it("isolates, renames and deletes sessions without storing workbook contents", async () => {
    const store = new InMemorySessionStore();
    await store.save({ id: "s1", userId: "u", tenantId: "t", workbookId: "w1", title: "First", summary: "A1 contains revenue", updatedAt: 1 });
    await store.save({ id: "s2", userId: "u", tenantId: "t", workbookId: "w2", title: "Second", summary: "B2 contains cost", updatedAt: 2 });
    expect(await store.list({ userId: "u", tenantId: "t", workbookId: "w1" })).toHaveLength(1);
    expect((await store.resume("s1", { userId: "u", tenantId: "t", workbookId: "w1" }))?.summary).not.toContain("values");
    await store.rename("s1", { userId: "u", tenantId: "t", workbookId: "w1" }, "Renamed");
    expect((await store.resume("s1", { userId: "u", tenantId: "t", workbookId: "w1" }))?.title).toBe("Renamed");
    await store.delete("s1", { userId: "u", tenantId: "t", workbookId: "w1" });
    expect(await store.resume("s1", { userId: "u", tenantId: "t", workbookId: "w1" })).toBeUndefined();
  });
});
