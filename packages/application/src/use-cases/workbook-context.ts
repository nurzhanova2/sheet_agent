import type { ExcelPort, SelectionInfo } from "../ports/excel-port.js";

export interface WorkbookContext {
  readonly selection: Omit<SelectionInfo, "revision" | "sheetName">;
  readonly sheetName: string;
}

export async function stableWorkbookId(sourceIdentity: string, tenantScope: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${tenantScope}\u0000${sourceIdentity}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `wb_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
}

export class WorkbookContextManager {
  readonly #listeners = new Set<(context: WorkbookContext) => void>();
  readonly #debounceMs: number;
  #unsubscribe?: () => void;
  #timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly excel: ExcelPort, options: { readonly debounceMs?: number } = {}) {
    this.#debounceMs = options.debounceMs ?? 100;
  }

  subscribe(listener: (context: WorkbookContext) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.publish(await this.excel.getSelection());
    this.#unsubscribe = this.excel.onSelectionChanged((selection) => {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.publish(selection), this.#debounceMs);
    });
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#unsubscribe?.();
    this.#listeners.clear();
  }

  private publish(selection: SelectionInfo): void {
    const context: WorkbookContext = {
      selection: { address: selection.address, rowCount: selection.rowCount, columnCount: selection.columnCount },
      sheetName: selection.sheetName,
    };
    for (const listener of this.#listeners) listener(context);
  }
}
