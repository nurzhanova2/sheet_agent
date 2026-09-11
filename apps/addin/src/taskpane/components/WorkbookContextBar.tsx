import type { WorkbookContext } from "@sheet-agent/application";

export interface WorkbookContextBarProps {
  readonly context?: WorkbookContext;
  readonly state: "loading" | "ready" | "error";
}

export function WorkbookContextBar({ context, state }: WorkbookContextBarProps) {
  if (!context) {
    return (
      <div className="term-ctxbar" aria-label="Workbook context">
        <span className="term-ctx-dim">
          {state === "ready" ? "Excel › reading selection…" : state === "error" ? "Excel › not connected" : "Excel › connecting…"}
        </span>
      </div>
    );
  }
  const local = context.selection.address.split("!").pop() ?? context.selection.address;
  return (
    <div className="term-ctxbar" aria-label="Workbook context">
      <span className="term-ctx-path">
        Excel <span className="term-ctx-sep">›</span> <span className="term-ctx-sheet">{context.sheetName}</span>{" "}
        <span className="term-ctx-sep">›</span> <span className="term-ctx-range">{local}</span>
      </span>
      <span className="term-ctx-dim">
        {context.selection.rowCount} × {context.selection.columnCount}
      </span>
    </div>
  );
}
