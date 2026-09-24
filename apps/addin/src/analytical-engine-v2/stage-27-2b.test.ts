import { describe, expect, it } from "vitest";
import {
  buildFindingSubject,
  entityAxisFromLabels,
  groundFindings,
  groundingOf,
  groundingStats,
  isReadableLabel,
  subjectLabel,
  NO_ENTITY_AXIS,
  type FindingSubject,
  type GroundingContext,
} from "./insight/finding-subject.js";
import { buildRewriteGuidance, evaluateAnswer } from "./narration/answer-evaluator.js";
import type { VerifiedFinding } from "./insight/verified-finding.js";

const NEWLINE = String.fromCharCode(10);
const IRREGULAR_WHITESPACE = new RegExp("[" + String.fromCharCode(0x00a0, 0x202f) + "]", "u");
const RIVERS = ["Ангара", "Кама", "Нева", "Обь", "Мезень"];
const PRODUCTS = entityAxisFromLabels(RIVERS, "entity");
const METRICS = entityAxisFromLabels(["Активы", "Обязательства", "Капитал"], "metric");

const WITH_ENTITIES: GroundingContext = { axis: PRODUCTS, hasPeriodAxis: true };
const WITH_METRICS: GroundingContext = { axis: METRICS, hasPeriodAxis: true };
const NO_AXIS: GroundingContext = { axis: NO_ENTITY_AXIS, hasPeriodAxis: true };

function finding(over: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    id: "f1",
    findingType: "trend",
    subject: "Ангара",
    direction: "down",
    values: [],
    materiality: [],
    confidence: [],
    caveats: [],
    provenance: {
      resultRef: "result_1" as VerifiedFinding["provenance"]["resultRef"],
      tool: "sandbox.analysis",
      sourceRange: "S!A1:C4",
      sourceVersion: "v1",
      periods: [],
    },
    statement: "",
    subjectRef: { scope: "entity", entityLabel: "Ангара", metric: "наклон" },
    ...over,
  };
}

describe("Stage 27.2B §4/§5 — a finding knows who it is about", () => {
  it("accepts a label that is a member of the table's entity axis", () => {
    expect(groundingOf({ scope: "entity", entityLabel: "Ангара" }, WITH_ENTITIES)).toEqual([]);
  });

  it("rejects the common noun that reached a reader", () => {
    expect(groundingOf({ scope: "entity", entityLabel: "продукт" }, WITH_ENTITIES)).toEqual(["GENERIC_SUBJECT_LABEL"]);
    expect(groundingOf({ scope: "entity", entityLabel: "показатель" }, WITH_ENTITIES)).toEqual(["GENERIC_SUBJECT_LABEL"]);
  });

  it("rejects an absent label when the table has names to use", () => {
    expect(groundingOf({ scope: "entity" }, WITH_ENTITIES)).toEqual(["ENTITY_SUBJECT_REQUIRED"]);
    expect(groundingOf(undefined, WITH_ENTITIES)).toEqual(["ENTITY_SUBJECT_REQUIRED"]);
  });

  it("does not demand a name from a table that has no entity axis", () => {
    expect(groundingOf({ scope: "entity" }, NO_AXIS)).toEqual([]);
    expect(groundingOf(undefined, NO_AXIS)).toEqual([]);
  });

  it("still rejects a position or an internal handle", () => {
    for (const label of ["3", "-27.2", "a1", "result_7", "row 4", "строка 4", "finding_2"]) {
      expect(groundingOf({ scope: "entity", entityLabel: label }, WITH_ENTITIES), label).toEqual(["POSITIONAL_SUBJECT_LABEL"]);
    }
  });

  it("accepts a real label that happens to read like a common noun when the axis carries it", () => {
    const axis = entityAxisFromLabels(["Продукт", "Ангара"], "entity");
    expect(groundingOf({ scope: "entity", entityLabel: "Продукт" }, { axis, hasPeriodAxis: false })).toEqual([]);
    expect(groundingOf({ scope: "entity", entityLabel: "продукт" }, WITH_ENTITIES)).toEqual(["GENERIC_SUBJECT_LABEL"]);
  });
});

describe("Stage 27.2B §44/§45/§46 — the positive cases that owe no entity", () => {
  it("a table overview owes no entity", () => {
    expect(groundingOf({ scope: "table" }, WITH_ENTITIES)).toEqual([]);
  });

  it("a metric finding owes a metric and nothing else", () => {
    expect(groundingOf({ scope: "metric" }, WITH_METRICS)).toEqual(["METRIC_SUBJECT_REQUIRED"]);
    expect(groundingOf({ scope: "metric", metric: "Активы" }, WITH_METRICS)).toEqual([]);
  });

  it("a period finding owes a period or a range", () => {
    expect(groundingOf({ scope: "period" }, WITH_ENTITIES)).toEqual(["PERIOD_SUBJECT_REQUIRED"]);
    expect(groundingOf({ scope: "period", period: "Дек" }, WITH_ENTITIES)).toEqual([]);
    expect(groundingOf({ scope: "period", periodRange: { start: "2025", end: "2026" } }, WITH_ENTITIES)).toEqual([]);
  });

  it("a group is grounded by its members when the group label itself is a bare index", () => {
    expect(groundingOf({ scope: "group", entityLabel: "1", members: ["Ангара", "Кама"] }, WITH_ENTITIES)).toEqual([]);
    expect(groundingOf({ scope: "group", entityLabel: "1" }, WITH_ENTITIES)).toEqual(["POSITIONAL_SUBJECT_LABEL"]);
  });

  it("a comparison needs both sides", () => {
    expect(groundingOf({ scope: "comparison", entityLabel: "Ангара" }, WITH_ENTITIES)).toEqual(["ENTITY_SUBJECT_REQUIRED"]);
    expect(groundingOf({ scope: "comparison", entityLabel: "Ангара", members: ["Кама"] }, WITH_ENTITIES)).toEqual([]);
  });
});

describe("Stage 27.2B §47 — an ambiguous subject is held, never chosen", () => {
  it("holds when the extractor could not decide between candidates", () => {
    expect(groundingOf({ scope: "entity", entityLabel: "Ангара", candidates: ["Ангара", "Кама"] }, WITH_ENTITIES)).toEqual(["SUBJECT_AMBIGUOUS"]);
  });

  it("buildFindingSubject records the candidates rather than picking the first", () => {
    const subject = buildFindingSubject({ scope: "entity", label: "Ангара", candidates: ["Ангара", "Кама"], axis: PRODUCTS });
    expect(subject?.candidates).toEqual(["Ангара", "Кама"]);
    expect(groundingOf(subject ?? undefined, WITH_ENTITIES)).toEqual(["SUBJECT_AMBIGUOUS"]);
  });
});

describe("Stage 27.2B §8 — the shared subject builder never guesses", () => {
  it("returns null when there is no evidence of a subject at all", () => {
    expect(buildFindingSubject({ scope: "entity", label: "", axis: PRODUCTS })).toBeNull();
  });

  it("puts the name in entityLabel on a dimension axis and in metric on a measure axis", () => {
    expect(buildFindingSubject({ scope: "entity", label: "Ангара", axis: PRODUCTS })).toMatchObject({ scope: "entity", entityLabel: "Ангара" });
    expect(buildFindingSubject({ scope: "entity", label: "Активы", axis: METRICS })).toMatchObject({ scope: "metric", metric: "Активы" });
  });

  it("drops an empty period rather than inventing one", () => {
    const subject = buildFindingSubject({ scope: "entity", label: "Ангара", period: "", axis: PRODUCTS });
    expect(subject?.period).toBeUndefined();
    const ranged = buildFindingSubject({ scope: "entity", label: "Ангара", periodRange: { start: "Янв", end: "" }, axis: PRODUCTS });
    expect(ranged?.periodRange).toBeUndefined();
  });

  it("renders a grounded subject for the deterministic fallback", () => {
    const subject: FindingSubject = { scope: "entity", entityLabel: "Ангара", metric: "Активы", period: "Дек" };
    expect(subjectLabel(subject)).toBe("Ангара, Активы (Дек)");
    expect(subjectLabel({ scope: "entity", entityLabel: "Обь", periodRange: { start: "Янв", end: "Дек" } })).toBe("Обь (Янв–Дек)");
  });

  it("treats real labels as readable", () => {
    for (const label of ["Продуктовый портфель", "Ангара", "Метрика-7", "Обь"]) {
      expect(isReadableLabel(label), label).toBe(true);
    }
  });
});

describe("Stage 27.2B §10/§11 — the narrator never sees an ungrounded finding", () => {
  it("splits visible from held and keeps the rest", () => {
    const { visible, held } = groundFindings(
      [
        finding({ id: "ok", subjectRef: { scope: "entity", entityLabel: "Ангара" } }),
        finding({ id: "generic", subjectRef: { scope: "entity", entityLabel: "продукт" } }),
        finding({ id: "absent", subjectRef: { scope: "entity" } }),
      ],
      WITH_ENTITIES,
    );
    expect(visible.map((f) => f.id)).toEqual(["ok"]);
    expect(held.map((h) => h.finding.id)).toEqual(["generic", "absent"]);
    expect(held[0]!.reason).toBe("GENERIC_SUBJECT_LABEL");
    expect(held[1]!.reason).toBe("ENTITY_SUBJECT_REQUIRED");
  });

  it("does not repair: nothing is relabelled and nothing is demoted to table scope", () => {
    const input = finding({ id: "x", subject: "продукт", subjectRef: { scope: "entity", entityLabel: "продукт" } });
    const { visible, held } = groundFindings([input], WITH_ENTITIES);
    expect(visible).toEqual([]);
    expect(held[0]!.finding).toBe(input);
    expect(held[0]!.finding.subjectRef).toEqual({ scope: "entity", entityLabel: "продукт" });
  });

  it("holds a finding that carries no subjectRef at all", () => {
    const bare = { ...finding() } as { subjectRef?: unknown };
    delete bare.subjectRef;
    const { visible, held } = groundFindings([bare as VerifiedFinding], WITH_ENTITIES);
    expect(visible).toEqual([]);
    expect(held[0]!.reason).toBe("ENTITY_SUBJECT_REQUIRED");
  });

  it("§38 — reports the held ratio by finding type", () => {
    const stats = groundingStats(
      groundFindings(
        [
          finding({ id: "a", findingType: "trend", subjectRef: { scope: "entity", entityLabel: "Ангара" } }),
          finding({ id: "b", findingType: "trend", subjectRef: { scope: "entity", entityLabel: "продукт" } }),
          finding({ id: "c", findingType: "cluster", subjectRef: { scope: "entity" } }),
        ],
        WITH_ENTITIES,
      ),
    );
    expect(stats.extractedFindings).toBe(3);
    expect(stats.visibleGroundedFindings).toBe(1);
    expect(stats.heldFindings).toBe(2);
    expect(stats.unnamedSubjectFindingsHeld).toBe(2);
    expect(stats.heldByFindingType).toEqual({ trend: 1, cluster: 1 });
  });
});

describe("Stage 27.2B §21 — the checks the numeric gate does not make", () => {
  const grounded = [
    finding({ id: "a", subject: "Ангара", subjectRef: { scope: "entity", entityLabel: "Ангара" } }),
    finding({ id: "b", subject: "Кама", subjectRef: { scope: "entity", entityLabel: "Кама" } }),
  ];
  const base = { findings: grounded, request: "Сравни продукты", locale: "ru" as const, hasResults: true };

  it("accepts a grounded, readable answer", () => {
    const evaluation = evaluateAnswer({
      ...base,
      answer: "«Ангара» снизилась на 27,2 за период с января по декабрь — это самое сильное падение в таблице.",
    });
    expect(evaluation.accept).toBe(true);
    expect(evaluation.unnamedSubjectClaims).toBe(0);
  });

  it("§40 — catches «продукт с наклоном -27,2»", () => {
    const evaluation = evaluateAnswer({ ...base, answer: "«Нева» — самый необычный продукт, а продукт с наклоном -27,2 — в группе падения." });
    expect(evaluation.accept).toBe(false);
    expect(evaluation.unnamedSubjectClaims).toBe(1);
    expect(evaluation.details.find((d) => d.issue === "SUBJECT_UNGROUNDED")?.evidence).toContain("-27,2");
  });

  it("§41 — catches «лидером является показатель с изменением с 2 до 40»", () => {
    const evaluation = evaluateAnswer({ ...base, answer: "Лидером является показатель с изменением с 2 до 40." });
    expect(evaluation.issues).toContain("SUBJECT_UNGROUNDED");
  });

  it("§14 — does not flag a generic noun when only one subject is in play", () => {
    const single = [finding({ subject: "Активы", subjectRef: { scope: "metric", metric: "Активы" } })];
    const evaluation = evaluateAnswer({ ...base, findings: single, answer: "Этот показатель вырос на 10,8%." });
    expect(evaluation.unnamedSubjectClaims).toBe(0);
  });

  it("§14 — does not flag a noun that follows its number as a count", () => {
    const evaluation = evaluateAnswer({ ...base, answer: "«Ангара» выросла на 12,4. Всего в таблице 15 показателей." });
    expect(evaluation.unnamedSubjectClaims).toBe(0);
  });

  it("§42 — catches the unsupported recommendations that closed live answers", () => {
    for (const advice of [
      "Стоит проверить гипотезу о причинах различий в качестве приближения.",
      "Рекомендуется посмотреть на остальные показатели.",
      "Имеет смысл проверить остальные данные.",
    ]) {
      const evaluation = evaluateAnswer({ ...base, answer: `«Ангара» снизилась на 27,2. ${advice}` });
      expect(evaluation.issues, advice).toContain("UNSUPPORTED_RECOMMENDATION");
    }
  });

  it("§28 — allows a recommendation when the user asked for one", () => {
    const evaluation = evaluateAnswer({
      ...base,
      request: "Что делать с падающими продуктами? Дай рекомендации.",
      answer: "«Ангара» снизилась на 27,2. Стоит проверить её поставки.",
    });
    expect(evaluation.issues).not.toContain("UNSUPPORTED_RECOMMENDATION");
  });

  it("§26 — catches a table read aloud", () => {
    const evaluation = evaluateAnswer({ ...base, answer: "Ангара | 131 | 40 | -91" + NEWLINE + "Мезень | 88 | 96 | 8" });
    expect(evaluation.issues).toContain("RAW_RESULT_DUMP");
  });

  it("§26 — accepts a compact table under a real conclusion", () => {
    const evaluation = evaluateAnswer({
      ...base,
      answer:
        "Сильнее всех упала «Ангара», следом «Кама»; остальные выросли за тот же период." +
        NEWLINE +
        "Ангара | 131 | 40" +
        NEWLINE +
        "Кама | 88 | 61",
    });
    expect(evaluation.issues).not.toContain("RAW_RESULT_DUMP");
  });

  it("§25 — catches figures with nothing said about them", () => {
    const evaluation = evaluateAnswer({ ...base, answer: "131, 40, 88, 96, 2, 40." });
    expect(evaluation.issues).toContain("NOT_HUMAN_READABLE");
  });

  it("§25/§35 — catches an internal handle or a validator code reaching the reader", () => {
    expect(evaluateAnswer({ ...base, answer: "«Ангара» снизилась (result_3)." }).issues).toContain("NOT_HUMAN_READABLE");
    expect(evaluateAnswer({ ...base, answer: "ENTITY_SUBJECT_REQUIRED для «Ангары»." }).issues).toContain("NOT_HUMAN_READABLE");
    expect(evaluateAnswer({ ...base, answer: "«Ангара» снизилась на 27,2153846154." }).issues).toContain("NOT_HUMAN_READABLE");
  });

  it("§22 — catches an answer that answers nothing", () => {
    expect(evaluateAnswer({ ...base, answer: "" }).issues).toContain("TASK_NOT_FULFILLED");
    expect(evaluateAnswer({ ...base, findings: [], answer: "Динамика выглядит стабильной." }).issues).toContain("TASK_NOT_FULFILLED");
  });

  it("§22 — catches a who-question answered without naming anyone", () => {
    const evaluation = evaluateAnswer({
      ...base,
      request: "Кто показал самый сильный спад?",
      answer: "В таблице заметна высокая волатильность между периодами.",
    });
    expect(evaluation.issues).toContain("TASK_NOT_FULFILLED");
  });

  it("§23 — catches a process preamble in front of the conclusion", () => {
    const evaluation = evaluateAnswer({
      ...base,
      answer: "Я проанализировал данные различными способами. «Ангара» снизилась на 27,2.",
    });
    expect(evaluation.issues).toContain("NO_DIRECT_ANSWER");
  });

  it("§51 — a concise direct answer is accepted as it is", () => {
    const assets = [finding({ subject: "Активы", subjectRef: { scope: "metric", metric: "Активы" } })];
    const evaluation = evaluateAnswer({
      ...base,
      findings: assets,
      request: "На сколько выросли активы?",
      answer: "Активы выросли на 10,76% — с 17 941,7 до 19 871,5.",
    });
    expect(evaluation.accept).toBe(true);
  });

  it("§27 — catches analyst filler with no finding behind it", () => {
    const evaluation = evaluateAnswer({ ...base, answer: "Данные демонстрируют интересную динамику." });
    expect(evaluation.issues).toContain("EMPTY_ANALYST_SPEAK");
  });
});

describe("Stage 27.2B §48/§49/§50 — the regex defects, as regressions", () => {
  const grounded = [
    finding({ id: "a", subject: "Ангара", subjectRef: { scope: "entity", entityLabel: "Ангара" } }),
    finding({ id: "b", subject: "Кама", subjectRef: { scope: "entity", entityLabel: "Кама" } }),
  ];
  const base = { findings: grounded, request: "q", locale: "ru" as const, hasResults: true };

  it("§49 — the numeric token is taken by position, not by a greedy capture", () => {
    const evaluation = evaluateAnswer({ ...base, answer: "Больше всех упал продукт с наклоном -27,2 за год." });
    const evidence = evaluation.details.find((d) => d.issue === "SUBJECT_UNGROUNDED")?.evidence ?? "";
    expect(evidence).toContain("-27,2");
    expect(evidence).not.toMatch(/-27,$/u);
  });

  it("§48 — the generic head matches after a Cyrillic letter", () => {
    expect(evaluateAnswer({ ...base, answer: "Этот продукт с наклоном -27,2 упал сильнее всех." }).unnamedSubjectClaims).toBe(1);
    expect(evaluateAnswer({ ...base, answer: "Продуктовый портфель вырос на 12,4." }).unnamedSubjectClaims).toBe(0);
  });

  it("§50 — no regex source carries a literal U+0008 where a boundary was intended", async () => {
    const sources = await Promise.all([import("./narration/answer-evaluator.js"), import("./insight/finding-subject.js")]);
    expect(sources).toHaveLength(2);
    const files = ["narration/answer-evaluator.ts", "insight/finding-subject.ts"];
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    for (const file of files) {
      const text = fs.readFileSync(path.join(here, file), "utf8");
      expect(text.includes(String.fromCharCode(8)), `${file} contains a literal backspace`).toBe(false);
      expect(IRREGULAR_WHITESPACE.test(text), `${file} contains irregular whitespace`).toBe(false);
    }
  });
});

describe("Stage 27.2B §29/§30/§32 — the one rewrite changes text, never analysis", () => {
  const named = [finding({ subject: "Кама", subjectRef: { scope: "entity", entityLabel: "Кама" } }), finding({ id: "f2", subject: "Обь", subjectRef: { scope: "entity", entityLabel: "Обь" } })];

  it("names the offending span and the identities that were available", () => {
    const evaluation = evaluateAnswer({
      answer: "Продукт с наклоном -27,2 упал сильнее всех. Стоит проверить причины.",
      findings: named,
      request: "q",
      locale: "ru",
      hasResults: true,
    });
    expect(evaluation.rewriteGuidance).toContain("Расчёты не меняй");
    expect(evaluation.rewriteGuidance).toContain("-27,2");
    expect(evaluation.rewriteGuidance).toContain("Кама");
    expect(evaluation.rewriteGuidance).toContain("рекомендация");
    expect(evaluation.rewriteGuidance).toContain("Не добавляй новых чисел");
  });

  it("§54 — says nothing about re-running the analysis", () => {
    const evaluation = evaluateAnswer({ answer: "Product with slope -1.5 fell most.", findings: named, request: "q", locale: "en", hasResults: true });
    expect(evaluation.rewriteGuidance).toContain("Do not change or recompute the analysis");
    expect(evaluation.rewriteGuidance).not.toMatch(/re-?run|recalculate|compute again/iu);
  });

  it("§30 — guidance is structural: it never supplies a number or a cause", () => {
    const guidance = buildRewriteGuidance([{ issue: "SUBJECT_UNGROUNDED", evidence: "продукт с наклоном -27,2" }], named, "ru");
    expect(guidance).toContain("Не добавляй новых чисел и не делай выводов о причинах.");
  });

  it("an accepted answer produces no guidance at all", () => {
    const evaluation = evaluateAnswer({ answer: "«Кама» снизилась на 27,2.", findings: named, request: "q", locale: "ru", hasResults: true });
    expect(evaluation.accept).toBe(true);
    expect(evaluation.rewriteGuidance).toBe("");
  });
});

describe("Stage 27.2B §57 — the hard gates", () => {
  const grounded = [
    finding({ id: "a", subject: "Ангара", subjectRef: { scope: "entity", entityLabel: "Ангара", metric: "Активы" } }),
    finding({ id: "b", subject: "Кама", subjectRef: { scope: "entity", entityLabel: "Кама", metric: "Активы" } }),
  ];

  it("unnamedSubjectClaims = 0 for an answer built from grounded findings", () => {
    const evaluation = evaluateAnswer({
      answer: "«Ангара» выросла на 12,4, тогда как «Кама» снизилась на 27,2 за тот же период.",
      findings: grounded,
      request: "q",
      locale: "ru",
      hasResults: true,
    });
    expect(evaluation.unnamedSubjectClaims).toBe(0);
    expect(evaluation.accept).toBe(true);
  });

  it("§37 — an unnamed subject does not pass quietly", () => {
    const evaluation = evaluateAnswer({
      answer: "Показатель с изменением 12,4 вырос, продукт с наклоном -27,2 упал.",
      findings: grounded,
      request: "q",
      locale: "ru",
      hasResults: true,
    });
    expect(evaluation.unnamedSubjectClaims).toBe(2);
    expect(evaluation.accept).toBe(false);
  });

  it("§33 — the two gates compose: a held finding can never become an unnamed claim", () => {
    const { visible } = groundFindings([finding({ subjectRef: { scope: "entity", entityLabel: "продукт" } })], WITH_ENTITIES);
    expect(visible).toEqual([]);
  });
});
