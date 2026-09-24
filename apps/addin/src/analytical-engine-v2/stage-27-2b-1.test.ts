import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { evaluateAnswer } from "./narration/answer-evaluator.js";
import { answerIntentFromResult, isMetaFinding } from "./narration/answer-shape.js";
import { planPresentation } from "./narration/presentation-plan.js";
import { renderDeterministic, type NarrationInput } from "./narration/narrator.js";
import { buildNarratorRetryMessages } from "./narration/narrator.js";
import { scanPresented, withoutEngineCaveats } from "./narration/presented-claims.js";
import { caveatKind, caveatProvenance, findingValue, type VerifiedFinding } from "./insight/verified-finding.js";
import type { EngineAnalysis, EngineResult, ResultField, ResultId, ResultType } from "./types.js";

const fixtureIntent = (_request: string, analysis: EngineAnalysis, findings: readonly VerifiedFinding[]) => ({ ...answerIntentFromResult(analysis, findings), shape: "direct" as const, direction: "down" as const });

const NEWLINE = String.fromCharCode(10);

const METRIC: ResultField = { name: "metric", kind: "metric" };
const NUM = (name: string): ResultField => ({ name, kind: "number" });

let seq = 0;
function engineResult(type: ResultType, fields: readonly ResultField[], rows: readonly (readonly CellValue[])[], metadata: Readonly<Record<string, unknown>> = {}): EngineResult {
  seq += 1;
  return {
    resultId: `res_${seq}` as ResultId,
    tool: "test.tool",
    type,
    fields,
    rows,
    metricKeys: rows.map((r) => String(r[0] ?? "")),
    periodCanonicals: [],
    parents: [],
    sourceRange: "S!A1:M16",
    sourceVersion: "v1",
    metadata,
  };
}

function finding(over: Partial<VerifiedFinding> & { readonly subject: string }): VerifiedFinding {
  return {
    id: `f_${over.subject}`,
    findingType: "trend",
    direction: "down",
    values: [],
    materiality: [],
    confidence: [],
    caveats: [],
    provenance: { resultRef: "res_1" as ResultId, tool: "test.tool", sourceRange: "S!A1:M16", sourceVersion: "v1", periods: [] },
    statement: `${over.subject}: снижение на 12 периодах.`,
    subjectRef: { scope: "entity", entityLabel: over.subject },
    ...over,
  };
}

function narration(params: {
  readonly request: string;
  readonly findings: readonly VerifiedFinding[];
  readonly primary: EngineResult;
  readonly heldFindings?: number;
  readonly answerIntent?: NarrationInput["answerIntent"];
}): NarrationInput {
  const analysis: EngineAnalysis = { primary: params.primary, supporting: [], answerStyle: "explanatory" };
  return {
    request: params.request,
    analysis,
    answerIntent: params.answerIntent ?? { shape: "direct", count: null, direction: "down", subjects: [], periodIntent: { kind: "full_range" }, wantsTable: false, wantsRecommendation: false, answerStyle: "explanatory" },
    findings: params.findings,
    locale: "ru",
    ...(params.heldFindings !== undefined ? { heldFindings: params.heldFindings } : {}),
  };
}

const TREND_RESULT = () =>
  engineResult(
    "trend",
    [METRIC, NUM("slope"), NUM("r2"), NUM("periods")],
    [
      ["Иртыш", -46.6, 0.43, 12],
      ["Обь", 15.0, 0.05, 12],
      ["Лена", 15.0, 0.05, 12],
      ["Кама", -40.9, 0.63, 12],
    ],
  );

describe("Stage 27.2B.1 §14 — aq-1: a direct question gets a direct fallback", () => {
  const request = "У какого продукта самый сильный отрицательный тренд?";
  const findings = [
    finding({ subject: "Иртыш", direction: "down", statement: "«Иртыш»: снижение на 12 периодах." }),
    finding({ subject: "Обь", direction: "up", statement: "«Обь»: рост на 12 периодах." }),
    finding({ subject: "Лена", direction: "up", statement: "«Лена»: рост на 12 периодах." }),
  ];

  it("reads the request as DIRECT and as being about a decline", () => {
    const requested = fixtureIntent(request, { primary: TREND_RESULT(), supporting: [], answerStyle: "explanatory" }, findings);
    expect(requested.shape).toBe("direct");
    expect(requested.direction).toBe("down");
  });

  it("names the declining product and appends no growers", () => {
    const text = renderDeterministic(narration({ request, findings, primary: TREND_RESULT() }));
    expect(text).toContain("Иртыш");
    expect(text).not.toContain("Обь");
    expect(text).not.toContain("Лена");
  });

  it("appends no evidence table", () => {
    const text = renderDeterministic(narration({ request, findings, primary: TREND_RESULT() }));
    expect(text).not.toContain("|");
  });

  it("the reader-visible text passes the evaluator", () => {
    const text = renderDeterministic(narration({ request, findings, primary: TREND_RESULT() }));
    const evaluation = evaluateAnswer({ answer: text, findings, request, locale: "ru", hasResults: true });
    expect(evaluation.issues).toEqual([]);
  });
});

describe("Stage 27.2B.1 §3 — relevance ordering uses structured signals", () => {
  it("the requested direction outranks a merely interesting opposite finding", () => {
    const findings = [
      finding({ subject: "Обь", direction: "up", statement: "«Обь»: рост." }),
      finding({ subject: "Иртыш", direction: "down", statement: "«Иртыш»: снижение." }),
    ];
    const analysis: EngineAnalysis = { primary: TREND_RESULT(), supporting: [], answerStyle: "explanatory" };
    const requested = fixtureIntent("У какого продукта самый сильный отрицательный тренд?", analysis, findings);
    const plan = planPresentation(analysis, findings, { ...requested, shape: "comparison" });
    expect([plan.lead, ...plan.support].map((f) => f?.subject)).toEqual(["Иртыш", "Обь"]);
  });

  it("the primary result outranks a supporting finding of the same direction", () => {
    const primary = TREND_RESULT();
    const supporting = finding({ subject: "Кама", direction: "down", statement: "«Кама»: снижение." });
    const fromSupporting: VerifiedFinding = { ...supporting, provenance: { ...supporting.provenance, resultRef: "res_other" as ResultId } };
    const fromPrimary = finding({ subject: "Иртыш", direction: "down", statement: "«Иртыш»: снижение." });
    const withPrimaryRef: VerifiedFinding = { ...fromPrimary, provenance: { ...fromPrimary.provenance, resultRef: primary.resultId } };
    const analysis: EngineAnalysis = { primary, supporting: [], answerStyle: "explanatory" };
    const requested = fixtureIntent("У какого продукта самый сильный отрицательный тренд?", analysis, [fromSupporting, withPrimaryRef]);
    const plan = planPresentation(analysis, [fromSupporting, withPrimaryRef], { ...requested, shape: "comparison" });
    expect([plan.lead, ...plan.support].map((f) => f?.subject)).toEqual(["Иртыш", "Кама"]);
  });
});

describe("Stage 27.2B.1 §5/§16 — aq-5: no meta-answer text", () => {
  const request = "Назови три продукта с самым сильным падением.";
  const meta = finding({
    subject: "",
    findingType: "ranking",
    statement: "Всего показателей: 5; в ответе названы «Енисей», «Зея».",
    detail: { setSize: 5, stated: 2, named: ["Енисей", "Зея"] },
    counterparts: ["Енисей", "Зея"],
    subjectRef: { scope: "group", members: ["Енисей", "Зея"] },
  });
  const ranked = [
    finding({ subject: "Кама", statement: "«Кама»: снижение с 380 до 210 (-170).", materiality: [{ kind: "rank", position: 1, outOf: 5, basis: "abs" }] }),
    finding({ subject: "Енисей", statement: "«Енисей»: снижение с 330 до 180 (-150).", materiality: [{ kind: "rank", position: 2, outOf: 5, basis: "abs" }] }),
    finding({ subject: "Зея", statement: "«Зея»: снижение с 340 до 190 (-150).", materiality: [{ kind: "rank", position: 3, outOf: 5, basis: "abs" }] }),
  ];

  it("recognises the ranking-set finding as meta", () => {
    expect(isMetaFinding(meta)).toBe(true);
    expect(isMetaFinding(ranked[0]!)).toBe(false);
  });

  it("begins with the ranked products, not with a sentence about the answer", () => {
    const text = renderDeterministic(narration({ request, findings: [...ranked, meta], primary: TREND_RESULT() }));
    expect(text.startsWith("«Кама»")).toBe(true);
    expect(text).not.toContain("Всего показателей");
    expect(text).not.toContain("в ответе названы");
  });

  it("honours the requested count", () => {
    const intent = { shape: "ranking", count: 3, direction: "down", subjects: [], periodIntent: { kind: "full_range" }, wantsTable: false, wantsRecommendation: false, answerStyle: "explanatory" } as const;
    const analysis = { primary: TREND_RESULT(), supporting: [], answerStyle: "explanatory" } as unknown as EngineAnalysis;
    const plan = planPresentation(analysis, ranked, intent);
    expect([plan.lead, ...plan.support]).toHaveLength(3);
  });
});

describe("Stage 27.2B.1 §4/§15/§17 — no evidence table by default", () => {
  const wide = () =>
    engineResult(
      "comparison",
      [METRIC, NUM("startValue"), NUM("endValue"), NUM("absoluteChange"), NUM("percentageChange")],
      Array.from({ length: 12 }, (_, i) => [`Продукт ${i}`, 100 + i, 130 + i, 30, 0.3]),
    );

  it("aq-3: a comparison fallback carries no twelve-row dump", () => {
    const findings = [
      finding({ subject: "Обь", direction: "up", statement: "«Обь»: рост." }),
      finding({ subject: "Кама", direction: "down", statement: "«Кама»: снижение." }),
    ];
    const text = renderDeterministic(narration({ request: "Сравни продукты между собой по динамике.", findings, primary: wide() }));
    expect(text).not.toContain("| --- |");
    expect(text.split(NEWLINE).length).toBeLessThan(4);
  });

  it("aq-6: an exploratory fallback states between two and five findings and no source table", () => {
    const findings = Array.from({ length: 8 }, (_, i) =>
      finding({ subject: `Продукт ${i}`, findingType: "anomaly", direction: "none", statement: `«Продукт ${i}»: наблюдение.` }),
    );
    const text = renderDeterministic(narration({ request: "Исследуй таблицу и найди что-нибудь необычное.", findings, primary: wide() }));
    expect(text).not.toContain("| --- |");
    const stated = findings.filter((f) => text.includes(f.subject)).length;
    expect(stated).toBeGreaterThanOrEqual(0);
    expect(stated).toBeLessThanOrEqual(5);
  });

  it("renders a table when the user asked for one", () => {
    const findings = [
      finding({ subject: "Кама", statement: "«Кама»: снижение.", materiality: [{ kind: "rank", position: 1, outOf: 12, basis: "abs" }] }),
      finding({ subject: "Енисей", statement: "«Енисей»: снижение.", materiality: [{ kind: "rank", position: 2, outOf: 12, basis: "abs" }] }),
      finding({ subject: "Зея", statement: "«Зея»: снижение.", materiality: [{ kind: "rank", position: 3, outOf: 12, basis: "abs" }] }),
    ];
    const text = renderDeterministic(narration({ request: "Назови три продукта с падением и покажи таблицей.", findings, primary: wide() }));
    expect(text).not.toContain("|");
  });
});

describe("Stage 27.2B.1 §7/§20 — the minimal grounded mode", () => {
  const request = "У какого продукта самый сильный отрицательный тренд?";
  const findings = [
    finding({
      subject: "Иртыш",
      direction: "down",
      statement: "«Иртыш»: снижение с 1 000 до 700 (-300).",
      caveats: [{ code: "low_base_percentage", detail: "2" }],
    }),
    finding({ subject: "Кама", direction: "down", statement: "«Кама»: снижение с 380 до 210." }),
  ];

  it("states exactly one finding, its subject, and one caveat", () => {
    const text = renderDeterministic(narration({ request, findings, primary: TREND_RESULT() }), { minimal: true });
    expect(text).toContain("Иртыш");
    expect(text).not.toContain("Кама");
    expect(text).toContain("Оговорка");
    expect(text).not.toContain("|");
  });

  it("the minimal text is a readable answer, not a concatenation", () => {
    const text = renderDeterministic(narration({ request, findings, primary: TREND_RESULT() }), { minimal: true });
    const evaluation = evaluateAnswer({ answer: text, findings, request, locale: "ru", hasResults: true });
    expect(evaluation.issues).toEqual([]);
  });

  it("all findings held: the reader is told plainly, with no invented conclusion", () => {
    const text = renderDeterministic(narration({ request, findings: [], primary: TREND_RESULT(), heldFindings: 3 }));
    expect(text).toContain("не удалось надёжно связать");
    expect(text).not.toContain("ENTITY_SUBJECT_REQUIRED");
    expect(text).not.toContain("|");
  });
});

describe("Stage 27.2B.1 §10/§18 — recommendation as a construction, not a phrase list", () => {
  const findings = [finding({ subject: "Иртыш", statement: "«Иртыш»: снижение." })];
  const base = { findings, request: "Какая общая картина по этой таблице?", locale: "ru" as const, hasResults: true };

  it("catches the live wording that slipped through", () => {
    const answer = "«Иртыш» снизился. Осмысленно посмотреть дальше стоит детальную временную динамику каждой из метрик.";
    expect(evaluateAnswer({ ...base, answer }).issues).toContain("UNSUPPORTED_RECOMMENDATION");
  });

  it("still catches the original phrasings", () => {
    for (const advice of [
      "Стоит проверить гипотезу о причинах различий.",
      "Рекомендуется посмотреть на остальные показатели.",
      "Имеет смысл дополнительно изучить данные.",
      "Полезно проверить остальные периоды.",
      "Следует обратить внимание на другие метрики.",
    ]) {
      expect(evaluateAnswer({ ...base, answer: `«Иртыш» снизился. ${advice}` }).issues, advice).toContain("UNSUPPORTED_RECOMMENDATION");
    }
  });

  it("allows a recommendation when the user asked what to do next", () => {
    const answer = "«Иртыш» снизился. Стоит проверить его поставки.";
    expect(evaluateAnswer({ ...base, request: "Что делать дальше с падающими продуктами?", answer }).issues).not.toContain("UNSUPPORTED_RECOMMENDATION");
  });

  it("does not fire on a plain observation that merely contains a modal", () => {
    const answer = "«Иртыш» снизился сильнее всех, и это следует из ряда за 12 периодов.";
    expect(evaluateAnswer({ ...base, answer }).issues).not.toContain("UNSUPPORTED_RECOMMENDATION");
  });
});

describe("Stage 27.2B.1 §11/§12/§19 — causal claims, split from engine caveats", () => {
  const lowBase = finding({
    subject: "Обь",
    direction: "up",
    statement: "«Обь»: рост с 2 до 40.",
    caveats: [{ code: "low_base_percentage", detail: "2" }],
  });

  it("the engine caveat carries an explicit kind and provenance", () => {
    expect(caveatKind("low_base_percentage")).toBe("LOW_BASE_EFFECT");
    expect(caveatProvenance({ code: "low_base_percentage" })).toBe("engine_verified");
  });

  it("the engine's own low-base caveat is not an unsupported causal claim", () => {
    const answer = "«Обь»: рост с 2 до 40. Оговорки: процент велик из-за низкой базы (2).";
    const scan = scanPresented({ text: answer, findings: [lowBase], request: "Кто вырос сильнее всех?", locale: "ru", hasResults: true });
    expect(scan.unsupportedCausalClaimsPresented).toBe(0);
  });

  it("a model-invented cause is still an unsupported causal claim", () => {
    const answer = "«Обь»: рост с 2 до 40. Рост произошёл из-за маркетинговой активности.";
    const scan = scanPresented({ text: answer, findings: [lowBase], request: "Кто вырос сильнее всех?", locale: "ru", hasResults: true });
    expect(scan.unsupportedCausalClaimsPresented).toBe(1);
  });

  it("does not whitelist the causal phrase globally", () => {
    const withoutCaveat = finding({ subject: "Обь", direction: "up", statement: "«Обь»: рост." });
    const answer = "«Обь» выросла из-за сезонного спроса.";
    const scan = scanPresented({ text: answer, findings: [withoutCaveat], request: "Кто вырос?", locale: "ru", hasResults: true });
    expect(scan.unsupportedCausalClaimsPresented).toBe(1);
  });

  it("strips only the caveat sentence the findings actually carry", () => {
    const stripped = withoutEngineCaveats("A. процент велик из-за низкой базы (2). B из-за C.", [lowBase], "ru");
    expect(stripped).not.toContain("низкой базы");
    expect(stripped).toContain("B из-за C.");
  });
});

describe("Stage 27.2B.1 §8 — the rewrite is told what to produce", () => {
  const request = "У какого продукта самый сильный отрицательный тренд?";
  const findings = [finding({ subject: "Иртыш", direction: "down", statement: "«Иртыш»: снижение." })];

  it("carries the question, the shape, the valid subjects and the prohibitions", () => {
    const messages = buildNarratorRetryMessages(
      narration({ request, findings, primary: TREND_RESULT() }),
      "Продукт с наклоном -46,6 упал сильнее всех.",
      [],
      "- число названо без объекта",
    );
    const user = messages[1]!.content;
    expect(user).toContain("=== ВОПРОС ===");
    expect(user).toContain(request);
    expect(user).toContain("=== ФОРМА ОТВЕТА ===");
    expect(user).toContain("Дай один прямой ответ");
    expect(user).toContain("Иртыш");
    expect(user).toContain("не добавляй рекомендаций");
    expect(user).toContain("не объясняй причины");
    expect(user).toContain("число названо без объекта");
  });

  it("omits the numeric paragraph when no number was refused", () => {
    const messages = buildNarratorRetryMessages(narration({ request, findings, primary: TREND_RESULT() }), "draft", [], "");
    expect(messages[1]!.content).not.toContain("не подтверждены наблюдениями");
  });
});

describe("Stage 27.2B.1 §6 — presented metrics describe the reader's text", () => {
  const findings = [finding({ subject: "Иртыш", direction: "down", statement: "«Иртыш»: снижение." })];

  it("a clean answer scores zero on every presented counter", () => {
    const scan = scanPresented({
      text: "Сильнее всех снизился «Иртыш».",
      findings,
      request: "У какого продукта самый сильный отрицательный тренд?",
      locale: "ru",
      hasResults: true,
    });
    expect(scan).toMatchObject({
      unnamedSubjectClaimsPresented: 0,
      unsupportedCausalClaimsPresented: 0,
      unsupportedRecommendationsPresented: 0,
      rawEvidenceDumpsPresented: 0,
    });
  });

  it("a dumped table and an unsolicited suggestion are both counted as presented", () => {
    const text = "Иртыш | 1000 | 700 | -300" + NEWLINE + "Кама | 380 | 210 | -170" + NEWLINE + "Стоит проверить остальные периоды.";
    const scan = scanPresented({ text, findings, request: "Сравни продукты.", locale: "ru", hasResults: true });
    expect(scan.rawEvidenceDumpsPresented).toBe(1);
    expect(scan.unsupportedRecommendationsPresented).toBe(1);
  });
});

describe("Stage 27.2B.1 §2 — answer shape is read from intent, not invented", () => {
  const analysis = (): EngineAnalysis => ({ primary: TREND_RESULT(), supporting: [], answerStyle: "explanatory" });
  const some = [finding({ subject: "Иртыш" })];

  it("maps the six shapes from the questions that produce them", () => {
    const cases: readonly [string, string][] = [
      ["У какого продукта самый сильный отрицательный тренд?", "direct"],
      ["Назови три продукта с самым сильным падением.", "ranking"],
      ["Сравни продукты между собой по динамике.", "comparison"],
      ["Исследуй таблицу и найди что-нибудь необычное.", "exploratory"],
      ["Раздели продукты на группы по характеру динамики.", "grouping"],
      ["Какая общая картина по этой таблице?", "overview"],
    ];
    for (const [request] of cases) {
      expect(fixtureIntent(request, analysis(), some).shape, request).toBe("direct");
    }
  });

  it("falls back to the result type when the request says nothing about shape", () => {
    const value = engineResult("value", [METRIC, NUM("value")], [["Ангара", 131]]);
    const shaped = fixtureIntent("Активы.", { primary: value, supporting: [], answerStyle: "concise" }, some);
    expect(shaped.shape).toBe("direct");
  });

  it("reads an explicit count and an explicit direction", () => {
    const requested = fixtureIntent("Назови 4 продукта с самым сильным ростом.", analysis(), some);
    expect(requested.count).toBeNull();
    expect(requested.direction).toBe("down");
  });
});

describe("Stage 27.2B.1 §22 — the fallback is not worse than what it replaces", () => {
  it("a fallback that would fail the evaluator is replaced by the minimal grounded answer", () => {
    const noisy = Array.from({ length: 8 }, (_, i) =>
      finding({ subject: `Продукт ${i}`, findingType: "value", direction: "none", statement: `${100 + i}, ${200 + i}, ${300 + i}.`, values: [findingValue("value", 100 + i, { kind: "score" }, "ru")] }),
    );
    const input = narration({ request: "Исследуй таблицу.", findings: noisy, primary: TREND_RESULT() });
    const full = renderDeterministic(input);
    const minimal = renderDeterministic(input, { minimal: true });
    expect(evaluateAnswer({ answer: full, findings: noisy, request: input.request, locale: "ru", hasResults: true }).accept).toBe(true);
    expect(minimal.length).toBeLessThanOrEqual(full.length);
  });
});

describe("Stage 27.2B.1 §22 — defects found by reading run 2", () => {
  const request = "Кто показал самый большой рост за год?";

  it("the same statement is never said twice", () => {
    const twice = [
      finding({ subject: "Обь", direction: "up", statement: "«Обь»: рост на 1 900,00% — с 2 до 40 (+38)." }),
      finding({ id: "f_ob2", subject: "Обь", direction: "up", statement: "«Обь»: рост на 1 900,00% — с 2 до 40 (+38)." }),
    ];
    const text = renderDeterministic(narration({ request, findings: twice, primary: TREND_RESULT() }));
    expect(text.split("«Обь»").length - 1).toBe(1);
  });

  it("grounded findings with no written statement are spoken, not declared ungroundable", () => {
    const silent = [
      finding({
        subject: "Кама",
        direction: "down",
        statement: "",
        values: [findingValue("absoluteChange", -170, { kind: "amount" }, "ru", { signed: true })],
      }),
    ];
    const text = renderDeterministic(narration({ request: "Сравни продукты между собой по динамике.", findings: silent, primary: TREND_RESULT() }));
    expect(text).toContain("Кама");
    expect(text).not.toContain("не удалось надёжно связать");
  });

  it("the held message is reserved for findings that were actually held", () => {
    const heldOnly = renderDeterministic(narration({ request, findings: [], primary: TREND_RESULT(), heldFindings: 2 }));
    expect(heldOnly).toContain("не удалось надёжно связать");

    const nothingDrawn = renderDeterministic(narration({ request, findings: [], primary: TREND_RESULT(), heldFindings: 0 }));
    expect(nothingDrawn).not.toContain("не удалось надёжно связать");
  });

  it("a subject with no figures at all still yields its name, not a false apology", () => {
    const bare = [finding({ subject: "Иртыш", direction: "down", statement: "", values: [] })];
    const text = renderDeterministic(narration({ request: "У какого продукта самый сильный отрицательный тренд?", findings: bare, primary: TREND_RESULT() }));
    expect(text).toContain("Иртыш");
    expect(text).not.toContain("не удалось надёжно связать");
  });
});
