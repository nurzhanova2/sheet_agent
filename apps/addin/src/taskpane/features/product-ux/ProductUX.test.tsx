import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProductUXPanel, type ProductUXChange } from "./ProductUX.js";

const change: ProductUXChange = { id: "cs-1", description: "Normalize revenue", risk: "medium", affectedRange: "Sales!A1:C10", summary: "10 cells will change" };

describe("Product UX controls", () => {
  it("offers selection-aware quick actions and emits activity", () => {
    const onQuickAction = vi.fn();
    render(<ProductUXPanel selectionLabel="Sales!A1:C10" onQuickAction={onQuickAction} />);
    expect(screen.getByRole("region", { name: "Quick actions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Analyze selection" }));
    expect(onQuickAction).toHaveBeenCalledWith("analyze");
  });

  it("makes approval distinct from chat and supports reject", () => {
    const onApprove = vi.fn(); const onReject = vi.fn();
    render(<ProductUXPanel pendingChange={change} onApprove={onApprove} onReject={onReject} />);
    expect(screen.getByRole("region", { name: "Change preview" })).toBeInTheDocument();
    expect(screen.getByText("10 cells will change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve change" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject change" }));
    expect(onApprove).toHaveBeenCalledWith("cs-1"); expect(onReject).toHaveBeenCalledWith("cs-1");
  });

  it("renders accessible activity, sessions, settings and undo history", () => {
    const onUndo = vi.fn();
    render(<ProductUXPanel activities={[{ id: "a1", label: "Read selection", status: "done" }]} sessions={[{ id: "s1", title: "Revenue review" }]} history={[{ id: "h1", description: "Format header" }]} onUndo={onUndo} />);
    expect(screen.getByRole("list", { name: "Activity timeline" })).toBeInTheDocument();
    expect(screen.getByText("Revenue review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo Format header" }));
    expect(onUndo).toHaveBeenCalledWith("h1");
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("region", { name: "Settings" })).toBeInTheDocument();
  });
});
