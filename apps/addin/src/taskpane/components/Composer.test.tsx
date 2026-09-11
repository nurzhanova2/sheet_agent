import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";

function setup() {
  const onSubmit = vi.fn();
  render(<Composer disabled={false} busy={false} onSubmit={onSubmit} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  return { onSubmit, input };
}

describe("Composer — slash command palette (Stage 22.1)", () => {
  it("'/' opens the palette with the commands grouped, and no submit happens", () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: "/" } });
    const palette = screen.getByRole("listbox", { name: "Slash commands" });
    expect(palette).toBeInTheDocument();
    expect(screen.getByText("ANALYZE")).toBeInTheDocument();
    expect(screen.getByText("/chart")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("filters as the user types — '/ch' surfaces /chart", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "/ch" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("/chart");
  });

  it("keyboard: ArrowDown moves the highlight, Enter selects (inserts, does not send)", () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // analyze -> summary
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("/summary ");
    // palette has closed (a space now separates the name from the args)
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
  });

  it("Escape closes the palette; it reopens only after the input is cleared", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "/fi" } });
    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "/fi" } });
    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
  });

  it("mouse selection inserts the command", () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: "/su" } });
    fireEvent.mouseDown(screen.getByText("/summary"));
    expect((input as HTMLTextAreaElement).value).toBe("/summary ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("once a command is chosen the arguments are free-form and Enter submits the whole line", () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: "/chart mean Plan by Category" } });
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("/chart mean Plan by Category");
  });

  it("ordinary chat is unaffected — no palette, Enter still sends", () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: "explain the selection" } });
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("explain the selection");
  });
});
