import { useEffect, useState } from "react";
import { formatSeconds } from "../../app/agent-session.js";
import type { ResponseLanguage } from "../../app/language.js";

export interface TurnTimerProps {
  readonly startedAt: number;
  readonly language: ResponseLanguage;
  readonly now?: () => number;
}

const TICK_MS = 100;

export function TurnTimer({ startedAt, language, now = Date.now }: TurnTimerProps) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, now() - startedAt));

  useEffect(() => {
    setElapsed(Math.max(0, now() - startedAt));
    const id = setInterval(() => setElapsed(Math.max(0, now() - startedAt)), TICK_MS);
    return () => clearInterval(id);
  }, [startedAt, now]);

  const label = language === "ru" ? "Анализ выполняется" : "Working";
  return (
    <div className="term-turn-timer" role="status" aria-live="off">
      <span className="term-turn-timer-glyph" aria-hidden="true">
        ◌
      </span>
      <span className="term-turn-timer-label">{label}</span>
      <span className="term-turn-timer-value">· {formatSeconds(elapsed, language === "ru" ? "ru" : "en")}</span>
    </div>
  );
}
