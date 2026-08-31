export type CustomFunctionName = "AI" | "AI.SUMMARIZE" | "AI.CLASSIFY" | "AI.EXTRACT" | "AI.TRANSLATE" | "AI.CLEAN";
export interface CustomFunctionRequest { readonly functionName: CustomFunctionName; readonly input: string; readonly locale?: string; }
export interface CustomFunctionGateway { completeBatch(requests: readonly CustomFunctionRequest[], signal: AbortSignal): Promise<readonly string[]>; }
export interface CustomFunctionContext { readonly tenantId: string; readonly consent: boolean; readonly generation?: number; readonly locale?: string; readonly apiKey?: string; readonly signal?: AbortSignal; }
export interface CustomFunctionOptions { readonly batchSize?: number; readonly debounceMs?: number; readonly maxConcurrency?: number; readonly cacheTtlMs?: number; readonly maxRequestsPerTenant?: number; readonly contractVersion?: string; }

interface Pending { readonly request: CustomFunctionRequest; readonly context: CustomFunctionContext; readonly resolve: (value: string) => void; }
interface CacheEntry { readonly value: string; readonly expiresAt: number; }

export class CustomFunctionService {
  readonly #options: Required<CustomFunctionOptions>;
  readonly #pending: Pending[] = [];
  readonly #cache = new Map<string, CacheEntry>();
  readonly #usage = new Map<string, { count: number; resetAt: number }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active = 0;
  constructor(private readonly gateway: CustomFunctionGateway, options: CustomFunctionOptions = {}) { this.#options = { batchSize: 50, debounceMs: 20, maxConcurrency: 2, cacheTtlMs: 300_000, maxRequestsPerTenant: 1_000, contractVersion: "v1", ...options }; }

  evaluate(functionName: CustomFunctionName, input: string, context: CustomFunctionContext): Promise<string> {
    if (context.signal?.aborted) return Promise.resolve("#CANCELLED!");
    if (context.apiKey) return Promise.resolve("#INVALID!");
    if (!context.consent) return Promise.resolve("#CONSENT!");
    const usage = this.#usage.get(context.tenantId); const now = Date.now();
    if (!usage || usage.resetAt <= now) this.#usage.set(context.tenantId, { count: 1, resetAt: now + 60_000 });
    else if (usage.count >= this.#options.maxRequestsPerTenant) return Promise.resolve("#QUOTA!");
    else usage.count += 1;
    const request: CustomFunctionRequest = { functionName, input: input.slice(0, 8_000), ...(context.locale ? { locale: context.locale } : {}) };
    const key = `${this.#options.contractVersion}:${context.tenantId}:${functionName}:${context.locale ?? "default"}:${input}`;
    const cached = this.#cache.get(key); if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);
    if (cached) this.#cache.delete(key);
    return new Promise((resolve) => { this.#pending.push({ request, context, resolve }); this.schedule(); });
  }

  clearCache(): void { this.#cache.clear(); }
  private schedule(): void { if (this.#timer || this.#active >= this.#options.maxConcurrency) return; this.#timer = setTimeout(() => { this.#timer = undefined; void this.flush(); }, this.#options.debounceMs); }
  private async flush(): Promise<void> {
    if (!this.#pending.length || this.#active >= this.#options.maxConcurrency) { if (this.#pending.length) this.schedule(); return; }
    this.#active += 1; const batch = this.#pending.splice(0, this.#options.batchSize); const controller = new AbortController();
    try {
      const results = await this.gateway.completeBatch(batch.map((item) => item.request), controller.signal);
      batch.forEach((item, index) => { const result = results[index]; const currentGeneration = batch.filter((candidate) => candidate.context.tenantId === item.context.tenantId).reduce((max, candidate) => Math.max(max, candidate.context.generation ?? 0), 0); const value = item.context.signal?.aborted ? "#CANCELLED!" : item.context.generation !== undefined && item.context.generation < currentGeneration ? "#STALE!" : result ?? "#AI!"; if (value !== "#STALE!" && value !== "#CANCELLED!") { const key = `${this.#options.contractVersion}:${item.context.tenantId}:${item.request.functionName}:${item.request.locale ?? "default"}:${item.request.input}`; this.#cache.set(key, { value, expiresAt: Date.now() + this.#options.cacheTtlMs }); } item.resolve(value); });
    } catch { batch.forEach((item) => item.resolve(item.context.signal?.aborted ? "#CANCELLED!" : "#AI!")); } finally { this.#active -= 1; if (this.#pending.length) this.schedule(); }
  }
}

export class HttpCustomFunctionGateway implements CustomFunctionGateway {
  constructor(private readonly endpoint: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async completeBatch(requests: readonly CustomFunctionRequest[], signal: AbortSignal): Promise<readonly string[]> {
    const response = await this.fetchImpl(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }), signal });
    if (!response.ok) throw new Error(`custom-functions HTTP ${response.status}`);
    const payload = await response.json() as { results?: unknown };
    if (!Array.isArray(payload.results) || payload.results.some((value) => typeof value !== "string")) throw new Error("invalid custom-functions response");
    return payload.results as string[];
  }
}

declare const CustomFunctions: { associate(name: string, handler: (input: string) => Promise<string>): void } | undefined;
export function registerCustomFunctions(service: CustomFunctionService): void {
  if (typeof CustomFunctions === "undefined") return;
  for (const name of ["AI", "AI.SUMMARIZE", "AI.CLASSIFY", "AI.EXTRACT", "AI.TRANSLATE", "AI.CLEAN"] as const) CustomFunctions.associate(name, (input: string) => service.evaluate(name, input, { tenantId: "default", consent: true }));
}
