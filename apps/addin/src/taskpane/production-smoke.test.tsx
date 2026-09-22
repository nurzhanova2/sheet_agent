// ---------------------------------------------------------------------------
// Stage 26.8 §42/§43/§47/§58/§62 — the PRODUCTION-PATH live smoke suite.
//
// Every turn here goes through `useAgent().submit()`: the real ownership
// decision, the real cascade, the real schema induction, the real V2 engine,
// the real tools, the real state commit — and the REAL model through the
// Companion (§47). Nothing about the planner is scripted.
//
// SKIPPED BY DEFAULT. It talks to the configured model:
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 \
//   SHEET_AGENT_LIVE_ENDPOINT=https://localhost:47831/v1/chat \
//   SHEET_AGENT_LIVE_MODEL="<model id>" \
//   SHEET_AGENT_SMOKE_JSON=<file> \
//   npx vitest run src/taskpane/production-smoke.test.tsx
//
// One accommodation, and only one: the fetch handed to HttpChatClient drops the
// AbortSignal. jsdom installs its own AbortController and undici refuses a
// foreign signal, so every call would fail in a millisecond without reaching
// the model. Stage 26.7's benchmark solved the same problem by running in the
// node environment; this suite cannot, because `renderHook` needs a DOM. What
// is given up is cancellation, which has its own scripted test (§21) — every
// other part of the path is the production one.
// ---------------------------------------------------------------------------

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import { HttpChatClient } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { fixtureBalanceLike, fixtureRecords, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";
import { unseenOperations, salesTestData } from "../app/schema/__fixtures__/manual-tables.js";
import { lastTurn, resetTurnLedger, turnLedger, type TurnLedgerEntry } from "../analytical-engine-v2/production/turn-ledger.js";
import { clearAnalyticalTraces, getAnalyticalTraces } from "../analytical-engine-v2/debug/analytical-trace.js";

const endpoint = process.env["SHEET_AGENT_LIVE_ENDPOINT"];
const model = process.env["SHEET_AGENT_LIVE_MODEL"];
const jsonFile = process.env["SHEET_AGENT_SMOKE_JSON"];
const live = Boolean(endpoint && model);

/** See the header: jsdom's AbortSignal cannot cross into undici. */
const fetchWithoutSignal: typeof fetch = (input, init) => {
  const next = { ...(init ?? {}) } as RequestInit;
  delete next.signal;
  return globalThis.fetch(input as RequestInfo, next);
};

function snapOf(fx: FixtureSnapshot) {
  const cols = fx.values.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    address: fx.address,
    sheetName: fx.sheetName,
    rowCount: fx.values.length,
    columnCount: cols,
    revision: 0,
    values: fx.values,
    formulas: fx.formulas,
    numberFormats: fx.numberFormats,
  };
}

function workbook(...tables: readonly FixtureSnapshot[]) {
  const snaps = tables.map(snapOf);
  let selected = 0;
  const port = {
    capabilities: { tables: true, charts: true, pivotTables: true, namedRanges: true },
    getSelection: vi.fn(async () => {
      const s = snaps[selected]!;
      return { address: s.address, sheetName: s.sheetName, rowCount: s.rowCount, columnCount: s.columnCount, revision: 0 };
    }),
    readRange: vi.fn(async (address: string) => snaps.find((s) => s.address === address) ?? snaps[selected]!),
    getWorkbookOverview: vi.fn(async () => ({
      sourceIdentity: "smoke",
      sheets: snaps.map((s) => ({ name: s.sheetName, usedAddress: s.address, rowCount: s.rowCount, columnCount: s.columnCount })),
      tables: [],
      namedRanges: [],
      charts: [],
      pivots: [],
    })),
    readTable: vi.fn(),
    search: vi.fn(async () => []),
    onSelectionChanged: vi.fn(() => () => undefined),
    writeRange: vi.fn(async () => undefined),
    readFillColors: vi.fn(async () => [["#FFFFFF"]]),
    writeFillColors: vi.fn(async () => undefined),
    addWorksheet: vi.fn(async () => undefined),
    deleteWorksheet: vi.fn(async () => undefined),
    insertImage: vi.fn(async () => ({ shapeName: "s", left: 0, top: 0, width: 10, height: 10 })),
    deleteShape: vi.fn(async () => undefined),
  } as unknown as ExcelPort & ExcelMutationPort;
  // The normal behaviour, restored whenever the selection moves: `driftToCell`
  // replaces both mocks, and without this every later `select()` was a no-op.
  const normal = (): void => {
    (port.getSelection as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const s = snaps[selected]!;
      return { address: s.address, sheetName: s.sheetName, rowCount: s.rowCount, columnCount: s.columnCount, revision: 0 };
    });
    (port.readRange as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (a: string) => snaps.find((x) => x.address === a) ?? snaps[selected]!);
  };
  return {
    port,
    select(i: number) {
      selected = i;
      normal();
    },
    driftToCell(address: string) {
      (port.getSelection as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        address,
        sheetName: snaps[selected]!.sheetName,
        rowCount: 1,
        columnCount: 1,
        revision: 0,
      }));
      (port.readRange as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (a: string) =>
        a === address
          ? { address, sheetName: snaps[selected]!.sheetName, rowCount: 1, columnCount: 1, revision: 0, values: [[1]], formulas: [[null]], numberFormats: [["General"]] }
          : (snaps.find((s) => s.address === a) ?? snaps[selected]!),
      );
    },
  };
}

type Expected = "V2_OWNED" | "NON_V2";

interface Step {
  readonly id: string;
  readonly text: string;
  /** §43 — the owner this turn MUST have. */
  readonly owner: Expected;
  /** Switch the selection before submitting. */
  readonly select?: number;
  readonly drift?: string;
  readonly reset?: boolean;
  readonly note?: string;
}

interface TurnRecord {
  readonly id: string;
  readonly text: string;
  readonly expectedOwner: Expected;
  readonly owner: string;
  readonly ownerReason: string;
  readonly engines: readonly string[];
  readonly outcome: string;
  readonly ownerCorrect: boolean;
  readonly doubleExecution: boolean;
  readonly elapsedMs: number;
  readonly answer: string;
  readonly plannerRounds: number | null;
  readonly toolCalls: number | null;
  readonly promptChars: number | null;
  readonly sourceRange: string | null;
  readonly narrator: string | null;
  readonly note?: string;
  readonly trace: unknown;
}

// §42's twelve cases, as ~30 turns over three tables (§39/§40/§41).
const SCRIPT: readonly Step[] = [
  // 1. simple analysis — Balance
  // §5 lists "describe data" among V2's capabilities, so this IS V2's.
  { id: "simple-1", text: "Что показывает эта таблица?", owner: "V2_OWNED", note: "§42.1 / §5 describe" },
  { id: "simple-2", text: "Какой показатель изменился сильнее всего за последний период?", owner: "V2_OWNED", note: "§42.1 simple analysis" },
  // 2. temporal comparison
  { id: "temporal-1", text: "Сравни первый и последний период по всем показателям.", owner: "V2_OWNED", note: "§42.2" },
  // 3. ranking
  { id: "rank-1", text: "Покажи три показателя с наибольшим ростом.", owner: "V2_OWNED", note: "§42.3" },
  // 4. multi-turn reference
  { id: "ref-1", text: "Покажи динамику того, который вырос сильнее всех.", owner: "V2_OWNED", note: "§42.4" },
  { id: "ref-2", text: "А за какой период он был минимальным?", owner: "V2_OWNED", note: "§42.4 second hop" },
  // selection drift — same table, one cell
  { id: "drift-1", text: "Повтори это ещё раз, пожалуйста.", owner: "V2_OWNED", drift: "DRIFT", note: "§15 selection drift" },
  // 5. compound analysis
  { id: "compound-1", text: "Найди показатель с наибольшим падением и покажи его значения по всем периодам.", owner: "V2_OWNED", select: 0, note: "§42.5" },
  // 9. general chat
  { id: "general-1", text: "Что такое волатильность в статистике?", owner: "NON_V2", note: "§42.9 / §7" },
  { id: "general-2", text: "Чем медиана отличается от среднего?", owner: "NON_V2", note: "§42.9 / §64" },
  // 10. slash command
  { id: "slash-1", text: "/sheets", owner: "NON_V2", note: "§42.10 / §38" },
  { id: "slash-2", text: "/workbook", owner: "NON_V2", note: "§42.10 / §38" },
  // 11. mutation preview
  { id: "mutate-1", text: "Выдели его красным.", owner: "NON_V2", note: "§42.11 / §36 — deterministic Preview" },
  // 7. table switch — an unseen table
  { id: "switch-1", text: "Какой показатель здесь вырос сильнее всего?", owner: "V2_OWNED", select: 1, note: "§42.7 / §16 / §41 unseen table" },
  { id: "switch-2", text: "Покажи его историю.", owner: "V2_OWNED", note: "§42.7 follow-up on the NEW table" },
  { id: "switch-3", text: "Что в этих данных выглядит необычно?", owner: "V2_OWNED", note: "§41 free-form on an unseen table" },
  // 6. clarification / resume
  { id: "clarify-1", text: "Отметь показатели, которые вышли за допустимый порог.", owner: "V2_OWNED", note: "§42.6 expected to clarify" },
  { id: "clarify-2", text: "20%", owner: "V2_OWNED", note: "§42.6 the reply must RESUME" },
  // new chat, then the records table (§39 sales-shaped)
  { id: "reset-1", text: "Какой показатель изменился сильнее всего?", owner: "V2_OWNED", reset: true, select: 1, note: "§13 fresh session" },
  { id: "sales-1", text: "Сколько всего продано?", owner: "NON_V2", select: 2, note: "§39 records table — Stage 24 owns flat records" },
  { id: "sales-2", text: "Какой регион дал наибольшую выручку?", owner: "NON_V2", note: "§39 records table" },
  // back to Balance for the remaining analytical turns
  { id: "back-1", text: "Какой показатель самый нестабильный?", owner: "V2_OWNED", select: 0, note: "volatility" },
  { id: "back-2", text: "А какой самый стабильный?", owner: "V2_OWNED", note: "polarity follow-up" },
  { id: "back-3", text: "Сравни эти два по последнему периоду.", owner: "V2_OWNED", note: "two-metric reference" },
  { id: "back-4", text: "Какие показатели снижались два периода подряд?", owner: "V2_OWNED", note: "temporal pattern" },
  { id: "back-5", text: "Из них выбери тот, что упал сильнее всего.", owner: "V2_OWNED", note: "§22/§23 narrowing" },
  { id: "back-6", text: "Show me the same thing for the first two periods.", owner: "V2_OWNED", note: "English follow-up" },
  { id: "back-7", text: "Насколько в среднем менялись показатели между периодами?", owner: "V2_OWNED", note: "aggregate over changes" },
  { id: "back-8", text: "Есть ли показатель, который менял направление?", owner: "V2_OWNED", note: "direction changes" },
  { id: "back-9", text: "Покажи его значения.", owner: "V2_OWNED", note: "pronoun on the previous winner" },
];

describe.skipIf(!live)("Stage 26.8 §42/§62 — production-path live smoke", () => {
  it(
    "drives the real taskpane route against the real model and reports what happened",
    async () => {
      resetTurnLedger();
      clearAnalyticalTraces();
      const client = new HttpChatClient(endpoint!, model!, fetchWithoutSignal);
      const wb = workbook(fixtureBalanceLike(), unseenOperations(), salesTestData(), fixtureRecords());
      const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

      const records: TurnRecord[] = [];
      for (const step of SCRIPT) {
        if (step.reset) {
          await act(async () => {
            result.current.reset();
          });
        }
        if (step.select !== undefined) wb.select(step.select);
        if (step.drift) wb.driftToCell(`${fixtureBalanceLike().sheetName}!B3`);

        const before = getAnalyticalTraces().length;
        const started = Date.now();
        await act(async () => {
          await result.current.submit(step.text);
        });
        const elapsedMs = Date.now() - started;

        const entry: TurnLedgerEntry = lastTurn()!;
        const traces = getAnalyticalTraces();
        const trace = traces.length > before ? traces.at(-1)! : null;
        const responses = result.current.entries.filter((e) => e.kind === "response");
        const answer = responses.at(-1)?.kind === "response" ? (responses.at(-1) as { text: string }).text : "";

        records.push({
          id: step.id,
          text: step.text,
          expectedOwner: step.owner,
          owner: entry.owner,
          ownerReason: entry.ownerReason,
          engines: entry.engines,
          outcome: entry.outcome ?? "-",
          ownerCorrect: entry.owner === step.owner,
          doubleExecution: new Set(entry.engines).size > 1,
          elapsedMs,
          answer,
          plannerRounds: trace?.budget?.plannerRounds ?? null,
          toolCalls: trace?.budget?.toolCalls ?? null,
          promptChars: null,
          sourceRange: trace?.sourceRange ?? null,
          narrator: trace?.narratorStatus ?? null,
          trace: trace ?? null,
          ...(step.note ? { note: step.note } : {}),
        });

        process.stderr.write(
          `  [${step.id}] ${entry.owner === "V2_OWNED" ? "V2" : "V1"}/${entry.ownerReason} ${entry.outcome ?? "-"} ` +
            `${entry.owner === step.owner ? "" : `OWNER MISMATCH (wanted ${step.owner}) `}${elapsedMs}ms\n`,
        );
      }

      const v2 = records.filter((r) => r.owner === "V2_OWNED");
      const answered = v2.filter((r) => r.outcome === "answered");
      const ownerCorrect = records.filter((r) => r.ownerCorrect);
      const lat = [...records.map((r) => r.elapsedMs)].sort((a, b) => a - b);
      const median = lat[Math.floor(lat.length / 2)] ?? 0;
      process.stderr.write(
        `\n  turns ${records.length} | routing ${ownerCorrect.length}/${records.length} | ` +
          `V2 ${v2.length} answered ${answered.length} | double-exec ${records.filter((r) => r.doubleExecution).length} | median ${(median / 1000).toFixed(1)}s\n`,
      );

      if (jsonFile) {
        writeFileSync(
          jsonFile,
          JSON.stringify(
            {
              stage: "26.8",
              generatedAt: new Date().toISOString(),
              model,
              turns: records,
              ledger: turnLedger(),
            },
            null,
            2,
          ),
          "utf8",
        );
      }

      // §43/§44 — the only hard assertions. Analytical QUALITY is reported, not
      // asserted; routing and single-ownership are contracts.
      expect(records.filter((r) => r.doubleExecution)).toEqual([]);
      expect(records.filter((r) => !r.ownerCorrect).map((r) => `${r.id}: ${r.owner}/${r.ownerReason}`)).toEqual([]);
    },
    45 * 60_000,
  );
});
