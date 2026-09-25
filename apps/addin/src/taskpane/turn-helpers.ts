import type { CellValue, ExcelPort } from "@sheet-agent/application";
import { nextId, type TranscriptEntry } from "../app/agent-session.js";
import { formatDisplayCell } from "../app/format-cell.js";
import { t } from "../app/i18n.js";
import type { ResponseLanguage } from "../app/language.js";
import { buildWorkbookMap, type WorkbookMap } from "../app/commands/workbook-map.js";
import { revalidateSource, revalidateSources } from "../app/source-freshness.js";
import { rememberDerivedResult } from "../app/conversation-memory.js";
import { applyResultTransform, isTransformError } from "../app/result-transforms.js";
import type { ResultRef, SessionMemory } from "../app/session-memory.js";

/**
 * Stage 28G §14 — the primitives every non-slash route shares.
 *
 * They were closures inside `submit`, redefined for every turn and reachable
 * from any branch. Gathering them here does not make them fewer: it makes the
 * set of things a route may do to the transcript and to a stored result
 * enumerable, and it puts the three rules that must not diverge between routes
 * in one place — how the assistant speaks in two languages, what "this result
 * is still fresh" means for a result with more than one source range, and how
 * a deterministic reshape of a stored result is recorded.
 */
export interface TurnHelperDeps {
  /** The user's text for this turn — the default attribution for a reshape. */
  readonly text: string;
  readonly lang: ResponseLanguage;
  readonly port: ExcelPort;
  readonly append: (entry: TranscriptEntry) => void;
  readonly memory: () => SessionMemory;
  readonly setMemory: (next: SessionMemory) => void;
  readonly recordExchange: (userMessage: string, assistantMessage: string) => void;
}

export interface TurnHelpers {
  /** One response line, in the turn's language. */
  readonly say: (en: string, ru: string) => void;
  /** §16 — nothing is applied without approval; this is how the wait is shown. */
  readonly proposeActions: (count: number) => void;
  readonly safeBuildMap: () => Promise<WorkbookMap | null>;
  /** 24.4.4 §11 — freshness for a result that may derive from >1 worksheet. */
  readonly resultIsFresh: (ref: ResultRef) => Promise<boolean>;
  readonly overwriteNote: (cells: number) => string;
  readonly sayStaleSource: () => void;
  readonly findResult: (id: string | undefined) => ResultRef | undefined;
  /**
   * 24.5.3 — an "N <noun> with the worst/best <metric>" follow-up must reshape
   * the fullest compatible ancestor, not a 1-row "which is worst" result that
   * happens to be the most recent. Walks the derivedFrom lineage to the
   * nearest result with at least `minRows` rows; falls back to `start`.
   */
  readonly resolveRankTarget: (start: ResultRef, minRows: number) => ResultRef;
  /** Stage 24.2B — a deterministic transform of an earlier result, recorded with its lineage. */
  readonly emitTransform: (ref: ResultRef, transform: Parameters<typeof applyResultTransform>[1], userMessage?: string) => void;
}

const STALE_EN = "The source data has changed since that result was calculated. Please rerun the analysis before applying this change.";
const STALE_RU = "Исходные данные изменились с момента расчёта этого результата. Повторите анализ перед применением изменения.";

const NEWLINE = String.fromCharCode(10);

/** A bounded markdown grid — the shape a reshaped result is shown in. */
export function renderGridMarkdown(columns: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const head = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, 50)
    // 24.4.4 §14 — display formatting only; the ResultRef keeps exact values.
    .map((row) => `| ${columns.map((_, c) => formatDisplayCell((row[c] ?? null) as CellValue)).join(" | ")} |`)
    .join(NEWLINE);
  return body ? `${head}${NEWLINE}${sep}${NEWLINE}${body}` : `${head}${NEWLINE}${sep}`;
}

export function createTurnHelpers(deps: TurnHelperDeps): TurnHelpers {
  const ru = deps.lang === "ru";

  const say = (en: string, ruText: string): void => {
    deps.append({ kind: "response", id: nextId("res"), streaming: false, text: ru ? ruText : en });
  };

  const findResult = (id: string | undefined): ResultRef | undefined =>
    id ? deps.memory().recentResults.find((r) => r.id === id) : undefined;

  return {
    say,
    proposeActions: (count) => {
      deps.append({
        kind: "activity",
        id: nextId("act"),
        activity: "waiting_for_approval",
        title: t(deps.lang, "ua.awaitingApproval", { n: count }),
        status: "running",
      });
    },
    safeBuildMap: async () => {
      try {
        return await buildWorkbookMap(deps.port);
      } catch {
        return null;
      }
    },
    resultIsFresh: async (ref) =>
      ref.sourceVersions && ref.sourceVersions.length > 0
        ? (await revalidateSources(deps.port, ref.sourceVersions)) === "fresh"
        : (await revalidateSource(deps.port, ref.sourceRange, ref.sourceVersion)) === "fresh",
    overwriteNote: (cells) => (cells > 0 ? (ru ? ` ${cells} непустых ячеек будут перезаписаны.` : ` ${cells} non-empty cell(s) will be overwritten.`) : ""),
    sayStaleSource: () => say(STALE_EN, STALE_RU),
    findResult,
    resolveRankTarget: (start, minRows) => {
      const seen = new Set<string>();
      let cur: ResultRef | undefined = start;
      while (cur && !seen.has(cur.id)) {
        if (cur.rows.length >= minRows) return cur;
        seen.add(cur.id);
        cur = cur.derivedFromResultId ? findResult(cur.derivedFromResultId) : undefined;
      }
      return start;
    },
    emitTransform: (ref, transform, userMessage = deps.text) => {
      const applied = applyResultTransform(ref, transform);
      if (isTransformError(applied)) {
        deps.append({
          kind: "response",
          id: nextId("res"),
          streaming: false,
          text: ru ? `Не удалось преобразовать прошлый результат: ${applied.error}.` : `I couldn't reshape that earlier result — ${applied.error}.`,
        });
        return;
      }
      deps.setMemory(rememberDerivedResult(deps.memory(), ref, applied));
      const body = `${applied.answer}${NEWLINE}${NEWLINE}${renderGridMarkdown(applied.columns, applied.rows)}`;
      deps.append({ kind: "response", id: nextId("res"), text: body, streaming: false });
      deps.recordExchange(userMessage, body);
    },
  };
}
