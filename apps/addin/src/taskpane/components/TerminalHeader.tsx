export type ConnectionState = "connecting" | "connected" | "offline";

export interface TerminalHeaderProps {
  readonly connection: ConnectionState;
  readonly model?: string;
  readonly onOpenSettings: () => void;
  readonly onNewChat: () => void;
  readonly canReset: boolean;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "CONNECTING",
  connected: "CONNECTED",
  offline: "OFFLINE",
};

/**
 * Two rows, as the redesign draws them: the product's own title bar above a
 * status strip. One row had to hold the brand, the name, the connection and the
 * model at once, and at task-pane width the model was always the thing that got
 * truncated — which is the one piece a tester is asked to read back.
 */
export function TerminalHeader({ connection, model, onOpenSettings, onNewChat, canReset }: TerminalHeaderProps) {
  return (
    <header className="term-header">
      <div className="term-titlebar">
        <img className="term-brand" src="assets/icon-64.png" alt="" aria-hidden="true" width={20} height={20} />
        <span className="term-appname">Sheet Agent</span>
        <div className="term-titlebar-actions">
          <button type="button" className="term-iconbtn" onClick={onNewChat} disabled={!canReset} aria-label="New chat">
            + new
          </button>
          <button type="button" className="term-iconbtn" onClick={onOpenSettings} aria-label="Open settings">
            ⚙
          </button>
        </div>
      </div>
      <div className="term-toolbar">
        <span className="term-title">SHEET_AGENT</span>
        <span className={`term-conn term-conn--${connection}`} role="status">
          <span className="term-dot" aria-hidden="true" />
          {CONNECTION_LABEL[connection]}
        </span>
        <span className="term-model" title="Model configured on the Companion (LLM_MODEL)">
          {model ?? "model —"}
        </span>
      </div>
    </header>
  );
}
