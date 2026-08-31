import type { ChatRequest, LlmProvider, StreamEvent } from "../index.js";

export interface QwenProviderOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createQwenProvider(apiKey: string | undefined, endpoint?: string): QwenProvider | undefined {
  return apiKey?.trim() ? new QwenProvider({ apiKey, ...(endpoint ? { endpoint } : {}) }) : undefined;
}

/** Qwen's OpenAI-compatible Chat Completions adapter (DashScope or a compatible gateway). */
export class QwenProvider implements LlmProvider {
  readonly name = "qwen";
  readonly #options: Required<QwenProviderOptions>;

  constructor(options: QwenProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("Qwen API key is required");
    this.#options = {
      apiKey: options.apiKey,
      endpoint: options.endpoint ?? "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await this.#options.fetchImpl(this.#options.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: request.model, messages: request.messages, stream: true, ...(request.tools ? { tools: request.tools } : {}) }),
      signal,
    });
    if (!response.ok) throw new Error(`Qwen provider returned HTTP ${response.status}`);
    if (!response.body) throw new Error("Qwen provider returned an empty stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data) as { choices?: readonly { delta?: { content?: string }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const choice = payload.choices?.[0];
        if (choice?.delta?.content) yield { type: "delta", text: choice.delta.content };
        if (choice?.finish_reason) yield { type: "done", ...(payload.usage ? { usage: { inputTokens: payload.usage.prompt_tokens ?? 0, outputTokens: payload.usage.completion_tokens ?? 0 } } : {}) };
      }
      if (chunk.done) break;
    }
  }
}
