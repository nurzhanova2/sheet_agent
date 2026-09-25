import { useEffect, useLayoutEffect, useRef } from "react";
import { formatSeconds, type ActivityEntry, type TranscriptEntry } from "../../app/agent-session.js";
import type { ResponseLanguage } from "../../app/language.js";
import { MarkdownLite } from "./MarkdownLite.js";
import { ChangePreview } from "./ChangePreview.js";
import { ChartCard, type ChartInsertDims } from "./ChartCard.js";
import { ExecutionCode } from "./ExecutionCode.js";
import { ExecutionSummary } from "./ExecutionSummary.js";
import { TurnTimer } from "./TurnTimer.js";

export interface AgentTranscriptProps {
  readonly entries: readonly TranscriptEntry[];
  readonly busy: boolean;
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
  readonly language?: ResponseLanguage;
  readonly onInsertChart?: (base64Png: string, suggestedName: string, dims?: ChartInsertDims) => Promise<void> | void;
  readonly turnStartedAt?: number | null;
}

const STATUS_GLYPH: Record<ActivityEntry["status"], string> = { running: "●", done: "✓", error: "✕" };

export function AgentTranscript({ entries, busy, onApprove, onReject, language = "en", onInsertChart, turnStartedAt = null }: AgentTranscriptProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);

  const atBottom = (element: HTMLElement): boolean => element.scrollHeight - element.scrollTop - element.clientHeight <= 24;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    const onScroll = (): void => {
      autoFollowRef.current = atBottom(body);
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => body.removeEventListener("scroll", onScroll);
  }, [entries.length]);

  // Execution details are patched into one existing entry while a turn runs.
  // Layout effect + the direct parent scroll keeps the newest stage visible
  // after that patch has actually rendered. The sentinel remains as a fallback
  // for browser/WebView implementations that do not expose writable scrollTop.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !autoFollowRef.current) return;
    body.scrollTop = body.scrollHeight;
    if (typeof endRef.current?.scrollIntoView === "function") endRef.current.scrollIntoView({ block: "end" });
  }, [entries, turnStartedAt]);

  if (entries.length === 0) {
    return (
      <div className="term-body term-empty" aria-live="polite">
        <p className="term-empty-title">SheetAgent ready.</p>
        <p className="term-empty-hint">Select a range, then type a request below.</p>
        <p className="term-empty-hint term-dim">Try: “объясни данные в выделенном диапазоне”</p>
      </div>
    );
  }

  return (
    <div ref={bodyRef} className="term-body" aria-label="Agent transcript">
      {entries.map((entry) => {
        switch (entry.kind) {
          case "command":
            return (
              <div key={entry.id} className="term-cmd">
                <span className="term-cmd-glyph">›</span>
                <span>{entry.text}</span>
              </div>
            );
          case "activity":
            return (
              <div key={entry.id} className={`term-act term-act--${entry.status}`}>
                <span className="term-act-glyph" aria-hidden="true">
                  {STATUS_GLYPH[entry.status]}
                </span>
                <span className="term-act-body">
                  <span className="term-act-title">{entry.title}</span>
                  {entry.durationMs !== undefined && (
                    <span className="term-act-elapsed">· {formatSeconds(entry.durationMs, language === "ru" ? "ru" : "en")}</span>
                  )}
                  {entry.detail && <span className="term-act-detail">{entry.detail}</span>}
                </span>
              </div>
            );
          case "response":
            return (
              <div key={entry.id} className="term-response">
                {entry.text.length > 0 ? <MarkdownLite text={entry.text} /> : entry.streaming ? <span className="term-caret">▍</span> : null}
              </div>
            );
          case "proposal":
            return <ChangePreview key={entry.id} proposal={entry} busy={busy} onApprove={onApprove} onReject={onReject} />;
          case "notice":
            return (
              <div key={entry.id} className={`term-notice term-notice--${entry.tone}`} role={entry.tone === "error" ? "alert" : undefined}>
                {entry.text}
              </div>
            );
          case "chart":
            return (
              <ChartCard
                key={entry.id}
                data={entry.data}
                language={language}
                {...(onInsertChart ? { onInsert: onInsertChart } : {})}
              />
            );
          case "code":
            return <ExecutionCode key={entry.id} entry={entry} language={language} />;
          case "execution":
            return <ExecutionSummary key={entry.id} entry={entry} language={language} />;
        }
      })}
      {turnStartedAt !== null && <TurnTimer startedAt={turnStartedAt} language={language} />}
      <div ref={endRef} />
    </div>
  );
}
