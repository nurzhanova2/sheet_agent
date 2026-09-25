// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

function ruleBodyFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[,}])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "m").exec(css);
  const captured = match?.[1];
  if (captured === undefined) throw new Error(`no CSS rule found for ${selector}`);
  return captured;
}

function declaresNonVisibleOverflow(body: string): boolean {
  return /(?<!-wrap)(?:^|;)\s*overflow(?:-[xy])?\s*:\s*(?!visible)[a-z]+/i.test(`;${body}`);
}

function pinnedAgainstShrink(body: string): boolean {
  if (/flex-shrink\s*:\s*0\b/i.test(body)) return true;
  return /flex\s*:\s*\S+\s+0(?:\s|;)/i.test(body);
}

const TOP_LEVEL_TRANSCRIPT_CARDS = [
  ".term-cmd",
  ".term-act",
  ".term-response",
  ".term-exec",
  ".term-code",
  ".term-chart",
  ".term-notice",
  ".term-change",
  ".term-turn-timer",
];

describe("Stage 28H — .term-body scroll ownership", () => {
  it("is the single flex column that scrolls the transcript", () => {
    const body = ruleBodyFor(".term-body");
    expect(body).toMatch(/display\s*:\s*flex/);
    expect(body).toMatch(/flex-direction\s*:\s*column/);
    expect(body).toMatch(/overflow-y\s*:\s*auto/);
  });

  it.each(TOP_LEVEL_TRANSCRIPT_CARDS)("%s does not clip and cannot be shrunk below its content by .term-body", (selector) => {
    const body = ruleBodyFor(selector);
    if (declaresNonVisibleOverflow(body)) {
      expect(pinnedAgainstShrink(body)).toBe(true);
    }
  });
});
