import { useEffect, useRef } from "react";
import type { ActivityEntry, TranscriptEntry } from "../../app/agent-session.js";
import type { ResponseLanguage } from "../../app/language.js";
import { MarkdownLite } from "./MarkdownLite.js";
import { ChangePreview } from "./ChangePreview.js";
import { ChartCard, type ChartInsertDims } from "./ChartCard.js";

export interface AgentTranscriptProps {
  readonly entries: readonly TranscriptEntry[];
  readonly busy: boolean;
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
  readonly language?: ResponseLanguage;
  readonly onInsertChart?: (base64Png: string, suggestedName: string, dims?: ChartInsertDims) => Promise<void> | void;
}

const STATUS_GLYPH: Record<ActivityEntry["status"], string> = { running: "●", done: "✓", error: "✕" };

export function AgentTranscript({ entries, busy, onApprove, onReject, language = "en", onInsertChart }: AgentTranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof endRef.current?.scrollIntoView === "function") endRef.current.scrollIntoView({ block: "end" });
  }, [entries]);

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
    <div className="term-body" aria-label="Agent transcript">
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
        }
      })}
      <div ref={endRef} />
    </div>
  );
}
