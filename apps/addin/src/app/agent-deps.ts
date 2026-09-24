import type { ExcelPort } from "@sheet-agent/application";
import type {
  AgentLanguage,
  AgentToolDeps,
  ChartBuildResult,
  SheetSnapshotResult,
} from "../agent/types.js";
import { runAnalysisBatch } from "../analysis/index.js";
import type { AnalysisRequest } from "../analysis/types.js";
import { splitSheetAddress } from "./a1.js";
import { buildWorkbookMap, type WorkbookMap } from "./commands/workbook-map.js";
import { resolveSheet } from "./commands/workbook-resolver.js";
import { resultToChartData } from "./result-to-chart.js";
import type { ResultRef } from "./session-memory.js";
import { readAddressSnapshot } from "./workbook-context.js";

export interface ProductionAgentDepsOptions {
  readonly language?: AgentLanguage;
}

/**
 * Builds an {@link AgentToolDeps} bound to `port`. The Workbook Map is built at
 * most once per task (memoised); every sheet reference is resolved through the
 * deterministic resolver and every read goes through `readAddressSnapshot`, so
 * the agent can never name an unresolved sheet or read an unbounded range.
 */
export function createProductionAgentDeps(port: ExcelPort, options: ProductionAgentDepsOptions = {}): AgentToolDeps {
  const language: AgentLanguage = options.language ?? "en";
  let mapPromise: Promise<WorkbookMap | { readonly error: string }> | null = null;

  const workbookMap = (): Promise<WorkbookMap | { readonly error: string }> => {
    if (!mapPromise) {
      mapPromise = buildWorkbookMap(port).catch((error) => ({
        error: error instanceof Error ? error.message : "could not read the workbook structure",
      }));
    }
    return mapPromise;
  };

  const snapshotForSheet = async (reference: string): Promise<SheetSnapshotResult> => {
    const map = await workbookMap();
    if ("error" in map) return { kind: "error", error: map.error };
    const resolved = resolveSheet(map, reference);
    if (resolved.kind === "ambiguous") return { kind: "ambiguous", candidates: resolved.candidates };
    if (resolved.kind !== "ok") return { kind: "not_found", reference };
    if (!resolved.sheet.usedAddress) return { kind: "error", error: `worksheet "${resolved.sheet.name}" is empty` };
    try {
      const snapshot = await readAddressSnapshot(port, resolved.sheet.usedAddress);
      return { kind: "ok", snapshot };
    } catch (error) {
      return { kind: "error", error: error instanceof Error ? error.message : `could not read "${resolved.sheet.name}"` };
    }
  };

  return {
    workbookMap,
    sheetSnapshot: snapshotForSheet,
    rangeSnapshot: async (address): Promise<SheetSnapshotResult> => {
      const { sheetName } = splitSheetAddress(address);
      if (!sheetName) return { kind: "not_found", reference: address };
      // Resolve the sheet name first so the agent cannot read a sheet the map
      // does not know about, then read exactly the requested address.
      const map = await workbookMap();
      if ("error" in map) return { kind: "error", error: map.error };
      const resolved = resolveSheet(map, sheetName, { strict: true });
      if (resolved.kind === "ambiguous") return { kind: "ambiguous", candidates: resolved.candidates };
      if (resolved.kind !== "ok") return { kind: "not_found", reference: sheetName };
      try {
        const snapshot = await readAddressSnapshot(port, address);
        return { kind: "ok", snapshot };
      } catch (error) {
        return { kind: "error", error: error instanceof Error ? error.message : `could not read ${address}` };
      }
    },
    analyze: (snapshot, request: AnalysisRequest) => runAnalysisBatch(snapshot, [request], 0, language),
    chartFromResult: (ref, lang, columns): ChartBuildResult => {
      const shim = {
        columns: ref.columns,
        rows: ref.rows,
        title: ref.title,
        sourceRange: "agent-result",
        rowsTruncated: false,
      } as unknown as ResultRef;
      return resultToChartData(shim, lang, columns);
    },
  };
}
