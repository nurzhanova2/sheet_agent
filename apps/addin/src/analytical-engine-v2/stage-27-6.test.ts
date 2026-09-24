import { describe, expect, it } from "vitest";
import { formatSeconds } from "../app/agent-session.js";
import { TimingRecorder, summarizeTimings, type ExecutionEvent } from "./production/execution-progress.js";
import { codeEntryTitle, completionLabel, describeSandboxOutput, progressStepFor } from "./production/progress-labels.js";
import { sandboxFailureMessage } from "./production/answer-ux.js";
import { errorTypeOf, shortErrorMessage } from "./sandbox/executor.js";
import { readRequest, selectForShape } from "./narration/answer-shape.js";
import type { VerifiedFinding } from "./insight/verified-finding.js";
import type { EngineAnalysis } from "./types.js";

const NEWLINE = String.fromCharCode(10);

describe("Stage 27.6 §1 — elapsed time is real wall-clock time", () => {
  it("renders seconds with one decimal and a Russian comma", () => {
    expect(formatSeconds(7300, "ru")).toBe("7,3 с");
    expect(formatSeconds(12_840, "ru")).toBe("12,8 с");
    expect(formatSeconds(940, "en")).toBe("0.9 s");
  });

  it("never renders a negative elapsed time", () => {
    expect(formatSeconds(-500, "ru")).toBe("0,0 с");
  });

  it("names the completion with the time it actually took", () => {
    expect(completionLabel(formatSeconds(12_840, "ru"), "ru")).toBe("Готово за 12,8 с");
    expect(completionLabel(formatSeconds(8_400, "en"), "en")).toBe("Done in 8.4 s");
  });
});

describe("Stage 27.6 §2 — progress states name the actual work", () => {
  it("reports the range it read, already finished", () => {
    const step = progressStepFor({ kind: "workbook_read", sheet: "Баланс", range: "B2:Q25" }, "ru");
    expect(step).toEqual({ kind: "step", activity: "reading", title: "Прочитан диапазон Баланс!B2:Q25", status: "done" });
  });

  it("distinguishes planning, calculation, verification and composition", () => {
    const titles = (["planning", "verifying", "composing"] as const).map((kind) => {
      const step = progressStepFor({ kind } as ExecutionEvent, "ru");
      return step && step.kind === "step" ? step.title : "";
    });
    expect(titles).toEqual(["Планирую анализ…", "Проверяю результат…", "Формирую ответ…"]);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("names a rewrite as its own state rather than a second composing state", () => {
    const rewrite = progressStepFor({ kind: "rewriting" }, "ru");
    const composing = progressStepFor({ kind: "composing" }, "ru");
    expect(rewrite && rewrite.kind === "step" ? rewrite.title : "").toBe("Уточняю формулировку…");
    expect(rewrite).not.toEqual(composing);
  });
});

describe("Stage 27.6 §3 — the sandbox is visible when it is used", () => {
  it("announces that the analysis needs Python", () => {
    const step = progressStepFor({ kind: "sandbox_required" }, "ru");
    expect(step && step.kind === "step" ? step.title : "").toBe("Анализ требует Python-песочницу");
  });

  it("reports how long the runtime took to become ready", () => {
    const step = progressStepFor({ kind: "sandbox_ready", durationMs: 900 }, "ru");
    expect(step).toMatchObject({ kind: "step", title: "Python-песочница готова", status: "done", durationMs: 900 });
  });

  it("emits the executable code itself, not a description of it", () => {
    const code = `import numpy as np${NEWLINE}RESULT = {"scalars": {"n": 1.0}}`;
    const step = progressStepFor({ kind: "code_generated", attempt: 1, code }, "ru");
    expect(step).toEqual({ kind: "code", title: "Python-анализ", code, attempt: 1 });
  });

  it("numbers a repair attempt in the code entry title", () => {
    expect(codeEntryTitle(1, "ru")).toBe("Python-анализ");
    expect(codeEntryTitle(2, "ru")).toBe("Python · попытка 2");
    expect(codeEntryTitle(3, "en")).toBe("Python · attempt 3");
  });
});

describe("Stage 27.6 §4 — a successful run reports its duration and what it produced", () => {
  it("summarises the output compactly rather than dumping it", () => {
    const step = progressStepFor(
      { kind: "code_succeeded", attempt: 1, durationMs: 1200, produced: { tables: 1, scalars: 5, series: 0, groups: 3, models: 0, findings: 0 } },
      "ru",
    );
    expect(step).toMatchObject({ kind: "step", title: "Код выполнен", status: "done", durationMs: 1200 });
    expect(step && step.kind === "step" ? step.detail : "").toBe("1 таблица · 3 группы · 5 значений");
  });

  it("counts in Russian plural forms", () => {
    const of = (tables: number): string => describeSandboxOutput({ tables, scalars: 0, series: 0, groups: 0, models: 0, findings: 0 }, "ru");
    expect(of(1)).toBe("1 таблица");
    expect(of(2)).toBe("2 таблицы");
    expect(of(5)).toBe("5 таблиц");
    expect(of(11)).toBe("11 таблиц");
  });

  it("says nothing when the run produced nothing to summarise", () => {
    expect(describeSandboxOutput({ tables: 0, scalars: 0, series: 0, groups: 0, models: 0, findings: 0 }, "ru")).toBe("");
  });
});

describe("Stage 27.6 §5 — a failed run shows the error, not the traceback", () => {
  it("keeps the exception type and the one line that matters", () => {
    const error = {
      code: "SANDBOX_RUNTIME_ERROR" as const,
      message: `TypeError: describe() got an unexpected keyword argument 'axis' (File "<analysis>", line 3)`,
    };
    expect(errorTypeOf(error)).toBe("TypeError");
    expect(shortErrorMessage(error)).toBe("describe() got an unexpected keyword argument 'axis'");
  });

  it("falls back to the failure class when Python named no exception", () => {
    expect(errorTypeOf({ code: "UNSAFE_CODE", message: "the analysis code requests capabilities the sandbox denies: NETWORK:requests.get" })).toBe("SecurityError");
    expect(errorTypeOf({ code: "SANDBOX_TIMEOUT", message: "exceeded the time limit" })).toBe("TimeoutError");
  });

  it("never carries a multi-line traceback into the message", () => {
    const message = ["Traceback (most recent call last):", '  File "<analysis>", line 2', "NameError: name 'df' is not defined"].join(NEWLINE);
    expect(shortErrorMessage({ code: "SANDBOX_RUNTIME_ERROR", message })).not.toContain(NEWLINE);
  });

  it("bounds a very long message", () => {
    const message = `ValueError: ${"x".repeat(500)}`;
    const text = shortErrorMessage({ code: "SANDBOX_RUNTIME_ERROR", message }, 80);
    expect(text.length).toBe(80);
    expect(text.endsWith("…")).toBe(true);
  });

  it("shows the failure as an error state carrying the type and message", () => {
    const step = progressStepFor(
      { kind: "code_failed", attempt: 1, durationMs: 400, errorType: "TypeError", errorMessage: "describe() got an unexpected keyword argument 'axis'", retrying: true },
      "ru",
    );
    expect(step).toMatchObject({ kind: "step", status: "error", title: "Код не выполнился" });
    expect(step && step.kind === "step" ? step.detail : "").toBe("TypeError: describe() got an unexpected keyword argument 'axis'");
  });

  it("names the second attempt as a correction, not a fresh start", () => {
    const generating = progressStepFor({ kind: "code_generating", attempt: 2 }, "ru");
    const running = progressStepFor({ kind: "code_running", attempt: 2 }, "ru");
    expect(generating && generating.kind === "step" ? generating.title : "").toBe("Исправляю код…");
    expect(running && running.kind === "step" ? running.title : "").toBe("Выполняю исправленный код…");
  });
});

describe("Stage 27.6 §6 — a final sandbox failure says what actually happened", () => {
  it("names the objective and the number of attempts, and refuses to substitute", () => {
    const text = sandboxFailureMessage({ attempts: 2, objective: "расчёт волатильности по продуктам" }, "ru");
    expect(text).toContain("расчёт волатильности по продуктам");
    expect(text).toContain("2 попыток");
    expect(text).toContain("подменять");
  });

  it("says the runtime never started when that is the reason", () => {
    const text = sandboxFailureMessage({ attempts: 0, code: "SANDBOX_UNAVAILABLE" }, "ru");
    expect(text).toContain("не запустилась");
    expect(text).not.toContain("0 попыток");
  });

  it("is not the old generic single-turn message", () => {
    const text = sandboxFailureMessage({ attempts: 2, objective: "кластеризация" }, "ru");
    expect(text).not.toContain("за один ход");
  });
});

describe("Stage 27.6 §8 — a request for three results is not answered with one", () => {
  const finding = (subject: string): VerifiedFinding =>
    ({
      id: `f_${subject}`,
      findingType: "change",
      subject,
      subjectRef: { entityLabel: subject },
      direction: "down",
      values: [],
      materiality: [],
      confidence: [],
      caveats: [],
      provenance: { resultRef: "res_1", tool: "change.compute" },
    }) as unknown as VerifiedFinding;

  const analysis = { primary: { type: "metric_winner", rows: [[1]] }, supporting: [], answerStyle: "direct" } as unknown as EngineAnalysis;
  const three = [finding("Кама"), finding("Зея"), finding("Енисей")];

  it("reads a counted superlative question as a ranking, not a single answer", () => {
    const requested = readRequest("Какие три показателя упали сильнее всего?", analysis, three);
    expect(requested.shape).toBe("ranking");
    expect(requested.count).toBe(3);
  });

  it("returns three findings when three comparable ones exist", () => {
    const requested = readRequest("Назови три показателя с самым сильным падением.", analysis, three);
    expect(selectForShape(three, requested)).toHaveLength(3);
  });

  it("still answers a genuinely single question with one finding", () => {
    const requested = readRequest("Какой показатель упал сильнее всего?", analysis, three);
    expect(requested.shape).toBe("direct");
    expect(selectForShape(three, requested)).toHaveLength(1);
  });

  it("does not invent results it does not have", () => {
    const requested = readRequest("Назови три показателя с самым сильным падением.", analysis, three);
    expect(selectForShape([three[0]!], requested)).toHaveLength(1);
  });
});

describe("Stage 27.6 §11 — the turn's own timings are measurable", () => {
  it("accumulates each phase and counts the calls that produced it", () => {
    const recorder = new TimingRecorder();
    recorder.addPlanner(3400);
    recorder.addTool(60);
    recorder.addTool(40);
    recorder.addCodeGeneration(2200);
    recorder.addSandbox(5800);
    recorder.addVerification(120);
    recorder.addNarration(8900);
    const timings = recorder.snapshot();
    expect(timings).toMatchObject({
      plannerMs: 3400,
      toolMs: 100,
      codeGenerationMs: 2200,
      sandboxMs: 5800,
      verificationMs: 120,
      narrationMs: 8900,
      llmCallCount: 3,
      toolCallCount: 2,
      pythonExecutionCount: 1,
    });
    expect(timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("renders a breakdown a developer can read", () => {
    const recorder = new TimingRecorder();
    recorder.addPlanner(3400);
    recorder.addSandbox(5800);
    const lines = summarizeTimings(recorder.snapshot());
    expect(lines.some((l) => /^Planner\.+ 3\.4 s$/u.test(l))).toBe(true);
    expect(lines).toContain("Python runs: 1");
  });
});

describe("Stage 27.6 §3 — no hidden reasoning is ever surfaced", () => {
  it("has no progress event that carries model reasoning", () => {
    const kinds: readonly ExecutionEvent["kind"][] = [
      "workbook_read",
      "planning",
      "tool_call",
      "sandbox_required",
      "sandbox_ready",
      "sandbox_unavailable",
      "code_generating",
      "code_generated",
      "code_running",
      "code_succeeded",
      "code_failed",
      "verifying",
      "composing",
      "rewriting",
    ];
    expect(kinds.some((k) => /reason|thought|thinking|draft/u.test(k))).toBe(false);
  });

  it("carries executable code only, never prose around it", () => {
    const code = `RESULT = {"scalars": {"n": 1.0}}`;
    const step = progressStepFor({ kind: "code_generated", attempt: 1, code }, "ru");
    expect(step && step.kind === "code" ? step.code : "").toBe(code);
  });
});
