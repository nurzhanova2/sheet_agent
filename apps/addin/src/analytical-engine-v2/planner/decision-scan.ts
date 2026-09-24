import type { SerializationClass } from "../types.js";

export type { SerializationClass };

export interface DecisionScan {
  readonly serialization: SerializationClass;
  /**
   * The raw text of every complete, independently parseable top-level object,
   * in the order sent. For a single decision this holds exactly one entry; for
   * a rejected batch it holds all of them, so the safety check can inspect
   * EVERY object before anything is refused or accepted (§13/§26).
   */
  readonly objects: readonly string[];
}

/**
 * §12 — a decision is small. Anything past this is not a decision that got
 * long, it is a generation that ran away, and scanning it is wasted work.
 */
const MAX_SCAN_CHARS = 64_000;

const BACKSLASH = "\\";

/** Balanced top-level `{…}` spans, aware of strings and escapes (§12). */
function objectSpans(text: string): { readonly spans: readonly (readonly [number, number])[]; readonly unterminated: boolean } {
  const spans: (readonly [number, number])[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === BACKSLASH) escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) spans.push([start, i + 1]);
    }
  }
  return { spans, unterminated: depth > 0 || inString };
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Strips whitespace and code fences without touching anything inside them. */
function unwrap(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json|javascript|js)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * Classify one planner response. Structure only — the caller parses and
 * validates whatever this says is there.
 */
export function scanDecisions(raw: string, marker = '"kind"'): DecisionScan {
  const text = unwrap(raw).slice(0, MAX_SCAN_CHARS);
  if (text === "") return { serialization: "none", objects: [] };

  // §10 — a top-level array of decisions is a batch written the other way
  // round, and must be named as one rather than rejected as a bad container.
  if (text.startsWith("[")) {
    try {
      const value: unknown = JSON.parse(text);
      if (Array.isArray(value)) {
        const objects = value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v));
        if (objects.length >= 2) return { serialization: "array", objects: objects.map((o) => JSON.stringify(o)) };
        // An array holding one decision, or none, is NOT a batch — but it is
        // also not the object the protocol asks for. It is handed on whole, so
        // the existing container check owns it and says so precisely. Unwrapping
        // it here would be a normalization nobody asked for.
        return { serialization: "single", objects: [text] };
      }
    } catch {
      /* fall through to the object scan: a malformed array is not a batch */
    }
  }

  const { spans, unterminated } = objectSpans(text);
  const complete: string[] = [];
  for (const [from, to] of spans) {
    const slice = text.slice(from, to);
    if (parsedObject(slice) !== null) complete.push(slice);
  }

  if (complete.length >= 2) return { serialization: "concatenated", objects: complete };

  if (complete.length === 1) {
    // Everything the model wrote OUTSIDE the one complete object. A second
    // decision that was started and never finished still means the response
    // carried more than one, and §5 forbids quietly running the first.
    let outside = text;
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      const [from, to] = spans[i]!;
      outside = outside.slice(0, from) + outside.slice(to);
    }
    if (outside.includes(marker)) return { serialization: "concatenated", objects: complete };
    return { serialization: outside.trim() === "" ? "single" : "wrapped_single", objects: complete };
  }

  // Nothing complete. §14/§15 — say which kind of broken it is; repair neither.
  if (unterminated) return { serialization: "truncated", objects: [] };
  if (spans.length > 0) return { serialization: "invalid", objects: [] };
  return { serialization: text.includes("{") ? "truncated" : "none", objects: [] };
}
