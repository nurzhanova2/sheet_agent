import { describe, expect, it } from "vitest";
import { createCustomFunctionsApi } from "./custom-functions-api.js";

describe("custom functions API", () => {
  it("maps a bounded batch to normalized model results", async () => {
    const api = createCustomFunctionsApi({ model: "Qwen/test", gateway: { stream: async function* () { yield { type: "delta" as const, text: "summary" }; yield { type: "done" as const }; } } });
    const response = await api(new Request("https://localhost/v1/custom-functions", { method: "POST", body: JSON.stringify({ requests: [{ functionName: "AI.SUMMARIZE", input: "long text" }] }) }));
    expect(await response.json()).toEqual({ results: ["summary"] });
  });
  it("rejects oversized batches before provider access", async () => {
    const api = createCustomFunctionsApi({ model: "x", maxBatchSize: 1, gateway: { stream: async function* () { yield { type: "done" as const }; } } });
    const response = await api(new Request("https://localhost/v1/custom-functions", { method: "POST", body: JSON.stringify({ requests: [{ functionName: "AI", input: "a" }, { functionName: "AI", input: "b" }] }) }));
    expect(response.status).toBe(400);
  });
});
