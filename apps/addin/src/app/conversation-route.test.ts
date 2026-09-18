import { describe, expect, it } from "vitest";
import { detectComparison, isTransformRequest, routeTurn } from "./conversation-route.js";

const CTX = { hasSelection: true, knownEntities: [] as string[], hasPriorResult: false };

describe("routeTurn — general chat", () => {
  it("routes bare concept questions to general_chat with no workbook needs", () => {
    for (const q of ["What is PD?", "Explain variance.", "How does PD differ from LGD?", "What is the difference between PD and LGD?", "Give me a simple example.", "что такое дюрация?"]) {
      const r = routeTurn(q, CTX);
      expect(r.route, q).toBe("general_chat");
      expect(r.needsSelection, q).toBe(false);
      expect(r.needsWorkbookMap, q).toBe(false);
    }
  });

  it("does NOT treat 'what does X mean' as a request for the statistic", () => {
    expect(routeTurn("What does LGD mean?", CTX).route).toBe("general_chat");
    expect(routeTurn("explain what a hazard rate means", CTX).route).toBe("general_chat");
  });

  it("keeps a concept-shaped question on the workbook when it points at the data", () => {
    expect(routeTurn("what is this table about?", CTX).route).toBe("workbook_qa");
    expect(routeTurn("what columns are important here?", CTX).route).toBe("workbook_qa");
    expect(routeTurn("what kind of data is this?", CTX).route).toBe("workbook_qa");
  });
});

describe("routeTurn — workbook routes", () => {
  it("routes analytical asks to workbook_analysis", () => {
    for (const q of ["Compare average Plan and Fact by Category.", "which category performs worst?", "show only the top 5 by Fact", "what are the biggest deviations?"]) {
      expect(routeTurn(q, CTX).route, q).toBe("workbook_analysis");
      expect(routeTurn(q, CTX).needsSelection, q).toBe(true);
    }
  });

  it("routes mutation phrasing to workbook_mutation (identify only)", () => {
    for (const q of ["add a column with the delta", "highlight the rows where Fact < Plan", "create a new sheet called Summary", "создай новый лист Отчёт"]) {
      expect(routeTurn(q, CTX).route, q).toBe("workbook_mutation");
    }
  });

  it("routes a computed-plus-interpretation ask to mixed", () => {
    expect(routeTurn("what is the average PD here and what does that mean?", CTX).route).toBe("mixed");
  });

  it("flags a two-target comparison for the workbook map", () => {
    const r = routeTurn("what changed between 2024 and 2025?", CTX);
    expect(r.route).toBe("workbook_analysis");
    expect(r.needsWorkbookMap).toBe(true);
    expect(r.reasons).toContain("cross-target-comparison");
  });

  it("falls back to workbook_analysis (never silently to chat) for unclassified prose", () => {
    expect(routeTurn("do it", CTX).route).toBe("workbook_analysis");
    expect(routeTurn("recompute the deltas", CTX).route).toBe("workbook_analysis");
  });
});

describe("isTransformRequest — 24.5.3 'N <noun> with the worst/best <metric>'", () => {
  it("recognises the bare-count + superlative phrasing (EN + RU) as a transform", () => {
    for (const q of [
      "покажи 3 менеджеров с худшим Variance",
      "дай 2 менеджера с лучшим Revenue",
      "show me 3 managers with the worst Variance",
      "give me 5 regions with the highest revenue",
      "оставь 2 менеджеров с худшим Variance",
    ]) {
      expect(isTransformRequest(q), q).toBe(true);
    }
  });

  it("still recognises the existing top-N / sort phrasings", () => {
    for (const q of ["show only the top 5 by Fact", "sort by Fact descending", "топ-3 по выручке"]) {
      expect(isTransformRequest(q), q).toBe(true);
    }
  });

  it("does not fire on an unrelated analytical ask", () => {
    expect(isTransformRequest("group the sales by manager")).toBe(false);
    expect(isTransformRequest("what is the average Variance?")).toBe(false);
  });
});

describe("detectComparison", () => {
  it("extracts two targets from 'compare A and B' / 'between A and B' (EN + RU)", () => {
    expect(detectComparison("compare Portfolio 2024 and Portfolio 2025")?.targets).toEqual(["Portfolio 2024", "Portfolio 2025"]);
    expect(detectComparison("what changed between 2024 and 2025?")?.targets).toEqual(["2024", "2025"]);
    expect(detectComparison("сравни выручку за 2023 и 2024")?.targets).toEqual(["выручку за 2023", "2024"]);
  });
  it("returns null when there are not two distinct targets", () => {
    expect(detectComparison("summarise the table")).toBeNull();
    expect(detectComparison("compare 2025 and 2025")).toBeNull();
  });
});

// Stage 26.8 §7/§64 — a definition question that names two statistics.
describe("Stage 26.8 — definitional contrast", () => {
  const ctx = { hasSelection: true, knownEntities: [], hasPriorResult: false };

  it("routes 'чем медиана отличается от среднего?' to general chat", () => {
    expect(routeTurn("Чем медиана отличается от среднего?", ctx).route).toBe("general_chat");
    expect(routeTurn("В чём разница между медианой и средним?", ctx).route).toBe("general_chat");
    expect(routeTurn("What's the difference between mean and median?", ctx).route).toBe("general_chat");
  });

  it("leaves a contrast about the DATA alone", () => {
    // no statistics vocabulary — untouched by the rescue
    // ("Чем отличается X от Y" is matched by the pre-existing concept regex and
    //  was general chat before this stage; these two are not.)
    for (const text of ["Чем январь отличается от февраля по выручке?", "Чем Север отличается от Юга по выручке?"]) {
      expect(routeTurn(text, ctx).route, text).not.toBe("general_chat");
    }
  });

  it("a period or a figure in the sentence makes it about data again", () => {
    expect(routeTurn("Чем среднее за январь отличается от среднего за февраль?", ctx).route).not.toBe("general_chat");
    expect(routeTurn("Чем среднее 2024 отличается от среднего 2025?", ctx).route).not.toBe("general_chat");
  });

  it("workbook deixis still wins", () => {
    expect(routeTurn("Чем медиана в этой таблице отличается от среднего?", ctx).route).not.toBe("general_chat");
  });
});
