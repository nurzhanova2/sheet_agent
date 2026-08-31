import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkbookContext } from "@sheet-agent/application";
import { App } from "./App.js";

const readyContext = {
  host: "Excel" as unknown as Office.HostType,
  platform: "PC" as unknown as Office.PlatformType,
  capabilities: { excelApi12: true, excelApi13: true, excelApi14: true, sharedRuntime12: false },
};

describe("Task Pane shell", () => {
  it("shows a ready composer after Excel initializes", async () => {
    render(<App bootstrap={vi.fn().mockResolvedValue(readyContext)} />);
    expect(screen.getByText("Connecting to Excel")).toBeInTheDocument();
    expect(await screen.findByText("What can I help with?")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("shows the active sheet, address and dimensions from bounded workbook context", async () => {
    const connectContext = vi.fn(async (listener: (context: WorkbookContext) => void) => {
      listener({ sheetName: "Sales", selection: { address: "Sales!D4:E5", rowCount: 2, columnCount: 2 } });
      return () => undefined;
    });
    render(<App bootstrap={vi.fn().mockResolvedValue(readyContext)} connectContext={connectContext} />);
    expect(await screen.findByText("Sales!D4:E5")).toBeInTheDocument();
    expect(screen.getByText("Sales · 2 × 2")).toBeInTheDocument();
  });

  it("keeps send disabled for whitespace and enables it for a prompt", async () => {
    render(<App bootstrap={vi.fn().mockResolvedValue(readyContext)} />);
    const input = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "Analyze this table" } });
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("shows a recoverable error and retries initialization", async () => {
    const bootstrap = vi.fn()
      .mockRejectedValueOnce(new Error("Excel is unavailable"))
      .mockResolvedValueOnce(readyContext);
    render(<App bootstrap={bootstrap} />);
    expect(await screen.findByText("Excel isn’t connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("What can I help with?")).toBeInTheDocument();
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });
});
