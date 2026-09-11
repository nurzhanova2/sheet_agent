import { Fragment, type ReactNode } from "react";

/**
 * Tiny, dependency-free Markdown renderer: fenced code blocks, inline `code`, **bold**,
 * *italic*, and `- ` / `1. ` list markers. Anything else renders as plain text with line
 * breaks preserved. Fenced blocks scroll horizontally so long formulas never overflow.
 */
export function MarkdownLite({ text }: { readonly text: string }) {
  const segments = text.split(/```([\s\S]*?)```/);
  return (
    <div className="md">
      {segments.map((segment, index) =>
        index % 2 === 1 ? (
          <pre key={index} className="md-code-block">
            <code>{segment.replace(/^\n/, "").replace(/\n$/, "")}</code>
          </pre>
        ) : (
          <Fragment key={index}>{renderProse(segment)}</Fragment>
        ),
      )}
    </div>
  );
}

function renderProse(block: string): ReactNode {
  const lines = block.split(/\r?\n/);
  return lines.map((line, index) => {
    const listMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      return (
        <div key={index} className="md-li">
          <span className="md-bullet">{listMatch[2]?.match(/\d/) ? listMatch[2] : "•"}</span>
          <span>{renderInline(listMatch[3] ?? "")}</span>
        </div>
      );
    }
    if (line.trim().length === 0) return <div key={index} className="md-gap" />;
    return (
      <div key={index} className="md-p">
        {renderInline(line)}
      </div>
    );
  });
}

function renderInline(text: string): ReactNode {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return tokens.map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("*") && token.endsWith("*")) return <em key={index}>{token.slice(1, -1)}</em>;
    return <Fragment key={index}>{token}</Fragment>;
  });
}
