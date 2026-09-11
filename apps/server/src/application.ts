import { createChatApi } from "./api/chat-api.js";
import { createCustomFunctionsApi } from "./api/custom-functions-api.js";
import { createBankLlmGateway, parseBankLlmConfig } from "./llm/bank-provider.js";

export function createServerApplication(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch) {
  const config = parseBankLlmConfig(env); const gateway = createBankLlmGateway(config, fetchImpl);
  const chat = createChatApi({ authMode: "none", verifyToken: async () => undefined, gateway });
  const customFunctions = createCustomFunctionsApi({ gateway, model: config.model });
  return (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Promise.resolve(Response.json({ status: "ok", provider: config.provider, model: config.model }));
    if (path === "/v1/chat") return chat(request);
    if (path === "/v1/custom-functions") return customFunctions(request);
    return Promise.resolve(Response.json({ error: "NOT_FOUND" }, { status: 404 }));
  };
}
