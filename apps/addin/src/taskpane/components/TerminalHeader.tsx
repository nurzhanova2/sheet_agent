export type ConnectionState = "connecting" | "connected" | "offline";

export interface TerminalHeaderProps {
  readonly connection: ConnectionState;
  readonly model?: string;
  readonly onOpenSettings: () => void;
  readonly onNewChat: () => void;
  readonly canReset: boolean;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  offline: "Offline",
};

export function TerminalHeader({ connection, model, onOpenSettings, onNewChat, canReset }: TerminalHeaderProps) {
  return (
    <header className="term-header">
      <span className="term-title">SHEET&nbsp;AGENT</span>
      <span className={`term-conn term-conn--${connection}`} role="status">
        <span className="term-dot" aria-hidden="true" />
        {CONNECTION_LABEL[connection]}
      </span>
      <span className="term-model" title="Model configured on the Companion (LLM_MODEL)">
        {model ?? "model —"}
      </span>
      <button type="button" className="term-iconbtn" onClick={onNewChat} disabled={!canReset} aria-label="New chat">
        + new
      </button>
      <button type="button" className="term-iconbtn" onClick={onOpenSettings} aria-label="Open settings">
        ⚙
      </button>
    </header>
  );
}
