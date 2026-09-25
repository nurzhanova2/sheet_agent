import { BUILD_INFO, buildInfoLine } from "../app/build-info.js";
import { getAnalyticalTraces, renderTrace } from "../analytical-engine-v2/debug/analytical-trace.js";
import { turnLedger } from "../analytical-engine-v2/production/turn-ledger.js";
import { summarizeTimings, type ExecutionTimings } from "../analytical-engine-v2/production/execution-progress.js";
import { getResultActionTraces } from "../app/result-action-trace.js";
import type { AnalyticalConversationState } from "../analytical-engine-v2/state/conversation-state.js";
import type { SessionMemory } from "../app/session-memory.js";

/**
 * Stage 24.5.2 §1/§18 · Stage 28G §14 — the developer surface, in one place.
 *
 * Every `/debug…` form the task pane answers lives here and nowhere else.
 * That is the §18 invariant made structural: this module is the only thing
 * that can render owner reasons, planner decisions, result ids, freshness
 * tokens and raw traces, it is reached only by an exact `/debug…` match, and
 * nothing on the answer path imports it. None of these commands is
 * registered, so none appears in `/help`.
 */
export interface DebugConsoleSnapshot {
  readonly plannerTransportAvailable: boolean;
  readonly analyticalState: AnalyticalConversationState;
  readonly lastTurnTimings: ExecutionTimings | null;
  readonly memory: SessionMemory;
}

const NEWLINE = String.fromCharCode(10);

const ANALYTICAL_ENGINE_RE = /^\/debug[\s-]?analytical(?:[\s-]engine)?\s*$/i;
const CONTEXT_RE = /^\/debug(?:-context)?\s*$/i;

function analyticalEngineReport(snapshot: DebugConsoleSnapshot): string {
  const traces = getAnalyticalTraces();
  const ledger = turnLedger();
  const st = snapshot.analyticalState;
  return [
    "```",
    buildInfoLine(),
    "analytical engine: analytical_engine_v2",
    `planner transport: ${snapshot.plannerTransportAvailable ? "available" : "MISSING"}`,
    "",
    "TURN OWNERSHIP (most recent last)",
    ledger.length === 0
      ? "  (no turns yet)"
      : ledger
          .map(
            (e) =>
              `  ${e.owner === "V2_OWNED" ? "V2 " : "V1 "} ${e.ownerReason.padEnd(24)} engines=[${e.engines.join(", ") || "none"}] outcome=${e.outcome ?? "-"}  ${JSON.stringify(e.request).slice(0, 60)}`,
          )
          .join(NEWLINE),
    "",
    `V2 CONVERSATION STATE`,
    `  table: ${st.tableRef ? `${st.tableRef.sheetName}!${st.tableRef.sourceRange} @ ${st.tableRef.sourceVersion}` : "(none)"}`,
    `  suspended: ${st.suspended ? `"${st.suspended.question}" over ${st.suspended.results.length} result(s)` : "(none)"}`,
    `  recent: ${(st.recentResults ?? []).map((r) => `${r.tool}(${r.role ?? "primary"})`).join(", ") || "(none)"}`,
    "",
    "LAST TURN TIMING",
    ...(snapshot.lastTurnTimings ? summarizeTimings(snapshot.lastTurnTimings).map((line) => `  ${line}`) : ["  (no analytical turn yet)"]),
    "",
    `V2 TRACES (${traces.length}, most recent last)`,
    traces.length === 0 ? "  (none yet)" : traces.map((t) => renderTrace(t)).join(NEWLINE + NEWLINE),
    "```",
  ].join(NEWLINE);
}

function contextReport(snapshot: DebugConsoleSnapshot): string {
  const m = snapshot.memory;
  const traces = getResultActionTraces();
  const last = m.recentResults[m.recentResults.length - 1];
  return [
    "```",
    buildInfoLine(),
    `bundle build: ${BUILD_INFO.buildId}   commit: ${BUILD_INFO.gitCommit}`,
    "analytical engine: analytical_engine_v2",
    "",
    `memory: results=${m.recentResults.length} lastResultId=${m.lastResultId ?? "-"} ` +
      `lastRowSet=${m.lastRowSet?.id ?? "-"} lastChart=${m.lastChart?.id ?? "-"} ` +
      `pending=${m.pendingClarification?.kind ?? "-"}`,
    last
      ? `last result: kind=${last.kind} entityColumn=${last.entityColumn ?? "-"} ` +
        `entityValues=${(last.entityValues ?? []).length} source=${last.sourceRange}`
      : "last result: (none)",
    "",
    `result-action traces (${traces.length}):`,
    traces.length === 0 ? "  (none yet)" : traces.map((t) => "  " + JSON.stringify(t)).join(NEWLINE),
    "```",
  ].join(NEWLINE);
}

/** The report for this text, or `null` when it is not a debug command at all. */
export function renderDebugConsole(text: string, snapshot: DebugConsoleSnapshot): string | null {
  if (ANALYTICAL_ENGINE_RE.test(text)) return analyticalEngineReport(snapshot);
  if (CONTEXT_RE.test(text)) return contextReport(snapshot);
  return null;
}
