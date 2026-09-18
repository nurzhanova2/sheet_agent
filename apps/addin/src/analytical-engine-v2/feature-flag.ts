// ---------------------------------------------------------------------------
// Stage 26 §43/§67 and Stage 26.8 §9/§10/§45 — the migration switch.
//
// Through Stage 26.7 this defaulted OFF: the engine was built, tested and
// traceable, but production routing was untouched, so every Stage 24/25
// regression suite kept running against the path it was written for.
//
// Stage 26.8 is the activation stage, and §10 asks for V2 ON by default in the
// HUMAN TESTING RC. So the default flips, and the flag's real job changes: it
// is now the ROLLBACK (§45). Setting VITE_UNIFIED_ANALYTICAL_ENGINE_V2=false
// restores Stage 24/25 production behaviour exactly, with no code change — the
// installer and the manual-test guide both name that switch.
//
// There is still deliberately no "mixed" mode: a turn is owned by one engine or
// the other (§4), never handed from one to the other mid-flight (§11/§44).
// ---------------------------------------------------------------------------

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
