import {
  Button,
  Caption1,
  FluentProvider,
  Text,
  Textarea,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  Bot24Regular,
  Send24Regular,
  Settings20Regular,
} from "@fluentui/react-icons";
import { useEffect, useState, type FormEvent } from "react";
import type { WorkbookContext } from "@sheet-agent/application";
import { waitForOffice, type OfficeReadyContext } from "../app/office-bootstrap.js";
import { connectWorkbookContext, type WorkbookContextConnector } from "../app/workbook-context.js";
import { ProductUXPanel, type ProductUXChange } from "./features/product-ux/ProductUX.js";

type ShellState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly office: OfficeReadyContext }
  | { readonly status: "error"; readonly message: string };

export interface AppProps {
  readonly bootstrap?: typeof waitForOffice;
  readonly connectContext?: WorkbookContextConnector;
  readonly pendingChange?: ProductUXChange;
  readonly history?: readonly { readonly id: string; readonly description: string }[];
  readonly sessions?: readonly { readonly id: string; readonly title: string }[];
  readonly onApproveChange?: (id: string) => void;
  readonly onRejectChange?: (id: string) => void;
  readonly onUndoChange?: (id: string) => void;
}

export function App({ bootstrap = waitForOffice, connectContext = connectWorkbookContext, pendingChange, history = [], sessions = [], onApproveChange, onRejectChange, onUndoChange }: AppProps) {
  const [state, setState] = useState<ShellState>({ status: "loading" });
  const [workbookContext, setWorkbookContext] = useState<WorkbookContext>();
  const [prompt, setPrompt] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activities, setActivities] = useState<readonly { readonly id: string; readonly label: string; readonly status: "running" | "done" | "error" }[]>([]);
  const prefersDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

  useEffect(() => {
    let active = true;
    void bootstrap()
      .then((office) => active && setState({ status: "ready", office }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Excel could not be initialized.";
        if (active) setState({ status: "error", message });
      });
    return () => {
      active = false;
    };
  }, [attempt, bootstrap]);

  useEffect(() => {
    if (state.status !== "ready") return;
    let active = true;
    let dispose: (() => void) | undefined;
    void connectContext((context) => { if (active) setWorkbookContext(context); })
      .then((cleanup) => { if (active) dispose = cleanup; else cleanup(); })
      .catch(() => { if (active) setWorkbookContext(undefined); });
    return () => { active = false; dispose?.(); };
  }, [connectContext, state.status]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
  }

  const uxProps = {
    activities,
    history,
    sessions,
    ...(pendingChange ? { pendingChange } : {}),
    ...(onApproveChange ? { onApprove: onApproveChange } : {}),
    ...(onRejectChange ? { onReject: onRejectChange } : {}),
    ...(onUndoChange ? { onUndo: onUndoChange } : {}),
  };

  return (
    <FluentProvider theme={prefersDark ? webDarkTheme : webLightTheme} className="app-provider">
      <div className="app-shell">
        <header className="app-header">
          <div className="brand-mark" aria-hidden="true"><Bot24Regular /></div>
          <div className="brand-copy">
            <Text as="h1" size={400} weight="semibold">Excel AI</Text>
            <Caption1>Workbook assistant</Caption1>
          </div>
          <Button appearance="subtle" icon={<Settings20Regular />} aria-label="Open settings" onClick={() => setSettingsOpen((open) => !open)} />
        </header>

        <section className="context-bar" aria-label="Workbook context">
          <div>
            <Caption1>{workbookContext ? workbookContext.selection.address : "Active sheet"}</Caption1>
            <Text weight="semibold">
              {workbookContext
                ? `${workbookContext.sheetName} · ${workbookContext.selection.rowCount} × ${workbookContext.selection.columnCount}`
                : state.status === "ready" ? "Reading selection…" : "Connecting…"}
            </Text>
          </div>
          <span className={`status-dot status-dot--${state.status}`} aria-hidden="true" />
        </section>

        <main className="conversation" aria-label="Assistant conversation">
          <div className="empty-state" aria-live="polite">
            {state.status === "loading" && (
              <>
                <div className="loading-mark" aria-hidden="true" />
                <Text weight="semibold">Connecting to Excel</Text>
                <Caption1>Preparing your workbook context…</Caption1>
              </>
            )}
            {state.status === "ready" && (
              <>
                <div className="hero-mark" aria-hidden="true"><Bot24Regular /></div>
                <Text as="h2" size={500} weight="semibold">What can I help with?</Text>
                <Caption1>Select a range, then ask a question about your workbook.</Caption1>
              </>
            )}
            {state.status === "error" && (
              <>
                <Text as="h2" size={400} weight="semibold">Excel isn’t connected</Text>
                <Caption1>{state.message}</Caption1>
                <Button icon={<ArrowClockwise20Regular />} onClick={() => setAttempt((value) => value + 1)}>
                  Try again
                </Button>
              </>
            )}
          </div>
          {state.status === "ready" && <ProductUXPanel
            {...uxProps}
            settingsOpen={settingsOpen}
            onToggleSettings={() => setSettingsOpen((open) => !open)}
            onQuickAction={(action) => setActivities((current) => [...current, { id: `${action}-${current.length}`, label: action === "analyze" ? "Analyze selection" : "Clean selection", status: "done" }])}
          />}
        </main>

        <form className="composer" onSubmit={submit} aria-label="Ask Excel AI">
          <Textarea
            resize="none"
            value={prompt}
            onChange={(_, data) => setPrompt(data.value)}
            placeholder="Ask about your workbook"
            aria-label="Message"
            disabled={state.status !== "ready"}
          />
          <Button
            className="send-button"
            appearance="primary"
            icon={<Send24Regular />}
            type="submit"
            aria-label="Send message"
            disabled={state.status !== "ready" || prompt.trim().length === 0}
          />
        </form>
      </div>
    </FluentProvider>
  );
}
