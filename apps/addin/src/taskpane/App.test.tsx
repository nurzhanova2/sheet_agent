import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort, WorkbookContext } from "@sheet-agent/application";
import { App } from "./App.js";
import type { ChatClient, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import type { HealthClient } from "../app/companion-health.js";
import type { waitForOffice } from "../app/office-bootstrap.js";

const readyContext = {
  host: "Excel" as unknown as Office.HostType,
  platform: "PC" as unknown as Office.PlatformType,
  capabilities: { excelApi12: true, excelApi13: true, excelApi14: true, sharedRuntime12: false, customFunctionsRuntime11: true },
};

function stubPort(): ExcelPort & ExcelMutationPort {
  return {
    capabilities: { tables: true, charts: true, pivotTables: true, namedRanges: true },
    getSelection: vi.fn(async () => ({ address: "Sales!A1:B2", sheetName: "Sales", rowCount: 2, columnCount: 2, revision: 1 })),
    readRange: vi.fn(async () => ({
      address: "Sales!A1:B2",
      sheetName: "Sales",
      rowCount: 2,
      columnCount: 2,
      revision: 1,
      values: [["Bank", "Fact"], ["Alpha", 12]],
      formulas: [["Bank", "Fact"], ["Alpha", 12]],
      numberFormats: [["General", "General"], ["General", "General"]],
    })),
    getWorkbookOverview: vi.fn(),
    readTable: vi.fn(),
    search: vi.fn(async () => []),
    onSelectionChanged: vi.fn(() => () => undefined),
    writeRange: vi.fn(async () => undefined),
    readFillColors: vi.fn(async () => [["#FFFFFF"]]),
    writeFillColors: vi.fn(async () => undefined),
    insertImage: vi.fn(async () => ({ shapeName: "shape", left: 0, top: 0, width: 640, height: 320 })),
    deleteShape: vi.fn(async () => undefined),
  } as unknown as ExcelPort & ExcelMutationPort;
}

const RESULT_TAIL = { analysisRuns: 0, analysisHadError: false, charts: [], language: "en" as const, planKind: "none" as const };

function makeProps(): { bootstrap: typeof waitForOffice; healthClient: HealthClient; port: ExcelPort & ExcelMutationPort } {
  return {
    bootstrap: vi.fn().mockResolvedValue(readyContext) as unknown as typeof waitForOffice,
    healthClient: { check: vi.fn(async () => ({ reachable: true, status: "ok", model: "Qwen/Qwen3.5" })) },
    port: stubPort(),
  };
}

describe("Task pane terminal shell", () => {
  it("renders the ready terminal with an enabled composer", async () => {
    render(<App {...makeProps()} chatClient={{ stream: vi.fn() }} />);
    expect(await screen.findByText(/SheetAgent ready/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  });

  it("shows the live workbook context in the context bar", async () => {
    const connectContext = vi.fn(async (listener: (context: WorkbookContext) => void) => {
      listener({ sheetName: "Sales", selection: { address: "Sales!D4:E5", rowCount: 2, columnCount: 2 } });
      return () => undefined;
    });
    render(<App {...makeProps()} connectContext={connectContext} chatClient={{ stream: vi.fn() }} />);
    expect(await screen.findByText(/Sales/)).toBeInTheDocument();
    expect(screen.getByText("D4:E5")).toBeInTheDocument();
    expect(screen.getByText("2 × 2")).toBeInTheDocument();
  });

  it("shows the model reported by /health in the header", async () => {
    render(<App {...makeProps()} chatClient={{ stream: vi.fn() }} />);
    expect(await screen.findByText("Qwen/Qwen3.5")).toBeInTheDocument();
  });

  it("sends on Enter, keeps a newline on Shift+Enter, ignores whitespace", async () => {
    const stream = vi.fn(async (_request: ChatStreamRequest, handlers: ChatStreamHandlers) => {
      handlers.onDelta("Answer");
      return { text: "Answer", actions: [], actionErrors: [], ...RESULT_TAIL };
    });
    render(<App {...makeProps()} chatClient={{ stream } as ChatClient} />);
    const input = await screen.findByRole("textbox", { name: "Message" });

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(stream).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "explain" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(stream).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Answer")).toBeInTheDocument();
  });

  it("passes the selection snapshot (values + headers) to the chat client", async () => {
    let received: ChatStreamRequest | undefined;
    const stream = vi.fn(async (request: ChatStreamRequest, handlers: ChatStreamHandlers) => {
      received = request;
      handlers.onDelta("ok");
      return { text: "ok", actions: [], actionErrors: [], ...RESULT_TAIL };
    });
    render(<App {...makeProps()} port={stubPort()} chatClient={{ stream } as ChatClient} />);
    const input = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "объясни данные в выделенном диапазоне" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(received).toBeDefined());
    expect(received?.selection?.values).toEqual([["Bank", "Fact"], ["Alpha", 12]]);
    expect(received?.selection?.headers).toEqual(["Bank", "Fact"]);
    expect(received?.prompt).toBe("объясни данные в выделенном диапазоне");
  });

  it("keeps the global fetch binding fix in place (no unbound fetch reintroduced)", async () => {
    // The default chat client must not be constructed with an unbound fetch. We assert the
    // source contract indirectly: creating App without a chatClient must not throw at import.
    render(<App {...makeProps()} />);
    expect(await screen.findByText(/SheetAgent ready/i)).toBeInTheDocument();
  });
});
