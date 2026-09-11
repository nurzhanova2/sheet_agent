import { describe, expect, it } from "vitest";
import { parseBankLlmConfig } from "./bank-provider.js";

describe("bank LiteLLM configuration", () => {
  it("parses the approved Qwen deployment", () => {
    const config = parseBankLlmConfig({ BANK_AI_PROVIDER: "litellm", LLM_API_KEY: "secret", LLM_API_BASE: "https://prod-litellm.nationalbank.kz", LLM_MODEL: "Qwen/Qwen3.5-35B-A3B-FP8" });
    expect(config.model).toBe("Qwen/Qwen3.5-35B-A3B-FP8");
  });
  it("rejects missing keys and non-HTTPS gateways", () => {
    expect(() => parseBankLlmConfig({ BANK_AI_PROVIDER: "litellm", LLM_API_BASE: "https://x", LLM_MODEL: "x" })).toThrow("LLM_API_KEY");
    expect(() => parseBankLlmConfig({ BANK_AI_PROVIDER: "litellm", LLM_API_KEY: "x", LLM_API_BASE: "http://x", LLM_MODEL: "x" })).toThrow("HTTPS");
  });
});
