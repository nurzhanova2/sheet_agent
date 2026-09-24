// ---------------------------------------------------------------------------
// Stage 27.2A §2 — the iterative analytical loop.
//
// It defaults ON once the loop has live evidence behind it. Until §46's smoke
// run exists it defaults OFF: the one-shot path is the one with five
// benchmark series behind it, and an unproven loop should not be what a human
// tester meets first.
// ---------------------------------------------------------------------------

function readLoopFlag(): string | undefined {
  let value: string | undefined;
  try {
    value = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ANALYTICAL_AGENT_LOOP;
  } catch {
    value = undefined;
  }
  if (value !== undefined) return value;
  try {
    return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.["VITE_ANALYTICAL_AGENT_LOOP"];
  } catch {
    return undefined;
  }
}

export function analyticalAgentLoopEnabled(): boolean {
  const raw = readLoopFlag();
  if (raw === undefined) return false;
  return raw !== "false" && raw !== "0";
}

/** Shown in the build identity. */
export function analyticalAgentLoopFlagSource(): string {
  const raw = readLoopFlag();
  return raw === undefined ? "default(off)" : `VITE_ANALYTICAL_AGENT_LOOP=${raw}`;
}
