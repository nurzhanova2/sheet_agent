import { describe, expect, it } from "vitest";
import { LlmGateway, type LlmProvider, type ChatRequest, type StreamEvent } from "../index.js";

const request: ChatRequest = { model: "test-model", messages: [{ role: "user", content: "hello" }], stream: true };

async function* events(values: readonly StreamEvent[], delayMs = 0) {
  for (const value of values) { if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs)); yield value; }
}

describe("LlmGateway", () => {
  it("normalizes provider events and preserves correlation metadata", async () => {
    const provider: LlmProvider = { name: "fake", stream: async () => events([{ type: "delta", text: "Hi" }, { type: "done", usage: { inputTokens: 2, outputTokens: 1 } }]) };
    const gateway = new LlmGateway({ providers: { fake: provider }, defaultProvider: "fake" });
    const result: StreamEvent[] = [];
    for await (const event of gateway.stream(request, { correlationId: "run-1" })) result.push(event);
    expect(result).toEqual([{ type: "delta", text: "Hi" }, { type: "done", usage: { inputTokens: 2, outputTokens: 1 } }]);
  });

  it("cancels downstream provider work and enforces timeout", async () => {
    const provider: LlmProvider = { name: "slow", stream: async (_request, signal) => events([{ type: "delta", text: "late" }], signal.aborted ? 0 : 100) };
    const gateway = new LlmGateway({ providers: { slow: provider }, defaultProvider: "slow", timeoutMs: 10 });
    const result: StreamEvent[] = [];
    for await (const event of gateway.stream({ ...request, provider: "slow" }, {})) result.push(event);
    expect(result.at(-1)).toMatchObject({ type: "error", code: "LLM_TIMEOUT" });
  });

  it("rejects unknown or disallowed providers", async () => {
    const provider: LlmProvider = { name: "fake", stream: async () => events([]) };
    const gateway = new LlmGateway({ providers: { fake: provider }, defaultProvider: "fake", allowedProviders: ["fake"] });
    const result: StreamEvent[] = [];
    for await (const event of gateway.stream({ ...request, provider: "openai" }, {})) result.push(event);
    expect(result[0]).toMatchObject({ type: "error", code: "PROVIDER_NOT_ALLOWED" });
  });
});
