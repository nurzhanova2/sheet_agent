import { describe, expect, it, vi } from "vitest";
import { createServerApplication } from "./application.js";

const env = { BANK_AI_PROVIDER: "litellm", LLM_API_KEY: "secret", LLM_API_BASE: "https://litellm.test", LLM_MODEL: "Qwen/test" };
describe("server application", () => {
  it("exposes authless health without revealing credentials", async () => {
    const app = createServerApplication(env, vi.fn());
    const response = await app(new Request("https://localhost/health"));
    const text = await response.text(); expect(text).toContain("Qwen/test"); expect(text).not.toContain("secret");
  });
});
