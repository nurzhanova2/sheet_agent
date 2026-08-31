import { describe, expect, it, vi } from "vitest";
import { CustomFunctionService, type CustomFunctionGateway, type CustomFunctionRequest } from "./service.js";

describe("AI Custom Functions", () => {
  it("batches fill-down requests and never accepts API keys as arguments", async () => {
    const gateway: CustomFunctionGateway = { completeBatch: vi.fn(async (requests: readonly CustomFunctionRequest[]) => requests.map((request) => `answer:${request.input}`)) };
    const service = new CustomFunctionService(gateway, { batchSize: 25, debounceMs: 0 });
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => service.evaluate("AI.SUMMARIZE", `row-${index}`, { tenantId: "t", consent: true })));
    expect(results).toHaveLength(100);
    expect(gateway.completeBatch).toHaveBeenCalledTimes(4);
    await expect(service.evaluate("AI", "hello", { tenantId: "t", consent: true, apiKey: "sk-secret" })).resolves.toBe("#INVALID!");
  });

  it("uses versioned TTL cache and can clear it", async () => {
    const gateway: CustomFunctionGateway = { completeBatch: vi.fn(async (requests) => requests.map(() => "cached")) };
    const service = new CustomFunctionService(gateway, { debounceMs: 0, cacheTtlMs: 10_000 });
    await service.evaluate("AI", "same", { tenantId: "t", consent: true });
    await service.evaluate("AI", "same", { tenantId: "t", consent: true });
    expect(gateway.completeBatch).toHaveBeenCalledTimes(1);
    service.clearCache();
    await service.evaluate("AI", "same", { tenantId: "t", consent: true });
    expect(gateway.completeBatch).toHaveBeenCalledTimes(2);
  });

  it("returns deterministic consent/quota/provider statuses", async () => {
    const gateway: CustomFunctionGateway = { completeBatch: vi.fn(async () => { throw new Error("provider down"); }) };
    const service = new CustomFunctionService(gateway, { debounceMs: 0, maxRequestsPerTenant: 1 });
    await expect(service.evaluate("AI", "x", { tenantId: "disabled", consent: false })).resolves.toBe("#CONSENT!");
    await expect(service.evaluate("AI", "x", { tenantId: "t", consent: true })).resolves.toBe("#AI!");
    await expect(service.evaluate("AI", "y", { tenantId: "t", consent: true })).resolves.toBe("#QUOTA!");
  });

  it("does not return stale results after recalculation generation changes", async () => {
    let resolve!: (values: readonly string[]) => void;
    const gateway: CustomFunctionGateway = { completeBatch: vi.fn(() => new Promise<readonly string[]>((r) => { resolve = r; })) };
    const service = new CustomFunctionService(gateway, { debounceMs: 0 });
    const first = service.evaluate("AI", "old", { tenantId: "t", consent: true, generation: 1 });
    const second = service.evaluate("AI", "new", { tenantId: "t", consent: true, generation: 2 });
    await new Promise((resolveBatch) => setTimeout(resolveBatch, 0));
    resolve(["old-answer", "new-answer"]);
    await expect(first).resolves.toBe("#STALE!");
    await expect(second).resolves.toBe("new-answer");
  });

  it("returns a deterministic cancellation status", async () => {
    const gateway: CustomFunctionGateway = { completeBatch: vi.fn(async () => ["late"]) };
    const service = new CustomFunctionService(gateway, { debounceMs: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(service.evaluate("AI", "cancelled", { tenantId: "t", consent: true, signal: controller.signal })).resolves.toBe("#CANCELLED!");
  });
});
