import { LlmGateway, QwenProvider } from "@sheet-agent/llm";

export interface BankLlmConfig {
  readonly provider: "litellm";
  readonly apiKey: string;
  readonly apiBase: URL;
  readonly model: string;
}

export function parseBankLlmConfig(input: Record<string, string | undefined>): BankLlmConfig {
  if (input["BANK_AI_PROVIDER"] !== "litellm") throw new Error("BANK_AI_PROVIDER must be litellm");
  const apiKey = input["LLM_API_KEY"]?.trim();
  if (!apiKey) throw new Error("LLM_API_KEY is required");
  const apiBase = new URL(input["LLM_API_BASE"] ?? "");
  if (apiBase.protocol !== "https:") throw new Error("LLM_API_BASE must use HTTPS");
  const model = input["LLM_MODEL"]?.trim();
  if (!model) throw new Error("LLM_MODEL is required");
  return { provider: "litellm", apiKey, apiBase, model };
}

export function createBankLlmGateway(config: BankLlmConfig, fetchImpl: typeof fetch = fetch): LlmGateway {
  const endpoint = new URL("v1/chat/completions", config.apiBase.toString().replace(/\/?$/, "/")).toString();
  const provider = new QwenProvider({ apiKey: config.apiKey, endpoint, fetchImpl });
  return new LlmGateway({ providers: { litellm: provider }, defaultProvider: "litellm", allowedProviders: ["litellm"] });
}
