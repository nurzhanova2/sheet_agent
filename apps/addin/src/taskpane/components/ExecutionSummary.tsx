import { useEffect, useRef, useState } from "react";
import { formatSeconds, type ExecutionDetail, type ExecutionEntry } from "../../app/agent-session.js";
import type { ResponseLanguage } from "../../app/language.js";

export interface ExecutionSummaryProps {
  readonly entry: ExecutionEntry;
  readonly language: ResponseLanguage;
}

const STEP_GLYPH = { running: "●", done: "✓", error: "×" } as const;

function CodeCard({ detail, language }: { readonly detail: Extract<ExecutionDetail, { readonly kind: "code" }>; readonly language: ResponseLanguage }) {
  const [expanded, setExpanded] = useState(false);
  const lines = detail.code.split("\n");
  const copy = (): void => {
    void globalThis.navigator?.clipboard?.writeText(detail.code);
  };
  const attempt = language === "ru" ? `Попытка ${detail.attempt}` : `Attempt ${detail.attempt}`;
  const copyLabel = language === "ru" ? "Копировать" : "Copy";
  const expandLabel = language === "ru" ? "Развернуть" : "Expand";
  return (
    <section className={`term-exec-code ${expanded ? "term-exec-code--expanded" : ""}`}>
      <div className="term-exec-code-head">
        <span className="term-exec-code-name">&lt;/&gt; Python · sandbox</span>
        <span className="term-exec-code-status">● {attempt}</span>
        <button type="button" className="term-exec-code-button" onClick={copy}>{copyLabel}</button>
        <button type="button" className="term-exec-code-button" onClick={() => setExpanded((value) => !value)}>{expandLabel}</button>
      </div>
      <pre className="term-exec-code-body">
        <code>{lines.map((line, index) => <span className="term-exec-code-line" key={`${detail.attempt}-${index}`}>{line || " "}{index < lines.length - 1 ? "\n" : ""}</span>)}</code>
      </pre>
    </section>
  );
}

export function ExecutionSummary({ entry, language }: ExecutionSummaryProps) {
  const [open, setOpen] = useState(entry.status !== "done");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const previousStatus = useRef(entry.status);
  useEffect(() => {
    if (previousStatus.current !== entry.status && entry.status !== "running") setOpen(false);
    previousStatus.current = entry.status;
  }, [entry.status]);
  const locale = language === "ru" ? "ru" : "en";
  const stages = language === "ru" ? "Этапы выполнения" : "Execution stages";
  const detailsLabel = language === "ru" ? "Вывод и дополнительные детали" : "Output and additional details";
  return (
    <div className={`term-exec term-exec--${entry.status}`}>
      <button type="button" className="term-exec-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="term-exec-glyph" aria-hidden="true">{entry.status === "error" ? "×" : entry.status === "running" ? "●" : "✓"}</span>
        <span className="term-exec-title">{entry.title}</span>
        {entry.subtitle !== undefined && <span className="term-exec-subtitle">· {entry.subtitle}</span>}
        <span className="term-exec-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="term-exec-body">
          <div className="term-exec-panel-head"><span>{stages}</span><span aria-hidden="true">⌃</span></div>
          <div className="term-exec-stages">
            {entry.details.map((detail, index) => detail.kind === "code" ? <CodeCard key={index} detail={detail} language={language} /> : (
              <div key={index} className={`term-exec-step term-exec-step--${detail.status}`}>
                <span className="term-exec-step-glyph" aria-hidden="true">{STEP_GLYPH[detail.status]}</span>
                <span className="term-exec-step-body">
                  <span className="term-exec-step-title">{detail.title}</span>
                  {detail.detail !== undefined && <span className="term-exec-step-detail">{detail.detail}</span>}
                  {detail.diagnostics !== undefined && <span className="term-exec-diagnostics">{detail.diagnostics.map((row) => <span key={row.label} className="term-exec-diagnostic"><span className="term-exec-diagnostic-label">{row.label}:</span> {row.value}</span>)}</span>}
                </span>
                {detail.durationMs !== undefined && <span className="term-exec-step-elapsed">{formatSeconds(detail.durationMs, locale)}</span>}
              </div>
            ))}
          </div>
          <button type="button" className="term-exec-details-head" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}>
            <span>{detailsLabel}</span><span aria-hidden="true">{detailsOpen ? "▾" : "▸"}</span>
          </button>
          {entry.metrics.length > 0 && <div className="term-exec-metrics">{entry.metrics.map((row) => <span key={row} className="term-exec-metric">{row}</span>)}</div>}
        </div>
      )}
    </div>
  );
}
