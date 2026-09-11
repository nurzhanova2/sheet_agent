import type { ChatRequest, StreamEvent } from "@sheet-agent/llm";
type CustomFunctionName = "AI" | "AI.SUMMARIZE" | "AI.CLASSIFY" | "AI.EXTRACT" | "AI.TRANSLATE" | "AI.CLEAN";
interface CustomFunctionRequest { readonly functionName: CustomFunctionName; readonly input: string; }

interface Gateway { stream(request: ChatRequest, context: { readonly correlationId: string; readonly signal: AbortSignal }): AsyncIterable<StreamEvent>; }

const instructions: Record<CustomFunctionName, string> = {
  AI: "Answer the request concisely.",
  "AI.SUMMARIZE": "Summarize the input concisely.",
  "AI.CLASSIFY": "Classify the input and return only the class.",
  "AI.EXTRACT": "Extract the requested information as compact JSON.",
  "AI.TRANSLATE": "Translate the input as requested.",
  "AI.CLEAN": "Clean and normalize the text without changing its meaning.",
};

export function createCustomFunctionsApi(options: { readonly gateway: Gateway; readonly model: string; readonly maxBatchSize?: number }) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
    let body: { requests?: readonly CustomFunctionRequest[] };
    try { body = await request.json() as { requests?: readonly CustomFunctionRequest[] }; } catch { return Response.json({ error: "INVALID_JSON" }, { status: 400 }); }
    if (!Array.isArray(body.requests) || body.requests.length === 0 || body.requests.length > (options.maxBatchSize ?? 50)) return Response.json({ error: "INVALID_BATCH" }, { status: 400 });
    const batch = body.requests as readonly CustomFunctionRequest[];
    const controller = new AbortController(); request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const results = await Promise.all(batch.map(async (item, index) => {
      if (!(item.functionName in instructions) || typeof item.input !== "string") return "#INVALID!";
      let output = "";
      const chat: ChatRequest = { model: options.model, stream: true, provider: "litellm", messages: [{ role: "system", content: instructions[item.functionName] }, { role: "user", content: item.input.slice(0, 8_000) }] };
      for await (const event of options.gateway.stream(chat, { correlationId: "cf-" + index, signal: controller.signal })) {
        if (event.type === "delta") output += event.text;
        if (event.type === "error") return "#AI!";
      }
      return output || "#AI!";
    }));
    return Response.json({ results });
  };
}



