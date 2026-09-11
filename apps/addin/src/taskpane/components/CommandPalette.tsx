import { useMemo } from "react";
import { groupedSlashCommands, SLASH_CATEGORY_LABEL, type SlashCommand } from "../../app/commands/registry.js";

export interface CommandPaletteProps {
  /** Text after the leading "/" (the command name being typed). */
  readonly query: string;
  /** Index into the FLAT filtered list of the currently highlighted row. */
  readonly activeIndex: number;
  readonly onHover: (index: number) => void;
  readonly onPick: (command: SlashCommand) => void;
}

/** Flat, filtered command list in palette (category) order — the nav order. */
export function paletteItems(query: string): readonly SlashCommand[] {
  return groupedSlashCommands(query).flatMap(([, group]) => group);
}

/**
 * The "/" command palette. Presentational: the composer owns the query, the
 * active index and all keyboard handling; this renders the grouped list and
 * reports hover / click.
 */
export function CommandPalette({ query, activeIndex, onHover, onPick }: CommandPaletteProps) {
  const groups = useMemo(() => groupedSlashCommands(query), [query]);

  if (groups.length === 0) {
    return (
      <div className="term-palette" role="listbox" aria-label="Slash commands">
        <div className="term-palette-empty">No matching command</div>
      </div>
    );
  }

  let flat = -1;
  return (
    <div className="term-palette" role="listbox" aria-label="Slash commands">
      {groups.map(([category, group]) => (
        <div key={category} className="term-palette-group">
          <div className="term-palette-group-label">{SLASH_CATEGORY_LABEL[category]}</div>
          {group.map((command) => {
            flat += 1;
            const index = flat;
            const active = index === activeIndex;
            return (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={active}
                className={`term-palette-item${active ? " term-palette-item--active" : ""}`}
                onMouseEnter={() => onHover(index)}
                // mousedown (not click) so the textarea keeps focus through the pick
                onMouseDown={(event) => {
                  event.preventDefault();
                  onPick(command);
                }}
              >
                <span className="term-palette-name">{command.label}</span>
                <span className="term-palette-desc">{command.description}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
