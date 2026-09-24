import { useEffect, useMemo, useState } from "react";
import type { ExcelMutationPort, ExcelPort, WorkbookContext } from "@sheet-agent/application";
import { waitForOffice, type OfficeReadyContext } from "../app/office-bootstrap.js";
import { connectWorkbookContext, createExcelPort, type WorkbookContextConnector } from "../app/workbook-context.js";
import { createDefaultChatClient, type ChatClient } from "../app/chat-client.js";
import { createDefaultHealthClient, type HealthClient } from "../app/companion-health.js";
import { TerminalHeader, type ConnectionState } from "./components/TerminalHeader.js";
import { WorkbookContextBar } from "./components/WorkbookContextBar.js";
import { AgentTranscript } from "./components/AgentTranscript.js";
import { Composer } from "./components/Composer.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { useAgent } from "./use-agent.js";

type ShellState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly office: OfficeReadyContext }
  | { readonly status: "error"; readonly message: string };

export interface AppProps {
  readonly bootstrap?: typeof waitForOffice;
  readonly connectContext?: WorkbookContextConnector;
  readonly chatClient?: ChatClient;
  readonly healthClient?: HealthClient;
  readonly port?: ExcelPort & ExcelMutationPort;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "https://localhost:47831";

export function App({
  bootstrap = waitForOffice,
  connectContext = connectWorkbookContext,
  chatClient,
  healthClient,
  port,
}: AppProps) {
  const resolvedPort = useMemo(() => port ?? createExcelPort(), [port]);
  const resolvedChat = useMemo(() => chatClient ?? createDefaultChatClient(), [chatClient]);
  const resolvedHealth = useMemo(() => healthClient ?? createDefaultHealthClient(), [healthClient]);

  const [state, setState] = useState<ShellState>({ status: "loading" });
  const [workbookContext, setWorkbookContext] = useState<WorkbookContext>();
  const [attempt, setAttempt] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [model, setModel] = useState<string>();

  const agent = useAgent({ chatClient: resolvedChat, port: resolvedPort });

  useEffect(() => {
    let active = true;
    void bootstrap()
      .then((office) => active && setState({ status: "ready", office }))
      .catch((error: unknown) => {
        if (active) setState({ status: "error", message: error instanceof Error ? error.message : "Excel could not be initialized." });
      });
    return () => {
      active = false;
    };
  }, [attempt, bootstrap]);

  useEffect(() => {
    if (state.status !== "ready") return;
    let active = true;
    let dispose: (() => void) | undefined;
    void connectContext((context) => {
      if (active) setWorkbookContext(context);
    })
      .then((cleanup) => {
        if (active) dispose = cleanup;
        else cleanup();
      })
      .catch(() => {
        if (active) setWorkbookContext(undefined);
      });
    return () => {
      active = false;
      dispose?.();
    };
  }, [connectContext, state.status]);

  useEffect(() => {
    let active = true;
    void resolvedHealth.check().then((health) => {
      if (!active) return;
      setConnection(health.reachable ? "connected" : "offline");
      if (health.model) setModel(health.model);
    });
    return () => {
      active = false;
    };
  }, [resolvedHealth, attempt]);

  const ready = state.status === "ready";

  return (
    <div className="term-shell">
      <TerminalHeader
        connection={connection}
        {...(model ? { model } : {})}
        canReset={agent.entries.length > 0 && !agent.busy}
        onNewChat={agent.reset}
        onOpenSettings={() => setSettingsOpen((open) => !open)}
      />
      <WorkbookContextBar
        {...(workbookContext ? { context: workbookContext } : {})}
        state={state.status === "loading" ? "loading" : state.status === "error" ? "error" : "ready"}
      />

      {settingsOpen ? (
        <SettingsPanel healthClient={resolvedHealth} endpoint={`${API_BASE}/v1/chat`} onClose={() => setSettingsOpen(false)} />
      ) : state.status === "error" ? (
        <div className="term-body term-empty">
          <p className="term-empty-title">Excel isn’t connected</p>
          <p className="term-empty-hint">{state.message}</p>
          <button type="button" className="term-btn" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <AgentTranscript
          entries={agent.entries}
          busy={agent.busy}
          onApprove={agent.approve}
          onReject={agent.reject}
          language={agent.language}
          onInsertChart={agent.insertChart}
          turnStartedAt={agent.turnStartedAt}
        />
      )}

      {agent.undoStack.length > 0 && (
        <div className="term-undobar">
          <span>
            {agent.undoStack.length} SheetAgent change{agent.undoStack.length === 1 ? "" : "s"} applied
          </span>
          <button type="button" className="term-btn" disabled={agent.busy} onClick={() => void agent.undoLast()}>
            Undo last
          </button>
        </div>
      )}

      <Composer disabled={!ready || settingsOpen} busy={agent.busy} onSubmit={(value) => void agent.submit(value)} />
    </div>
  );
}
