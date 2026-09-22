// ---------------------------------------------------------------------------
// Stage 25 §106 — feature flag for the LLM analytical planner.
//
// Defaults ON (the planner is the point of this stage) but stays a single
// switch so a manual-test regression can roll back to the Stage 24.x
// deterministic-only routing without a code change (§105 Phase A/B).
// ---------------------------------------------------------------------------

export function analyticalPlannerEnabled(): boolean {
  try {
    const raw = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ANALYTICAL_PLANNER_V1;
    if (raw === undefined) return true;
    return raw !== "false" && raw !== "0";
  } catch {
    return true;
  }
}
