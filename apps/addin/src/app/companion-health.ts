export interface CompanionHealth {
  readonly reachable: boolean;
  readonly status?: string;
  readonly version?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly apiKeyConfigured?: boolean;
  readonly error?: string;
}

export interface HealthClient {
  check(signal?: AbortSignal): Promise<CompanionHealth>;
}

export class HttpHealthClient implements HealthClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async check(signal?: AbortSignal): Promise<CompanionHealth> {
    try {
      const init: RequestInit = signal ? { signal } : {};
      const response = await this.fetchImpl(`${this.baseUrl}/health`, init);
      if (!response.ok) return { reachable: false, error: `HTTP ${response.status}` };
      const body = (await response.json()) as Record<string, unknown>;
      return {
        reachable: true,
        ...(typeof body["status"] === "string" ? { status: body["status"] } : {}),
        ...(typeof body["version"] === "string" ? { version: body["version"] } : {}),
        ...(typeof body["model"] === "string" ? { model: body["model"] } : {}),
        ...(typeof body["provider"] === "string" ? { provider: body["provider"] } : {}),
        ...(typeof body["configured"] === "boolean" ? { apiKeyConfigured: body["configured"] } : {}),
      };
    } catch (error) {
      return { reachable: false, error: error instanceof Error ? error.message : "unreachable" };
    }
  }
}

export function createDefaultHealthClient(): HealthClient {
  return new HttpHealthClient(import.meta.env.VITE_API_BASE_URL ?? "https://localhost:47831");
}
