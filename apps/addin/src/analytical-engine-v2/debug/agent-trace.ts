/** How many turns of trace to keep. Small: this is a debugging aid, not a log. */
const MAX_TRACES = 10;

export interface AgentTraceEntry {
  readonly turnId: string;
  readonly request: string;
  readonly text: string;
  readonly at: number;
  readonly rounds: number;
  readonly codeExecutions: number;
  readonly executionErrors: number;
  readonly recovered: boolean;
}

const traces: AgentTraceEntry[] = [];

export function recordAgentTrace(entry: AgentTraceEntry): void {
  traces.push(entry);
  while (traces.length > MAX_TRACES) traces.shift();
}

export function getAgentTraces(): readonly AgentTraceEntry[] {
  return traces;
}

export function clearAgentTraces(): void {
  traces.length = 0;
}

/**
 * §26 — the recovery record across the traces held.
 *
 * The denominator is turns that CONTAINED an execution error, not all turns.
 * A session in which nothing broke has no recovery rate, and showing 100% for
 * it would be a number about nothing — so it reports `null` and the renderer
 * says so in words.
 */
export function selfRecoveryRate(entries: readonly AgentTraceEntry[] = traces): { readonly opportunities: number; readonly successes: number; readonly rate: number | null } {
  const opportunities = entries.filter((e) => e.executionErrors > 0);
  const successes = opportunities.filter((e) => e.recovered);
  return {
    opportunities: opportunities.length,
    successes: successes.length,
    rate: opportunities.length === 0 ? null : successes.length / opportunities.length,
  };
}

const NEWLINE = String.fromCharCode(10);

/** §36 — the block behind `/debug analytical-agent`. */
export function renderAgentTraces(entries: readonly AgentTraceEntry[] = traces): string {
  if (entries.length === 0) return "  (no iterative analysis has run in this session)";
  const recovery = selfRecoveryRate(entries);
  const header = [
    `SELF_RECOVERY_RATE: ${
      recovery.rate === null
        ? "n/a — no turn hit an execution error"
        : `${(recovery.rate * 100).toFixed(0)}% (${recovery.successes}/${recovery.opportunities})`
    }`,
    "",
  ];
  return [...header, ...entries.map((entry) => entry.text)].join(NEWLINE + NEWLINE);
}
