import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { parseSlashInput } from "../../app/commands/parse.js";
import type { SlashCommand } from "../../app/commands/registry.js";
import { CommandPalette, paletteItems } from "./CommandPalette.js";

export interface ComposerProps {
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onSubmit: (value: string) => void;
}

export function Composer({ disabled, busy, onSubmit }: ComposerProps) {
  const [value, setValue] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  // Palette is open only while the command name is still being typed (no space
  // yet) and the user has not dismissed it with Escape.
  const parsed = parseSlashInput(value);
  const paletteQuery = parsed?.kind === "partial" ? parsed.query : null;
  const paletteOpen = paletteQuery !== null && !dismissed;
  const items = paletteOpen ? paletteItems(paletteQuery) : [];

  // Keep the highlighted row in range as the filter narrows.
  useEffect(() => {
    setActiveIndex((current) => (items.length === 0 ? 0 : Math.min(current, items.length - 1)));
  }, [paletteQuery, items.length]);

  function send() {
    const text = value.trim();
    if (!text || disabled || busy) return;
    onSubmit(text);
    setValue("");
    setDismissed(false);
    setActiveIndex(0);
  }

  function pick(command: SlashCommand) {
    setValue(`${command.label} `);
    setDismissed(false);
    setActiveIndex(0);
    ref.current?.focus();
  }

  function onChange(next: string) {
    setValue(next);
    // Re-arm the palette once the input is cleared or is no longer a slash.
    if (!next.startsWith("/")) setDismissed(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (paletteOpen && items.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => Math.min(items.length - 1, current + 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const command = items[activeIndex];
        if (command) pick(command);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  return (
    <form
      className="term-composer"
      aria-label="Ask SheetAgent"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {paletteOpen && (
        <CommandPalette query={paletteQuery} activeIndex={activeIndex} onHover={setActiveIndex} onPick={pick} />
      )}
      <span className="term-prompt-glyph" aria-hidden="true">
        ›
      </span>
      <textarea
        ref={ref}
        className="term-input"
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={busy ? "Working…" : "Ask SheetAgent…  ( / for commands )"}
        aria-label="Message"
        disabled={disabled}
      />
      <button
        type="submit"
        className="term-send"
        disabled={disabled || busy || value.trim().length === 0}
        aria-label="Send message"
      >
        {busy ? "…" : "↵"}
      </button>
    </form>
  );
}
