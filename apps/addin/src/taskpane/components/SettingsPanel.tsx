import { useCallback, useEffect, useState } from "react";
import type { CompanionHealth, HealthClient } from "../../app/companion-health.js";

export interface SettingsPanelProps {
  readonly healthClient: HealthClient;
  readonly endpoint: string;
  readonly onClose: () => void;
}

export function SettingsPanel({ healthClient, endpoint, onClose }: SettingsPanelProps) {
  const [health, setHealth] = useState<CompanionHealth>();
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setHealth(await healthClient.check());
    } finally {
      setChecking(false);
    }
  }, [healthClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="term-settings" aria-label="Settings">
      <div className="term-settings-head">
        <span>SETTINGS</span>
        <button type="button" className="term-iconbtn" onClick={onClose} aria-label="Close settings">
          ✕
        </button>
      </div>
      <dl className="term-kv">
        <div>
          <dt>Companion</dt>
          <dd>{health ? (health.reachable ? `reachable (${health.status ?? "ok"})` : `unreachable — ${health.error ?? "?"}`) : "checking…"}</dd>
        </div>
        <div>
          <dt>Endpoint</dt>
          <dd className="term-mono">{endpoint}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="term-mono">{health?.model ?? "—"}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd className="term-mono">{health?.provider ?? "—"}</dd>
        </div>
        <div>
          <dt>Companion version</dt>
          <dd className="term-mono">{health?.version ?? "—"}</dd>
        </div>
        <div>
          <dt>API key</dt>
          <dd>{health?.apiKeyConfigured === undefined ? "—" : health.apiKeyConfigured ? "configured" : "not configured"}</dd>
        </div>
      </dl>
      <p className="term-settings-note">
        Model and endpoint are set on the Windows Companion via <span className="term-mono">LLM_MODEL</span> /{" "}
        <span className="term-mono">LLM_API_BASE</span> and require restarting SheetAgent.exe. Set or remove the API key from
        the Companion tray icon → Настройки. The key is never shown here.
      </p>
      <button type="button" className="term-btn" onClick={() => void refresh()} disabled={checking}>
        {checking ? "Testing…" : "Test connection"}
      </button>
    </section>
  );
}
