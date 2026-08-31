export interface ModelCapability { readonly tools: boolean; readonly streaming: boolean; readonly contextWindow: number; }

export type MessageRole = "system" | "user" | "assistant" | "tool";
export interface ChatMessage { readonly role: MessageRole; readonly content: string; readonly name?: string; }
export interface ChatRequest { readonly model: string; readonly messages: readonly ChatMessage[]; readonly stream: true; readonly provider?: string; readonly tools?: readonly unknown[]; }
export type StreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly type: "done"; readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } }
  | { readonly type: "error"; readonly code: string; readonly message: string };
export interface LlmProvider { readonly name: string; stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> | Promise<AsyncIterable<StreamEvent>>; }
export interface GatewayOptions { readonly providers: Readonly<Record<string, LlmProvider>>; readonly defaultProvider: string; readonly allowedProviders?: readonly string[]; readonly timeoutMs?: number; }

export class LlmGateway {
  constructor(private readonly options: GatewayOptions) {}

  async *stream(request: ChatRequest, context: { readonly correlationId?: string; readonly signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    const providerName = request.provider ?? this.options.defaultProvider;
    if (this.options.allowedProviders && !this.options.allowedProviders.includes(providerName)) {
      yield { type: "error", code: "PROVIDER_NOT_ALLOWED", message: "The requested provider is not allowed by policy." };
      return;
    }
    const provider = this.options.providers[providerName];
    if (!provider) { yield { type: "error", code: "PROVIDER_NOT_FOUND", message: "The requested provider is unavailable." }; return; }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.options.timeoutMs ?? 60_000);
    try {
      const iterable = await provider.stream(request, controller.signal);
      for await (const event of iterable) {
        if (context.signal?.aborted) { yield { type: "error", code: "LLM_CANCELLED", message: "The request was cancelled." }; return; }
        if (controller.signal.aborted) { yield { type: "error", code: "LLM_TIMEOUT", message: "The provider request timed out." }; return; }
        yield event;
      }
    } catch (error) {
      yield { type: "error", code: controller.signal.aborted ? "LLM_TIMEOUT" : "LLM_PROVIDER_ERROR", message: error instanceof Error ? error.message : "Provider request failed." };
    } finally { clearTimeout(timeout); context.signal?.removeEventListener("abort", forwardAbort); }
  }
}

export { QwenProvider, type QwenProviderOptions } from "./providers/qwen.js";
