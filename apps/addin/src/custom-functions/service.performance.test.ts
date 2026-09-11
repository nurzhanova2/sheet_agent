import { describe, expect, it } from "vitest";
import { CustomFunctionService, type CustomFunctionGateway, type CustomFunctionRequest } from "./service.js";

describe("mocked custom-function scale", () => {
  for (const count of [1, 100, 1000]) it(`processes ${count} functions with bounded batching`, async () => {
    let calls = 0; let active = 0; let peakConcurrency = 0; let requestsSeen = 0;
    const gateway: CustomFunctionGateway = { completeBatch: async (requests: readonly CustomFunctionRequest[]) => {
      calls += 1; requestsSeen += requests.length; active += 1; peakConcurrency = Math.max(peakConcurrency, active);
      await new Promise((resolve) => setTimeout(resolve, 1)); active -= 1;
      return requests.map((request) => `mock:${request.input}`);
    } };
    const service = new CustomFunctionService(gateway, { batchSize: 50, debounceMs: 0, maxConcurrency: 2, maxRequestsPerTenant: 2000, cacheTtlMs: 0 });
    const runtime = (globalThis as typeof globalThis & { process?: { memoryUsage(): { heapUsed: number } } }).process;
    const memoryBefore = runtime?.memoryUsage().heapUsed ?? 0;
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: count }, (_, index) => service.evaluate("AI.SUMMARIZE", `unique-${index}`, { tenantId: "performance", consent: true })));
    const elapsedMs = performance.now() - started;
    const heapDeltaBytes = (runtime?.memoryUsage().heapUsed ?? memoryBefore) - memoryBefore;
    console.info(JSON.stringify({ fixture: "custom-functions-mock", count, elapsedMs: Number(elapsedMs.toFixed(2)), throughputPerSecond: Number((count / (elapsedMs / 1000)).toFixed(2)), providerCalls: calls, requestsSeen, peakConcurrency, heapDeltaBytes }));
    expect(results).toHaveLength(count); expect(results.every((value) => value.startsWith("mock:"))).toBe(true);
    expect(calls).toBe(Math.ceil(count / 50)); expect(requestsSeen).toBe(count); expect(peakConcurrency).toBeLessThanOrEqual(2);
  });

  it("cancels before provider traffic", async () => {
    const gateway: CustomFunctionGateway = { completeBatch: async () => { throw new Error("must not run"); } };
    const service = new CustomFunctionService(gateway, { debounceMs: 0 }); const controller = new AbortController(); controller.abort();
    await expect(service.evaluate("AI", "cancel", { tenantId: "performance", consent: true, signal: controller.signal })).resolves.toBe("#CANCELLED!");
  });
});
