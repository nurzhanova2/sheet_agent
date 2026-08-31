const KEY = "sheet-agent.qwen.api-key";

/** Local-only key storage for the authless Windows add-in mode. Never includes the key in workbook formulas or telemetry. */
export class QwenApiKeyStore {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = window.localStorage) {}
  get(): string | undefined { return this.storage.getItem(KEY) ?? undefined; }
  set(apiKey: string): void { if (!apiKey.trim()) throw new Error("Qwen API key is required"); this.storage.setItem(KEY, apiKey.trim()); }
  clear(): void { this.storage.removeItem(KEY); }
}
