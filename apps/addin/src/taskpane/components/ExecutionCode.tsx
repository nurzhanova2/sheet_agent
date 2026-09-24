import { useState } from "react";
import type { CodeEntry } from "../../app/agent-session.js";
import type { ResponseLanguage } from "../../app/language.js";

export interface ExecutionCodeProps {
  readonly entry: CodeEntry;
  readonly language: ResponseLanguage;
}

export function ExecutionCode({ entry, language }: ExecutionCodeProps) {
  const [open, setOpen] = useState(entry.attempt > 1);
  const lines = entry.code.split(String.fromCharCode(10));
  const hint = language === "ru" ? `${lines.length} стр.` : `${lines.length} lines`;
  return (
    <div className="term-code">
      <button type="button" className="term-code-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="term-code-glyph" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="term-code-title">{entry.title}</span>
        <span className="term-code-hint">{hint}</span>
      </button>
      {open && (
        <pre className="term-code-body">
          <code>{entry.code}</code>
        </pre>
      )}
    </div>
  );
}
