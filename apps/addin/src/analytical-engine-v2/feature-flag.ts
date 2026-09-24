/**
 * Read from the bundle's own env first, then the process env.
 *
 * The second source is not a fallback for the browser — `process` does not
 * exist there and the try/catch swallows it. It is how the flag is set for the
 * §62 production-path live suite and the Stage 26.8 rollback test, both of which
 * run under Node, where `import.meta.env` is fixed at config time.
 */
function readFlag(): string | undefined {
  let value: string | undefined;
  try {
    value = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_UNIFIED_ANALYTICAL_ENGINE_V2;
  } catch {
    value = undefined;
  }
  if (value !== undefined) return value;
  try {
    return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.["VITE_UNIFIED_ANALYTICAL_ENGINE_V2"];
  } catch {
    return undefined;
  }
}

export function unifiedAnalyticalEngineV2Enabled(): boolean {
  const raw = readFlag();
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

/** §54 — shown in the build identity so a tester can see which engine they are testing. */
export function unifiedAnalyticalEngineV2FlagSource(): string {
  const raw = readFlag();
  return raw === undefined ? "default" : `VITE_UNIFIED_ANALYTICAL_ENGINE_V2=${raw}`;
}

// ---------------------------------------------------------------------------
// Stage 27.2A §2 — the iterative analytical loop.
//
// A SEPARATE switch from the engine flag above, and separate on purpose. The
// engine flag chooses between two whole architectures that were each tested
// end to end; this one chooses how the sandbox is DRIVEN inside the V2 engine,
// and the two failure modes have nothing to do with each other. Folding them
// together would mean a rollback of the loop also rolled back Stage 26.
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

/** Shown in the build identity beside the engine flag. */
export function analyticalAgentLoopFlagSource(): string {
  const raw = readLoopFlag();
  return raw === undefined ? "default(off)" : `VITE_ANALYTICAL_AGENT_LOOP=${raw}`;
}
