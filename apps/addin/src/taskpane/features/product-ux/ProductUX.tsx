import { Button, Caption1, Text } from "@fluentui/react-components";
import { useState } from "react";

export interface ProductUXChange { readonly id: string; readonly description: string; readonly risk: "low" | "medium" | "high"; readonly affectedRange: string; readonly summary: string; }
export interface ProductUXPanelProps {
  readonly selectionLabel?: string;
  readonly pendingChange?: ProductUXChange;
  readonly activities?: readonly { readonly id: string; readonly label: string; readonly status: "running" | "done" | "error" }[];
  readonly sessions?: readonly { readonly id: string; readonly title: string }[];
  readonly history?: readonly { readonly id: string; readonly description: string }[];
  readonly onQuickAction?: (action: "analyze" | "clean") => void;
  readonly onApprove?: (id: string) => void;
  readonly onReject?: (id: string) => void;
  readonly onUndo?: (id: string) => void;
  readonly settingsOpen?: boolean;
  readonly onToggleSettings?: () => void;
}

export function ProductUXPanel({ selectionLabel, pendingChange, activities = [], sessions = [], history = [], onQuickAction, onApprove, onReject, onUndo, settingsOpen: controlledSettings, onToggleSettings }: ProductUXPanelProps) {
  const [localSettingsOpen, setLocalSettingsOpen] = useState(false);
  const settingsOpen = controlledSettings ?? localSettingsOpen;
  const toggleSettings = onToggleSettings ?? (() => setLocalSettingsOpen((open) => !open));
  return <div className="product-ux">
    <section className="quick-actions" aria-label="Quick actions">
      <div className="section-heading"><Caption1>Quick actions</Caption1>{selectionLabel && <Text size={200}>{selectionLabel}</Text>}</div>
      <div className="quick-actions-grid">
        <Button appearance="secondary" onClick={() => onQuickAction?.("analyze")}>Analyze selection</Button>
        <Button appearance="secondary" onClick={() => onQuickAction?.("clean")}>Clean selection</Button>
      </div>
    </section>

    {pendingChange && <section className="change-preview" aria-label="Change preview">
      <div className="section-heading"><Caption1>Pending change</Caption1><Text weight="semibold">{pendingChange.description}</Text></div>
      <div className={`risk-badge risk-badge--${pendingChange.risk}`}>{pendingChange.risk} risk</div>
      <Text>{pendingChange.summary}</Text><Caption1>{pendingChange.affectedRange}</Caption1>
      <div className="preview-actions"><Button appearance="primary" onClick={() => onApprove?.(pendingChange.id)}>Approve change</Button><Button appearance="secondary" onClick={() => onReject?.(pendingChange.id)}>Reject change</Button></div>
    </section>}

    {activities.length > 0 && <section className="activity-section"><Caption1>Activity</Caption1><ol className="activity-timeline" aria-label="Activity timeline">{activities.map((activity) => <li key={activity.id} data-status={activity.status}><span className="activity-indicator" aria-hidden="true" /><span>{activity.label}</span><Caption1>{activity.status}</Caption1></li>)}</ol></section>}
    {sessions.length > 0 && <section className="sessions-section" aria-label="Sessions"><Caption1>Recent sessions</Caption1><ul className="session-list">{sessions.map((session) => <li key={session.id}><Button appearance="subtle">{session.title}</Button></li>)}</ul></section>}
    {history.length > 0 && <section className="history-section" aria-label="Change history"><Caption1>Recent changes</Caption1><ul className="history-list">{history.map((entry) => <li key={entry.id}><span>{entry.description}</span><Button appearance="subtle" onClick={() => onUndo?.(entry.id)} aria-label={`Undo ${entry.description}`}>Undo</Button></li>)}</ul></section>}
    <Button appearance="subtle" onClick={toggleSettings} aria-label="Open settings">Settings</Button>
    {settingsOpen && <section className="settings-panel" aria-label="Settings"><Text weight="semibold">Settings</Text><label><input type="checkbox" defaultChecked /> Show activity details</label><label><input type="checkbox" /> Send workbook content only with consent</label></section>}
  </div>;
}
