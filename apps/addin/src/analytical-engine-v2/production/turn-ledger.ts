// ---------------------------------------------------------------------------
// Stage 26.8 §19/§43/§44 — one turn, one analytical owner, and the evidence.
//
// §44 wants a hard failure when both V2 and a legacy analytical route execute
// the same user turn. That is only checkable if every analytical route SAYS it
// ran, so each one calls `recordAnalyticalExecution` on entry — the V2 engine
// and the five Stage 24/25 routes alike. The ledger then holds the answer to
// "who analysed this turn?", which is also exactly what §19's debug surface
// needs to show.
//
// Module state, deliberately: it is per-turn diagnostic bookkeeping for one
// task pane, not application state, and threading it through twelve call sites
// would be worse than a ring buffer nobody else reads.
// ---------------------------------------------------------------------------

import type { OwnershipReason, TurnOwner } from "./turn-owner.js";

/** Every route that can produce an analytical answer. §3's audit, as a type. */
export type AnalyticalEngine =
  | "analytical_engine_v2"
  | "stage24_compiler"
  | "stage24_schema"
  | "stage24_grouped_ranking"
  | "stage24_followup"
  | "stage24_agent"
  | "stage25_planner"
  | "flat_analyzer";

export interface TurnLedgerEntry {
  readonly turnId: string;
  readonly request: string;
  readonly at: string;
  readonly owner: TurnOwner;
  readonly ownerReason: OwnershipReason;
  /** Every analytical route that actually executed, in order. §44 allows one. */
  readonly engines: readonly AnalyticalEngine[];
  readonly outcome?: "answered" | "clarify" | "failed" | "non_analytical";
  /** §19 — the V2 trace id for this turn, when V2 owned it. */
  readonly v2TurnId?: string;
}

interface Mutable {
  turnId: string;
  request: string;
  at: string;
  owner: TurnOwner;
  ownerReason: OwnershipReason;
  engines: AnalyticalEngine[];
  outcome?: TurnLedgerEntry["outcome"];
  v2TurnId?: string;
}

const MAX_TURNS = 20;
const ledger: Mutable[] = [];
let current: Mutable | null = null;

export function beginTurn(turnId: string, request: string, owner: TurnOwner, ownerReason: OwnershipReason): void {
  current = { turnId, request, at: new Date().toISOString(), owner, ownerReason, engines: [] };
  ledger.push(current);
  while (ledger.length > MAX_TURNS) ledger.shift();
}

export function recordAnalyticalExecution(engine: AnalyticalEngine): void {
  if (!current) return;
  current.engines.push(engine);
}

export function finishTurn(outcome: TurnLedgerEntry["outcome"], v2TurnId?: string): void {
  if (!current) return;
  current.outcome = outcome;
  if (v2TurnId !== undefined) current.v2TurnId = v2TurnId;
}

/** §44 — the distinct analytical routes that executed the current turn. */
export function enginesThisTurn(): readonly AnalyticalEngine[] {
  return current ? [...new Set(current.engines)] : [];
}

function freeze(e: Mutable): TurnLedgerEntry {
  return {
    turnId: e.turnId,
    request: e.request,
    at: e.at,
    owner: e.owner,
    ownerReason: e.ownerReason,
    engines: [...e.engines],
    ...(e.outcome !== undefined ? { outcome: e.outcome } : {}),
    ...(e.v2TurnId !== undefined ? { v2TurnId: e.v2TurnId } : {}),
  };
}

export function turnLedger(): readonly TurnLedgerEntry[] {
  return ledger.map(freeze);
}

export function lastTurn(): TurnLedgerEntry | null {
  const e = ledger[ledger.length - 1];
  return e ? freeze(e) : null;
}

/** Tests only — the ring buffer is process-wide. */
export function resetTurnLedger(): void {
  ledger.length = 0;
  current = null;
}
