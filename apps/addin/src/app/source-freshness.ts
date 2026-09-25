import type { CellValue, ExcelPort } from "@sheet-agent/application";
import { readAddressSnapshot } from "./workbook-context.js";

export type FreshnessVerdict = "fresh" | "changed" | "unverifiable";

/** Order-sensitive, collision-tolerant checksum of a bounded value grid. */
export function gridChecksum(values: readonly (readonly CellValue[])[]): string {
  let h = 2166136261 >>> 0;
  const text = JSON.stringify(values).slice(0, 20000);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

export interface SourceLike {
  readonly totalRowCount: number;
  readonly totalColumnCount: number;
  readonly address: string;
  readonly values: readonly (readonly CellValue[])[];
}

/** `<rows>x<cols>@<address>#<checksum>` — stored on ResultRef / RowSetRef. */
export function sourceVersionOf(snapshot: SourceLike): string {
  return `${snapshot.totalRowCount}x${snapshot.totalColumnCount}@${snapshot.address}#${gridChecksum(snapshot.values)}`;
}

/**
 * Re-reads `sourceRange` and compares it to `expectedVersion`. `unverifiable`
 * when the range cannot be read (missing sheet, error) — the caller treats that
 * as unsafe for a row-index-dependent mutation.
 */
export async function revalidateSource(
  port: ExcelPort,
  sourceRange: string,
  expectedVersion: string,
): Promise<FreshnessVerdict> {
  if (!sourceRange || !expectedVersion) return "unverifiable";
  try {
    const snap = await readAddressSnapshot(port, sourceRange);
    return sourceVersionOf(snap) === expectedVersion ? "fresh" : "changed";
  } catch {
    return "unverifiable";
  }
}

/**
 * Stage 24.4.4 — re-validates MULTIPLE source ranges (an agent result derived
 * from more than one worksheet). `fresh` only when every entry is fresh; any
 * `changed` ⇒ `changed`; otherwise `unverifiable`.
 */
export async function revalidateSources(
  port: ExcelPort,
  sources: readonly { readonly sourceRange: string; readonly version: string }[],
): Promise<FreshnessVerdict> {
  if (sources.length === 0) return "unverifiable";
  const verdicts = await Promise.all(sources.map((s) => revalidateSource(port, s.sourceRange, s.version)));
  if (verdicts.some((v) => v === "changed")) return "changed";
  return verdicts.every((v) => v === "fresh") ? "fresh" : "unverifiable";
}
