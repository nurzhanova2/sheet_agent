// ---------------------------------------------------------------------------
// Stage 22 — deterministic slash-command parsing. Only the command PREFIX and
// IDENTITY are parsed here; everything after the first whitespace is opaque
// natural-language arguments handed to the existing planner. No brittle grammar.
// ---------------------------------------------------------------------------

import { findSlashCommand, type SlashCommand } from "./registry.js";

/** A recognised command with its natural-language argument tail. */
export interface ParsedCommand {
  readonly kind: "command";
  readonly command: SlashCommand;
  readonly args: string;
}

/** Text began with "/" but the token is not a known command. */
export interface UnknownCommand {
  readonly kind: "unknown";
  /** The offending token including the slash, e.g. "/foobar". */
  readonly token: string;
}

/**
 * Still typing the command name (no whitespace yet) — palette territory.
 * `query` is the lower-cased text after "/".
 */
export interface PartialCommand {
  readonly kind: "partial";
  readonly query: string;
}

export type SlashParse = ParsedCommand | UnknownCommand | PartialCommand | null;

/**
 * Classifies raw composer text. Returns `null` when it is not a slash command
 * at all (ordinary chat). While the user is still typing the name (no space),
 * returns a `partial` so the palette can open and filter.
 */
export function parseSlashInput(raw: string): SlashParse {
  if (!raw.startsWith("/")) return null;
  const body = raw.slice(1);
  const space = /\s/.exec(body);
  if (!space) return { kind: "partial", query: body.toLowerCase() };
  const name = body.slice(0, space.index).toLowerCase();
  const args = body.slice(space.index + 1).trim();
  const command = findSlashCommand(name);
  if (!command) return { kind: "unknown", token: `/${name}` };
  return { kind: "command", command, args };
}

/**
 * Resolves the composer text AT SUBMIT TIME. Unlike {@link parseSlashInput} a
 * bare "/undo" / "/summary" (a command name with no trailing space) resolves to
 * that command with empty args. Returns `null` for ordinary chat and for a lone
 * "/" (nothing to do).
 */
export function resolveSlashSubmission(raw: string): ParsedCommand | UnknownCommand | null {
  const trimmed = raw.trim();
  const parsed = parseSlashInput(trimmed);
  if (parsed === null) return null;
  if (parsed.kind === "command" || parsed.kind === "unknown") return parsed;
  // partial: the whole input is "/word" with no argument tail.
  if (parsed.query === "") return null;
  const command = findSlashCommand(parsed.query);
  if (!command) return { kind: "unknown", token: `/${parsed.query}` };
  return { kind: "command", command, args: "" };
}
