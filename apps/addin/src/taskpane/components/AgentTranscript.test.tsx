import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentTranscript } from "./AgentTranscript.js";
import type { ExecutionDetail, ExecutionEntry } from "../../app/agent-session.js";

const longCode = Array.from({ length: 80 }, (_, index) => `result_line_${index + 1} = ${index + 1}`).join("\n");

function execution(status: ExecutionEntry["status"], details: readonly ExecutionDetail[]): ExecutionEntry {
  return { kind: "execution", id: "exec-live", title: "Running analysis", status, details, metrics: [] };
}

function step(title: string): ExecutionDetail {
  return { kind: "step", title, status: "done" };
}

function code(attempt: number): ExecutionDetail {
  return { kind: "code", title: `Python attempt ${attempt}`, code: longCode, attempt };
}

function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
}

describe("Stage 28H — live execution timeline", () => {
  it("follows appended planner/retry history, pauses when scrolled up, and resumes at bottom", () => {
    const first = execution("running", [step("Planner round 1"), code(1), step("Python error")]);
    const { rerender } = render(
      <AgentTranscript entries={[first]} busy={true} onApprove={() => undefined} onReject={() => undefined} language="en" />,
    );
    const body = screen.getByLabelText("Agent transcript");
    setScrollMetrics(body, 100, 40);
    body.scrollTop = 60;
    fireEvent.scroll(body);

    const second = execution("running", [...first.details, step("Repair"), code(2), step("Retry")]);
    setScrollMetrics(body, 180, 40);
    rerender(<AgentTranscript entries={[second]} busy={true} onApprove={() => undefined} onReject={() => undefined} language="en" />);
    expect(body.scrollTop).toBe(180);
    expect(screen.getByText(/Attempt 1/)).toBeTruthy();
    expect(screen.getByText(/Attempt 2/)).toBeTruthy();

    body.scrollTop = 30;
    fireEvent.scroll(body);
    const third = execution("running", [...second.details, step("Planner round 3"), code(3), step("Final failure")]);
    setScrollMetrics(body, 260, 40);
    rerender(<AgentTranscript entries={[third]} busy={true} onApprove={() => undefined} onReject={() => undefined} language="en" />);
    expect(body.scrollTop).toBe(30);
    expect(screen.getByText(/Attempt 3/)).toBeTruthy();

    body.scrollTop = 220;
    fireEvent.scroll(body);
    const final = execution("error", [...third.details, step("Analysis failed")]);
    setScrollMetrics(body, 280, 40);
    rerender(<AgentTranscript entries={[final]} busy={false} onApprove={() => undefined} onReject={() => undefined} language="en" />);
    expect(body.scrollTop).toBe(280);
  });

  it("collapses the expanded live panel after completion", () => {
    const running = execution("running", [
      step("Planner round 1"),
      code(1),
      step("Python error"),
      step("Repair"),
      code(2),
      step("Retry"),
      step("Planner round 3"),
      code(3),
    ]);
    const { rerender } = render(
      <AgentTranscript entries={[running]} busy={true} onApprove={() => undefined} onReject={() => undefined} language="en" />,
    );
    const header = screen.getByRole("button", { name: "Running analysis" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    rerender(
      <AgentTranscript
        entries={[execution("done", [...running.details, step("Analysis complete")])]}
        busy={false}
        onApprove={() => undefined}
        onReject={() => undefined}
        language="en"
      />,
    );
    expect(screen.getByRole("button", { name: "Running analysis" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Running analysis" }));
    expect(screen.getByText(/Attempt 1/)).toBeTruthy();
    expect(screen.getByText(/Attempt 2/)).toBeTruthy();
    expect(screen.getByText(/Attempt 3/)).toBeTruthy();
  });
});
