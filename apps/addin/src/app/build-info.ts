// ---------------------------------------------------------------------------
// Stage 24.5.2 §1/§18 — provable runtime build identity.
//
// Injected by Vite `define` at build time (see vite.config.ts). Surfaced through
// the `/debug-context` command and the session-memory debug view so a manual
// tester can verify WHICH taskpane bundle Excel Desktop is executing.
// ---------------------------------------------------------------------------

declare const __APP_VERSION__: string | undefined;
declare const __BUILD_ID__: string | undefined;
declare const __GIT_COMMIT__: string | undefined;

function readDefine(getter: () => string | undefined, fallback: string): string {
  try {
    const value = getter();
    return typeof value === "string" && value.length > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

export const STAGE = "24.5.2" as const;

export const BUILD_INFO = {
  appVersion: readDefine(() => __APP_VERSION__, "0.0.0-dev"),
  buildId: readDefine(() => __BUILD_ID__, "dev"),
  gitCommit: readDefine(() => __GIT_COMMIT__, "unknown"),
  stage: STAGE,
} as const;

/** One-line human identity, e.g. "Sheet Agent 0.2.0 · Stage 24.5.2 · build 2026-09-10T… · a1b2c3d4e5f6". */
export function buildInfoLine(): string {
  return `Sheet Agent ${BUILD_INFO.appVersion} · Stage ${BUILD_INFO.stage} · build ${BUILD_INFO.buildId} · ${BUILD_INFO.gitCommit}`;
}
