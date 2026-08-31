import { describe, expect, it, vi } from "vitest";
import { QwenProvider } from "./qwen.js";

describe("QwenProvider", () => {
  it("sends an OpenAI-compatible streaming request and normalizes SSE", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer qwen-secret");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "qwen-plus", stream: true });
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')); controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n')); controller.close(); } });
      return new Response(body, { status: 200 });
    });
    const provider = new QwenProvider({ apiKey: "qwen-secret", endpoint: "https://qwen.test/v1/chat/completions", fetchImpl });
    const result = [];
    for await (const event of provider.stream({ model: "qwen-plus", stream: true, messages: [{ role: "user", content: "hello" }] }, new AbortController().signal)) result.push(event);
    expect(result).toEqual([{ type: "delta", text: "Hi" }, { type: "done", usage: { inputTokens: 2, outputTokens: 1 } }]);
  });

  it("rejects empty keys and hides the key from provider errors", () => {
    expect(() => new QwenProvider({ apiKey: " " })).toThrow("API key is required");
  });
});
