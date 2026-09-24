import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionSummary } from "./ExecutionSummary.js";
import type { ExecutionEntry } from "../../app/agent-session.js";

const CODE = 'import numpy as np\nRESULT = {"scalars": {"n": 1.0}}';

const entry: ExecutionEntry = {
  kind: "execution",
  id: "exec_1",
  title: "Готово за 16,5 с",
  subtitle: "Python · 2 запуска",
  status: "done",
  details: [
    { kind: "step", title: "Прочитан диапазон Баланс!B2:Q25", status: "done" },
    { kind: "step", title: "Планирую анализ…", status: "done" },
    { kind: "code", title: "Python-анализ", code: CODE, attempt: 1 },
    { kind: "step", title: "Код не выполнился", status: "error", detail: "NameError: name 'x' is not defined" },
    {
      kind: "step",
      title: "Python-песочница не запустилась",
      status: "error",
      diagnostics: [
        { label: "Причина", value: "Unable to load package numpy" },
        { label: "Ресурс", value: "numpy-2.4.6.whl" },
      ],
    },
  ],
  metrics: ["Планирование: 14,1 с", "Обращений к модели: 1"],
};

describe("Stage 27.7 §10/§11 — the collapsed execution line", () => {
  it("shows only the summary until it is opened", () => {
    render(<ExecutionSummary entry={entry} language="ru" />);
    expect(screen.getByText("Готово за 16,5 с")).toBeTruthy();
    expect(screen.getByText("· Python · 2 запуска")).toBeTruthy();
    expect(screen.queryByText("Планирую анализ…")).toBeNull();
    expect(document.querySelector("code")).toBeNull();
  });

  it("reveals the steps, the code and the timings when opened", () => {
    render(<ExecutionSummary entry={entry} language="ru" />);
    const head = screen.getByRole("button");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Прочитан диапазон Баланс!B2:Q25")).toBeTruthy();
    expect(screen.getByText("Планирую анализ…")).toBeTruthy();
    expect(document.querySelector("code")?.textContent).toBe(CODE);
    expect(screen.getByText("Планирование: 14,1 с")).toBeTruthy();
  });

  it("shows the failure reason and the asset that caused it", () => {
    render(<ExecutionSummary entry={entry} language="ru" />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("NameError: name 'x' is not defined")).toBeTruthy();
    expect(screen.getByText("Unable to load package numpy")).toBeTruthy();
    expect(screen.getByText("numpy-2.4.6.whl")).toBeTruthy();
  });

  it("closes again", () => {
    render(<ExecutionSummary entry={entry} language="ru" />);
    const head = screen.getByRole("button");
    fireEvent.click(head);
    fireEvent.click(head);
    expect(screen.queryByText("Планирую анализ…")).toBeNull();
  });
  it("keeps a running execution panel open", () => {
    render(<ExecutionSummary entry={{ ...entry, status: "running" }} language="ru" />);
    expect(screen.getAllByRole("button")[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".term-exec-panel-head")?.textContent).toBeTruthy();
  });

  it("offers the real generated code through copy and expand controls", () => {
    render(<ExecutionSummary entry={entry} language="en" />);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Output and additional details" }));
    expect(document.querySelector(".term-exec-metrics")?.textContent).toBeTruthy();
  });
});
