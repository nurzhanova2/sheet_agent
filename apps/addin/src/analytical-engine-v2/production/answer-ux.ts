import type { EngineAnalysis, EngineTerminationReason } from "../types.js";

export type Lang = "ru" | "en";

const pick = (language: Lang, ru: string, en: string): string => (language === "ru" ? ru : en);

const NEWLINE = String.fromCharCode(10);

/**
 * §20 — the stages a ~30-second turn shows. Deliberately few, deliberately
 * vague about mechanism: no tool names (§20), no percentages (§20), and no
 * claim about what it has found. They describe the PHASE, and the phase is the
 * one thing the engine always knows.
 */
//
// Stage 27.2A §37 adds three more, for the iterative loop. The rule is
// unchanged and matters more here, not less: an iterative turn KNOWS it hit a
// NameError, and that is exactly the thing a reader must never be shown. They
// are told the analysis is being checked or adjusted, which is true, and the
// NameError goes to `/debug analytical-agent`.
export type ProgressPhase = "reading" | "inspecting" | "analysing" | "adjusting" | "verifying" | "composing";

export function progressLabel(phase: ProgressPhase, language: Lang): string {
  switch (phase) {
    case "reading":
      return pick(language, "Читаю данные…", "Reading the data…");
    case "inspecting":
      return pick(language, "Изучаю данные…", "Looking at the data…");
    case "analysing":
      return pick(language, "Анализирую данные…", "Analysing the data…");
    case "adjusting":
      // What a reader sees INSTEAD of a Python error.
      return pick(language, "Уточняю расчёт…", "Refining the calculation…");
    case "verifying":
      return pick(language, "Проверяю результат…", "Checking the result…");
    case "composing":
      return pick(language, "Формирую ответ…", "Composing the answer…");
  }
}

/**
 * §37 — the phase an agent action puts the turn in.
 *
 * The mapping is deliberately lossy. An INSPECT and a failed EXECUTE_CODE are
 * very different events internally and the reader is told two calm, true
 * things about them; nothing here can leak an exception type, because nothing
 * here receives one.
 */
export function phaseForAgentAction(action: "INSPECT" | "EXECUTE_CODE" | "CALL_TOOL" | "CLARIFY" | "COMPLETE" | "CONTROL", failed: boolean): ProgressPhase {
  if (action === "COMPLETE") return "verifying";
  if (action === "INSPECT") return "inspecting";
  if (failed) return "adjusting";
  return "analysing";
}

/**
 * §32 — an internal failure, as a category a person can act on.
 *
 * Each of these says what happened to THEIR request and what they can do next.
 * None of them names an enum, a code, a tool or a result id; several of the
 * engine's reasons deliberately collapse into one message, because the
 * difference between "the planner exceeded its rounds" and "it exceeded its
 * tool calls" is not a difference the person can act on.
 */
export interface SandboxFailureContext {
  readonly attempts: number;
  readonly objective?: string;
  readonly code?: string;
}

function attemptsPhrase(attempts: number, language: Lang): string {
  if (language === "en") return attempts === 1 ? "one attempt" : `${attempts} attempts`;
  const mod100 = attempts % 100;
  const mod10 = attempts % 10;
  const word = mod100 >= 11 && mod100 <= 14 ? "попыток" : mod10 === 1 ? "попытки" : mod10 >= 2 && mod10 <= 4 ? "попыток" : "попыток";
  return `${attempts} ${word}`;
}

export function sandboxFailureMessage(context: SandboxFailureContext, language: Lang): string {
  const objective = (context.objective ?? "").trim();
  const headline =
    objective === ""
      ? pick(language, "Не удалось выполнить запрошенный расчёт.", "I could not carry out the calculation you asked for.")
      : pick(language, `Не удалось выполнить расчёт: ${objective}.`, `I could not carry out this calculation: ${objective}.`);
  if (context.code === "SANDBOX_UNAVAILABLE") {
    return [
      headline,
      pick(
        language,
        "Python-песочница не запустилась в этой сборке, поэтому расчёт выполнить нечем. Подменять его другим показателем я не стану.",
        "The Python sandbox did not start in this build, so there is nothing to run the calculation with. I will not substitute a different measure for it.",
      ),
    ].join(NEWLINE + NEWLINE);
  }
  return [
    headline,
    pick(
      language,
      `Python-анализ не выполнился после ${attemptsPhrase(context.attempts, language)}, поэтому я не буду подменять его другим показателем. Попробуйте сузить вопрос или сформулировать расчёт иначе.`,
      `The Python analysis did not run after ${attemptsPhrase(context.attempts, language)}, so I will not substitute a different measure for it. Try narrowing the question or describing the calculation differently.`,
    ),
  ].join(NEWLINE + NEWLINE);
}

export function failureMessage(reason: EngineTerminationReason, language: Lang): string {
  switch (reason) {
    case "planner_rounds":
    case "tool_calls":
    case "workbook_reads":
      return pick(
        language,
        "Не удалось завершить этот анализ за один ход. Попробуйте сузить вопрос — например, до одного показателя или одного периода.",
        "I couldn't finish this analysis in a single turn. Try narrowing the question — to one metric, or one period.",
      );
    case "repeated_invalid_call":
    case "invalid_decision":
    case "model_error":
      return pick(
        language,
        "Не удалось построить надёжный план ответа. Переформулируйте вопрос или задайте его проще.",
        "I couldn't work out a reliable way to answer that. Try rephrasing it, or asking it more simply.",
      );
    // Stage 27 §5/§67 — the requested analysis specifically. Kept apart from
    // every other failure because the honest message is different: this one
    // says the analysis could not be done, and the alternative it offers is
    // something the user chooses — never something the agent substitutes.
    case "analysis_unavailable":
      return pick(
        language,
        "Не удалось выполнить именно этот анализ. Подменять его другим я не стану — скажите, если стоит попробовать иначе, или сузьте вопрос.",
        "I couldn't carry out that specific analysis, and I won't substitute a different one for it. Tell me if it's worth trying another way, or narrow the question.",
      );
    default:
      return pick(language, "Не удалось выполнить этот анализ.", "I wasn't able to complete that analysis.");
  }
}

/**
 * §32 — the reference failures, which ARE worth separating because each one has
 * a different next step for the person.
 *
 * These are reached from a TERMINAL tool error only. In normal operation the
 * planner sees the typed error and recovers from it; the user sees one of these
 * only when the turn ends on it.
 */
export type ReferenceProblem = "stale" | "missing" | "incompatible" | "protocol";

export function referenceMessage(problem: ReferenceProblem, language: Lang): string {
  switch (problem) {
    case "stale":
      return pick(
        language,
        "Исходные данные изменились с момента прошлого расчёта, поэтому прежний результат больше не подходит. Повторите вопрос — я пересчитаю его на текущих данных.",
        "The source data changed since the last calculation, so the earlier result no longer applies. Ask again and I'll recompute it on the current data.",
      );
    case "missing":
      return pick(
        language,
        "Не удалось понять, о каком показателе идёт речь. Назовите его, пожалуйста.",
        "I couldn't tell which indicator you mean. Could you name it?",
      );
    case "incompatible":
      return pick(
        language,
        "То, о чём шла речь раньше, не подходит для этого вопроса. Уточните, что именно нужно проанализировать.",
        "What we were discussing doesn't fit this question. Could you say what exactly to analyse?",
      );
    case "protocol":
      // §32 — MULTIPLE_DECISIONS and its relatives recover internally. A person
      // sees this only if recovery itself ran out, and then it is just a retry.
      return pick(
        language,
        "Что-то пошло не так при подготовке ответа. Повторите запрос, пожалуйста.",
        "Something went wrong while preparing the answer. Please try that again.",
      );
  }
}

/**
 * §31 — narration failed, the ANALYSIS did not.
 *
 * `gateNarration` already substitutes a deterministic rendering, so by the time
 * a turn reaches the task pane there is always a body. This is the line that
 * goes with it — an honest note that the numbers are the computed ones, shown
 * only when the narrator was actually bypassed.
 */
export function fallbackNote(language: Lang): string {
  return pick(
    language,
    "_(ответ собран напрямую из рассчитанных значений)_",
    "_(answer assembled directly from the computed values)_",
  );
}

/** §17 — the provenance line under a workbook-derived answer. */
export function provenanceLine(sheetName: string, sourceRange: string, language: Lang): string {
  const local = sourceRange.includes("!") ? sourceRange.slice(sourceRange.indexOf("!") + 1) : sourceRange;
  return pick(language, `_Источник: ${sheetName}!${local}_`, `_Source: ${sheetName}!${local}_`);
}

/**
 * §18 — the last gate before a body reaches the transcript.
 *
 * Stage 25 shipped a `containsForbiddenLeak` check for the same reason, and
 * this is its V2 equivalent with the V2 vocabulary: result ids, decision kinds,
 * tool names in their dotted form, and the typed error codes. If any of them
 * survives into an answer, something upstream built a user string out of an
 * internal one, and the answer is replaced rather than shown.
 */
const LEAK_RE =
  /\bresult_\d+\b|\bo\d+\b(?=[^\w]|$)|"kind"\s*:|primaryResultRef|supportingResultRefs|outputBindings|\b(?:NO_PREVIOUS_RESULT|INCOMPATIBLE_REFERENCE|INCOMPATIBLE_INPUT|STALE_REFERENCE|MULTIPLE_DECISIONS|INVALID_ARGUMENT|UNKNOWN_METRIC|UNKNOWN_PERIOD|MISSING_FIELD|BAD_CONTAINER|MISPLACED_ARGUMENTS|INCONSISTENT_PLAN|PRIMARY_BINDING_MISMATCH)\b|\b(?:set|metric|period|series|change|aggregate|derive|event|reference|schema|value|join)\.[a-z_]+\(?/;

export function containsInternalLeak(text: string): boolean {
  return LEAK_RE.test(text);
}

/** §18 — a body that leaked is not shown; this is what replaces it. */
export function leakReplacement(analysis: EngineAnalysis, language: Lang): string {
  const metrics = analysis.primary.metricKeys.slice(0, 5).join(", ");
  return metrics
    ? pick(language, `Расчёт выполнен по показателям: ${metrics}. Уточните, пожалуйста, что именно показать.`, `The calculation covers: ${metrics}. Could you say what exactly to show?`)
    : pick(language, "Расчёт выполнен. Уточните, пожалуйста, что именно показать.", "The calculation is done. Could you say what exactly to show?");
}
