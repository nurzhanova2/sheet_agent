import { redactSecrets } from "./index.js";

export interface TenantPolicy {
  readonly tenantId: string;
  readonly allowedProviders: readonly string[];
  readonly allowedModels: readonly string[];
  readonly egressEnabled: boolean;
  readonly mcpEnabled: boolean;
  readonly localAiEnabled: boolean;
  readonly retentionDays: number;
}

export class TenantPolicyEngine {
  readonly #policies = new Map<string, TenantPolicy>();
  upsert(policy: TenantPolicy): void { if (!policy.tenantId || policy.retentionDays < 0) throw new Error("Invalid tenant policy"); this.#policies.set(policy.tenantId, policy); }
  get(tenantId: string): TenantPolicy | undefined { return this.#policies.get(tenantId); }
  assertProvider(tenantId: string, provider: string, model: string): void { const policy = this.#policies.get(tenantId); if (!policy || !policy.egressEnabled) throw new Error("Tenant egress disabled"); if (!policy.allowedProviders.includes(provider)) throw new Error("Provider not allowed"); if (!policy.allowedModels.includes(model)) throw new Error("Model not allowed"); }
  assertMcp(tenantId: string): void { const policy = this.#policies.get(tenantId); if (!policy?.mcpEnabled) throw new Error("MCP disabled by tenant policy"); }
  disableEgress(tenantId: string): void { const policy = this.#policies.get(tenantId); if (policy) this.#policies.set(tenantId, { ...policy, egressEnabled: false, mcpEnabled: false, localAiEnabled: false }); }
}

export interface AuditEvent { readonly id: string; readonly tenantId: string; readonly actorId: string; readonly action: string; readonly outcome: "allowed" | "denied" | "error"; readonly timestamp: string; readonly metadata?: Readonly<Record<string, string | number | boolean>>; }
export interface AuditSink { append(event: AuditEvent): Promise<void>; }
export class AuditLogger {
  constructor(private readonly sink: AuditSink) {}
  async log(input: Omit<AuditEvent, "id" | "timestamp">): Promise<void> { await this.sink.append({ ...input, id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...(input.metadata ? { metadata: Object.fromEntries(Object.entries(input.metadata).map(([key, value]) => [key, typeof value === "string" ? redactSecrets(value) : value])) } : {}) }); }
}

export interface RetainedRecord { readonly id: string; readonly tenantId: string; readonly createdAt: number; readonly value: unknown; }
export class DataLifecycleStore {
  readonly #records = new Map<string, RetainedRecord>();
  put(record: RetainedRecord): void { this.#records.set(record.id, record); }
  purgeExpired(now = Date.now(), retentionDays = 30): number { const cutoff = now - retentionDays * 86_400_000; let removed = 0; for (const [id, record] of this.#records) if (record.createdAt < cutoff) { this.#records.delete(id); removed += 1; } return removed; }
  deleteTenant(tenantId: string): number { let removed = 0; for (const [id, record] of this.#records) if (record.tenantId === tenantId) { this.#records.delete(id); removed += 1; } return removed; }
  exportTenant(tenantId: string): readonly RetainedRecord[] { return [...this.#records.values()].filter((record) => record.tenantId === tenantId); }
}

const INJECTION_PATTERNS = [/ignore\s+(?:all\s+)?previous\s+instructions/i, /reveal\s+(?:the\s+)?system\s+prompt/i, /disable\s+(?:your\s+)?safety/i, /execute\s+(?:this\s+)?shell/i];
export function detectPromptInjection(text: string): boolean { return INJECTION_PATTERNS.some((pattern) => pattern.test(text)); }
export function guardExternalText(text: string): string { if (detectPromptInjection(text)) throw new Error("Prompt injection detected"); return text.slice(0, 50_000); }
