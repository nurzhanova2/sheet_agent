import type { TokenVerifier } from "../auth/auth.js";
import { authenticate } from "../auth/auth.js";
import { redactSecrets } from "@sheet-agent/security";
import type { ChatRequest, StreamEvent } from "@sheet-agent/llm";

interface Gateway { stream(request: ChatRequest, context: { readonly correlationId: string; readonly signal: AbortSignal }): AsyncIterable<StreamEvent>; }
interface ChatApiOptions { readonly verifyToken: TokenVerifier; readonly gateway: Gateway; readonly maxBodyBytes?: number; readonly authMode?: "required" | "none"; readonly defaultTenantId?: string; }

export function createChatApi(options: ChatApiOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const auth = options.authMode === "none" ? { userId: "local-user", tenantId: options.defaultTenantId ?? "local" } : await authenticate(request, options.verifyToken);
    if (!auth) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, { status: 401 });
    if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." } }, { status: 405 });
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > (options.maxBodyBytes ?? 256_000)) return Response.json({ error: { code: "REQUEST_TOO_LARGE", message: "Request exceeds the size limit." } }, { status: 413 });
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return Response.json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } }, { status: 400 }); }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { messages?: unknown }).messages)) return Response.json({ error: { code: "INVALID_REQUEST", message: "messages is required." } }, { status: 400 });
    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort(request.signal.reason), { once: true });
    const stream = options.gateway.stream(parsed as ChatRequest, { correlationId: `${auth.tenantId}:${auth.userId}`, signal: controller.signal });
    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      async start(streamController) {
        try { for await (const event of stream) streamController.enqueue(encoder.encode(`data: ${redactSecrets(JSON.stringify(event))}\n\n`)); streamController.close(); }
        catch { streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", code: "STREAM_FAILED", message: "Streaming failed." })}\n\n`)); streamController.close(); }
      },
      cancel: () => controller.abort(),
    });
    return new Response(readable, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  };
}
