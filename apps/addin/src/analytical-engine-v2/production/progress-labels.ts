import type { AgentActivityKind } from "../../app/agent-session.js";
import type { ExecutionEvent, ExecutionTimings, SandboxDiagnostic, SandboxOutputSummary } from "./execution-progress.js";

export type Lang = "ru" | "en";

const pick = (language: Lang, ru: string, en: string): string => (language === "ru" ? ru : en);

export type ProgressStep =
  | {
      readonly kind: "step";
      readonly activity: AgentActivityKind;
      readonly title: string;
      readonly status: "running" | "done" | "error";
      readonly durationMs?: number;
      readonly detail?: string;
      readonly diagnostics?: readonly SandboxDiagnostic[];
    }
  | { readonly kind: "code"; readonly title: string; readonly code: string; readonly attempt: number }
  | null;

function plural(language: Lang, n: number, ru: readonly [string, string, string], en: readonly [string, string]): string {
  if (language === "en") return `${n} ${n === 1 ? en[0] : en[1]}`;
  const mod100 = n % 100;
  const mod10 = n % 10;
  const form = mod100 >= 11 && mod100 <= 14 ? ru[2] : mod10 === 1 ? ru[0] : mod10 >= 2 && mod10 <= 4 ? ru[1] : ru[2];
  return `${n} ${form}`;
}

export function describeSandboxOutput(produced: SandboxOutputSummary, language: Lang): string {
  const parts: string[] = [];
  if (produced.tables > 0) parts.push(plural(language, produced.tables, ["таблица", "таблицы", "таблиц"], ["table", "tables"]));
  if (produced.groups > 0) parts.push(plural(language, produced.groups, ["группа", "группы", "групп"], ["group", "groups"]));
  if (produced.series > 0) parts.push(plural(language, produced.series, ["ряд", "ряда", "рядов"], ["series", "series"]));
  if (produced.scalars > 0) parts.push(plural(language, produced.scalars, ["значение", "значения", "значений"], ["value", "values"]));
  if (produced.models > 0) parts.push(plural(language, produced.models, ["модель", "модели", "моделей"], ["model", "models"]));
  if (produced.findings > 0) parts.push(plural(language, produced.findings, ["наблюдение", "наблюдения", "наблюдений"], ["observation", "observations"]));
  return parts.join(" · ");
}

export function codeEntryTitle(attempt: number, language: Lang): string {
  if (attempt <= 1) return pick(language, "Python-анализ", "Python analysis");
  return pick(language, `Python · попытка ${attempt}`, `Python · attempt ${attempt}`);
}

export function progressStepFor(event: ExecutionEvent, language: Lang): ProgressStep {
  switch (event.kind) {
    case "workbook_read":
      return {
        kind: "step",
        activity: "reading",
        title: pick(language, `Прочитан диапазон ${event.sheet}!${event.range}`, `Read ${event.sheet}!${event.range}`),
        status: "done",
      };
    case "planning":
      return { kind: "step", activity: "planning", title: pick(language, "Планирую анализ…", "Planning the analysis…"), status: "running" };
    case "tool_call":
      return { kind: "step", activity: "calculating", title: pick(language, "Выполняю расчёты…", "Running calculations…"), status: "running" };
    case "sandbox_required":
      return {
        kind: "step",
        activity: "analyzing",
        title: pick(language, "Анализ требует Python-песочницу", "This analysis needs the Python sandbox"),
        status: "done",
      };
    case "sandbox_ready":
      return {
        kind: "step",
        activity: "analyzing",
        title: pick(language, "Python-песочница готова", "Python sandbox ready"),
        status: "done",
        durationMs: event.durationMs,
      };
    case "sandbox_unavailable":
      return {
        kind: "step",
        activity: "failed",
        title: pick(language, "Python-песочница не запустилась", "The Python sandbox did not start"),
        status: "error",
        ...(event.diagnostics && event.diagnostics.length > 0 ? { diagnostics: event.diagnostics } : {}),
      };
    case "code_generating":
      return {
        kind: "step",
        activity: "writing",
        title:
          event.attempt <= 1
            ? pick(language, "Пишу код анализа…", "Writing the analysis code…")
            : pick(language, "Исправляю код…", "Correcting the code…"),
        status: "running",
      };
    case "code_generated":
      return { kind: "code", title: codeEntryTitle(event.attempt, language), code: event.code, attempt: event.attempt };
    case "code_running":
      return {
        kind: "step",
        activity: "calculating",
        title:
          event.attempt <= 1
            ? pick(language, "Выполняю Python-код…", "Running the Python code…")
            : pick(language, "Выполняю исправленный код…", "Running the corrected code…"),
        status: "running",
      };
    case "code_succeeded": {
      const detail = describeSandboxOutput(event.produced, language);
      return {
        kind: "step",
        activity: "calculating",
        title: pick(language, "Код выполнен", "Code ran"),
        status: "done",
        durationMs: event.durationMs,
        ...(detail !== "" ? { detail } : {}),
      };
    }
    case "code_failed":
      return {
        kind: "step",
        activity: "failed",
        title: pick(language, "Код не выполнился", "The code did not run"),
        status: "error",
        detail: `${event.errorType}: ${event.errorMessage}`,
      };
    case "verifying":
      return { kind: "step", activity: "analyzing", title: pick(language, "Проверяю результат…", "Checking the result…"), status: "running" };
    case "composing":
      return { kind: "step", activity: "writing", title: pick(language, "Формирую ответ…", "Composing the answer…"), status: "running" };
    case "rewriting":
      return { kind: "step", activity: "writing", title: pick(language, "Уточняю формулировку…", "Refining the wording…"), status: "running" };
  }
}

export function completionLabel(elapsed: string, language: Lang): string {
  return pick(language, `Готово за ${elapsed}`, `Done in ${elapsed}`);
}

export function stoppedLabel(elapsed: string, language: Lang): string {
  return pick(language, `Остановлено через ${elapsed}`, `Stopped after ${elapsed}`);
}

export function pythonSummaryLabel(runs: number, language: Lang): string {
  const count = plural(language, runs, ["запуск", "запуска", "запусков"], ["run", "runs"]);
  return pick(language, `Python · ${count}`, `Python · ${count}`);
}

export function executionMetrics(timings: ExecutionTimings, language: Lang): readonly string[] {
  const seconds = (ms: number): string => {
    const text = (ms / 1000).toFixed(1);
    return language === "ru" ? `${text.replace(".", ",")} с` : `${text} s`;
  };
  const rows: string[] = [
    `${pick(language, "Планирование", "Planner")}: ${seconds(timings.plannerMs)}`,
    `${pick(language, "Расчёты", "Tools")}: ${seconds(timings.toolMs)}`,
  ];
  if (timings.codeGenerationMs > 0) rows.push(`${pick(language, "Генерация кода", "Code generation")}: ${seconds(timings.codeGenerationMs)}`);
  if (timings.sandboxMs > 0) rows.push(`Python: ${seconds(timings.sandboxMs)}`);
  rows.push(`${pick(language, "Проверка", "Verification")}: ${seconds(timings.verificationMs)}`);
  rows.push(`${pick(language, "Ответ", "Answer")}: ${seconds(timings.narrationMs)}`);
  rows.push(`${pick(language, "Раундов планировщика", "Planner rounds")}: ${timings.plannerRounds}`);
  rows.push(`${pick(language, "Обращений к модели", "LLM calls")}: ${timings.llmCallCount}`);
  rows.push(`${pick(language, "Вызовов инструментов", "Tool calls")}: ${timings.toolCallCount}`);
  rows.push(`${pick(language, "Запусков Python", "Python runs")}: ${timings.pythonExecutionCount}`);
  return rows;
}
