import { describe, expect, it } from "vitest";
import { buildOwnershipContext, type TurnFacts } from "./turn-context.js";
import { classifyTurnOwner, type OwnershipDecision } from "./turn-owner.js";

const FACTS: TurnFacts = {
  canPlan: true,
  isSlash: false,
  hasSelection: true,
  lastV1Result: undefined,
  v1ResultCount: 0,
  v1ClarificationPending: false,
  v2ClarificationPending: false,
  hasV2Table: false,
};

function route(text: string, over: Partial<TurnFacts> = {}, table = { hasTable: true, selectionIsForeign: false }): OwnershipDecision {
  return classifyTurnOwner({ ...buildOwnershipContext(text, { ...FACTS, ...over }), ...table });
}

const owns = (text: string, over: Partial<TurnFacts> = {}, table = { hasTable: true, selectionIsForeign: false }): string => {
  const d = route(text, over, table);
  return d.owner === "V2_OWNED" ? `V2:${d.reason}` : `NON_V2:${d.reason}`;
};

describe("analytical ownership — every analytical turn shape belongs to the one engine", () => {
  it.each<[string, string]>([
    ["simple aggregation", "Какая сумма активов за последний период?"],
    ["change", "На сколько выросли активы за последний месяц?"],
    ["comparison", "Сравни активы и обязательства за последний период"],
    ["ranking", "Назови три показателя с самым сильным падением"],
    ["grouped ranking", "Покажи 3 менеджера с худшим результатом"],
    ["table overview", "О чём эта таблица?"],
    ["schema-aware description", "Что это за данные?"],
    ["describe the table", "Опиши эту таблицу"],
    ["trend", "Какой тренд у активов?"],
    ["volatility", "Какой показатель самый волатильный?"],
    ["exploration", "Что здесь самое необычное?"],
    ["clustering / sandbox work", "Раздели показатели на группы по динамике"],
    ["cross-metric analysis", "Есть ли связь между активами и депозитами?"],
  ])("%s is the analytical engine's", (_label, text) => {
    expect(owns(text)).toBe("V2:analytical_request");
  });

  it("an analytical follow-up on the engine's own table stays with the engine", () => {
    expect(owns("А теперь сравни только эти три между собой", { hasV2Table: true })).toBe("V2:analytical_request");
  });

  it("a short continuation with no analytical wording of its own still stays with the engine", () => {
    expect(owns("из них", { hasV2Table: true })).toBe("V2:analytical_request");
  });

  it("a reply to the engine's own clarification resumes the engine, never a new turn", () => {
    expect(owns("за первый квартал", { v2ClarificationPending: true, hasV2Table: true })).toBe("V2:v2_clarification_reply");
  });
});

describe("analytical ownership — the capabilities that are NOT the analytical engine", () => {
  it("a mutation goes to the deterministic write path", () => {
    expect(owns("Выдели красным строки с убытком")).toBe("NON_V2:mutation_request");
  });

  it("a result action goes to the result-action capability", () => {
    expect(owns("Построй график по этому результату", { v1ResultCount: 1 })).toBe("NON_V2:result_action");
  });

  it("a slash command goes to the slash route", () => {
    expect(owns("/sheets", { isSlash: true })).toBe("NON_V2:slash_command");
  });

  it("an undo goes to the undo route", () => {
    expect(owns("отмени это")).toBe("NON_V2:undo");
  });

  it("a concept question with no workbook pull goes to general chat", () => {
    expect(owns("Что такое кредитный риск?")).toBe("NON_V2:general_knowledge");
  });

  it("a concept question stays general knowledge even with a table already analysed", () => {
    expect(owns("Что такое кредитный риск?", { hasV2Table: true })).toBe("NON_V2:general_knowledge");
  });

  it("general chat with no workbook analytical intent goes to general chat", () => {
    expect(owns("Объясни, как считается LGD")).toBe("NON_V2:general_knowledge");
  });

  it("an unidentified message keeps `routeTurn`'s long-standing analyse-the-selection fallback", () => {
    expect(owns("Привет, расскажи о себе")).toBe("V2:analytical_request");
  });

  it("a flat-records selection the engine cannot induce a schema for is not the engine's", () => {
    expect(owns("Покажи 3 менеджера с худшим результатом", {}, { hasTable: false, selectionIsForeign: true })).toBe("NON_V2:no_table");
  });

  it("without a planner transport there is no analytical engine to own the turn", () => {
    expect(owns("Какой показатель изменился сильнее всего?", { canPlan: false })).toBe("NON_V2:no_planner_transport");
  });
});

describe("analytical ownership — the router does not decide analytical meaning", () => {
  it("ranking, count and direction are all the SAME coarse verdict; the planner separates them", () => {
    const shapes = [
      "Назови три показателя с самым сильным падением",
      "Покажи один показатель с самым сильным ростом",
      "Перечисли показатели по убыванию",
      "Сколько показателей снизилось?",
    ];
    expect([...new Set(shapes.map((s) => owns(s)))]).toEqual(["V2:analytical_request"]);
  });

  it("an overview question and a computation over the same table get the same owner", () => {
    expect(owns("О чём эта таблица?")).toBe(owns("Какая сумма активов?"));
  });
});
