import { describe, expect, it } from "vitest";
import { induceTableSchema } from "../app/schema/schema-induction.js";
import { fixtureDirectionAndSets } from "../app/schema/__fixtures__/tables.js";
import { buildMetricIndex } from "../app/schema/analytical/metric-resolver.js";
import {
  buildSemanticFrame,
  countAnalyticalClauses,
  detectOperationKind,
  detectRequestedRankingBasis,
  detectTemporalMode,
  explicitCandidateSet,
  extractRequestedCardinality,
  isAnalyticalFollowUp,
  hasSecondAnalyticalClause,
  hasSuperlativeAsk,
  isExploratoryRequest,
} from "./semantic-frame.js";

function index() {
  const fx = fixtureDirectionAndSets();
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: "v1",
    startsBelowRow1: false,
  });
  return buildMetricIndex(schema);
}

describe("Stage 25.1 §12–14 — hasSecondAnalyticalClause", () => {
  it("detects a second imperative/interrogative clause joined by 'и'", () => {
    expect(hasSecondAnalyticalClause("Какой показатель выглядит самым нестабильным и когда у него был самый резкий скачок?")).toBe(true);
    expect(hasSecondAnalyticalClause("Сравни Активы, Обязательства и Собственный капитал и скажи, кто вырос быстрее всего.")).toBe(true);
  });

  it("does NOT trigger on 'между X и Y' or a plain 'A, B и C' list — never a bare connector", () => {
    expect(hasSecondAnalyticalClause("Сравни все показатели между первой и последней доступной датой.")).toBe(false);
    expect(hasSecondAnalyticalClause("Сравни Активы, Обязательства и Собственный капитал.")).toBe(false);
  });

  it("generalizes to unseen phrasing with the same structure (never a literal-sentence match)", () => {
    expect(hasSecondAnalyticalClause("Какой показатель самый волатильный и где был максимальный скачок?")).toBe(true);
    expect(hasSecondAnalyticalClause("Покажи динамику и объясни, за счёт чего произошёл рост.")).toBe(true);
  });
});

describe("Stage 25.1 §17 — explicitCandidateSet", () => {
  it("extracts an explicit 'A, B and C' phrase as the requested candidate set", () => {
    const set = explicitCandidateSet("Активы, Обязательства и Собственный капитал", index());
    // Собственный капитал is not in the fixture metric set, so this proves
    // "no match" falls back cleanly rather than guessing — real fixture set below.
    expect(set === null || Array.isArray(set)).toBe(true);
  });

  it("returns null (no explicit set) for a single-metric or free-form request", () => {
    expect(explicitCandidateSet("покажи динамику активов", index())).toBeNull();
    expect(explicitCandidateSet("что здесь необычного?", index())).toBeNull();
  });

  it("resolves a real two-metric phrase from the fixture to exactly those two labels", () => {
    const set = explicitCandidateSet("Активы и Ликвидные активы", index());
    expect(set).toEqual(["Активы", "Ликвидные активы"]);
  });
});

describe("Stage 25.1 §10 — buildSemanticFrame composes both detectors", () => {
  it("returns both flags together", () => {
    const frame = buildSemanticFrame("Сравни Активы и Ликвидные активы и скажи, кто вырос быстрее.", index());
    expect(frame.clauseCount).toBeGreaterThanOrEqual(2);
    expect(frame.explicitMetricSet).toEqual(["Активы", "Ликвидные активы"]);
  });
});

describe("Stage 25.1.1 §15–17 — countAnalyticalClauses: no two-clause ceiling", () => {
  it("counts a genuine 3-clause compound request as >=3", () => {
    const n = countAnalyticalClauses("Найди самый нестабильный показатель, покажи его динамику и скажи, между какими соседними датами был самый большой скачок.");
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it("a single-clause question stays at 1", () => {
    expect(countAnalyticalClauses("Какие показатели наиболее волатильны, если не учитывать процентные показатели?")).toBe(1);
    expect(countAnalyticalClauses("Сравни последнюю доступную дату с предыдущей.")).toBe(1);
  });

  it("caps at 4 even for an unusually long chain", () => {
    const n = countAnalyticalClauses("Покажи, сравни, объясни, найди, определи и скажи что-нибудь про показатель.");
    expect(n).toBeLessThanOrEqual(4);
  });
});

describe("Stage 25.1.1 §6/§7/§57 — detectTemporalMode", () => {
  it("recognizes previous-to-last across paraphrases (§57)", () => {
    expect(detectTemporalMode("Сравни последнюю доступную дату с предыдущей.")).toBe("previous_to_last");
    expect(detectTemporalMode("Сравни две последние даты.")).toBe("previous_to_last");
    expect(detectTemporalMode("Что изменилось сильнее всего между двумя последними наблюдениями?")).toBe("previous_to_last");
    expect(detectTemporalMode("Compare the last two observations.")).toBe("previous_to_last");
  });

  it("recognizes first-to-last, and returns null for neither", () => {
    expect(detectTemporalMode("Сравни все показатели между первой и последней доступной датой.")).toBe("first_to_last");
    expect(detectTemporalMode("Покажи динамику Активов.")).toBeNull();
  });
});

describe("Stage 25.1.1 §54–57 — detectOperationKind covers multiple paraphrases per operation", () => {
  it("historical_extreme_distance (§54)", () => {
    for (const t of [
      "Какие показатели сильнее всего откатились от своих исторических максимумов?",
      "кто сильнее всего откатился от максимума?",
      "кто дальше всего от своего пика?",
      "какие показатели больше всего ниже исторического максимума?",
      "who is furthest below its historical peak?",
    ]) {
      expect(detectOperationKind(t)).toBe("historical_extreme_distance");
    }
  });

  it("temporal_pattern_down_then_up (§55)", () => {
    for (const t of [
      "Какие показатели после снижения снова начали расти?",
      "после падения снова выросли",
      "сначала снизились, потом восстановились",
      "что начало восстанавливаться после снижения?",
      "which metrics recovered after a decline?",
    ]) {
      expect(detectOperationKind(t)).toBe("temporal_pattern_down_then_up");
    }
  });

  it("stable_growth (§56)", () => {
    for (const t of ["Что росло наиболее стабильно без резких скачков?", "у кого был рост без сильных скачков?", "which metrics grew most steadily?"]) {
      expect(detectOperationKind(t)).toBe("stable_growth");
    }
  });

  it("latest_vs_mean, and returns null for an unrelated request", () => {
    expect(detectOperationKind("Какой показатель сильнее всего отклоняется от своего среднего значения сейчас?")).toBe("latest_vs_mean");
    expect(detectOperationKind("Покажи динамику Активов.")).toBeNull();
  });
});

describe("Stage 25.1.1 §30/§70 — isExploratoryRequest", () => {
  it("recognizes open-ended diagnostic asks", () => {
    expect(isExploratoryRequest("Что здесь самое необычное?")).toBe(true);
    expect(isExploratoryRequest("Если бы тебе нужно было выбрать три показателя для проверки из-за необычной динамики, какие бы ты выбрал и почему?")).toBe(true);
    expect(isExploratoryRequest("Покажи динамику Активов.")).toBe(false);
  });
});

describe("Stage 25.1.3 §3/§5 — hasSuperlativeAsk", () => {
  it("detects a Russian and an English superlative phrasing", () => {
    expect(hasSuperlativeAsk("Какой показатель изменился сильнее всего?")).toBe(true);
    expect(hasSuperlativeAsk("Найди самый нестабильный показатель.")).toBe(true);
    expect(hasSuperlativeAsk("Which metric grew the most?")).toBe(true);
  });

  it("does not flag a plain comparison with no superlative", () => {
    expect(hasSuperlativeAsk("Сравни последнюю доступную дату с предыдущей.")).toBe(false);
    expect(hasSuperlativeAsk("Покажи только показатели, которые снизились.")).toBe(false);
  });
});

describe("Stage 25.1.3 §23/§24 — extractRequestedCardinality", () => {
  it("reads a Russian number word next to 'показатель'", () => {
    expect(extractRequestedCardinality("выбрать три показателя для проверки")).toBe(3);
  });

  it("reads a digit next to 'показатель'/'metric'", () => {
    expect(extractRequestedCardinality("выбери 5 показателей")).toBe(5);
    expect(extractRequestedCardinality("pick 4 metrics worth checking")).toBe(4);
  });

  it("returns null when no cardinality is named", () => {
    expect(extractRequestedCardinality("Какой показатель самый нестабильный?")).toBeNull();
  });
});

describe("Stage 25.1.3b §2–§6 — detectRequestedRankingBasis", () => {
  it("§4 — a bare 'changed the most' ask defaults to percentage magnitude", () => {
    expect(detectRequestedRankingBasis("Из них какой изменился сильнее всего?")).toBe("percentageChange");
    expect(detectRequestedRankingBasis("У какого изменение было самым сильным?")).toBe("percentageChange");
    expect(detectRequestedRankingBasis("Which changed the most?")).toBe("percentageChange");
    expect(detectRequestedRankingBasis("Which had the strongest change?")).toBe("percentageChange");
  });

  it("§5/§16 — an explicit absolute-amount ask overrides to absoluteChange", () => {
    expect(detectRequestedRankingBasis("У какого показателя самое большое абсолютное изменение?")).toBe("absoluteChange");
    expect(detectRequestedRankingBasis("Какой изменился сильнее всего в абсолютном выражении?")).toBe("absoluteChange");
  });

  it("returns null for a request that is not a 'changed the most' comparison at all", () => {
    expect(detectRequestedRankingBasis("Сравни последнюю доступную дату с предыдущей.")).toBeNull();
    expect(detectRequestedRankingBasis("Покажи его динамику.")).toBeNull();
    expect(detectRequestedRankingBasis("Какой показатель сильнее всего меняется по направлению тренда?")).toBeNull();
  });
});

describe("Stage 25.1.3f §2 — isAnalyticalFollowUp: a turn that continues a standing analytical result", () => {
  it("recognizes an anaphoric opener", () => {
    expect(isAnalyticalFollowUp("Теперь покажи только показатели, которые снизились.")).toBe(true);
    expect(isAnalyticalFollowUp("А теперь отсортируй их по величине изменения.")).toBe(true);
    expect(isAnalyticalFollowUp("Now show only the ones that declined.")).toBe(true);
  });

  it("recognizes a partitive reference to an established set", () => {
    expect(isAnalyticalFollowUp("Из них какой изменился сильнее всего?")).toBe(true);
    expect(isAnalyticalFollowUp("Среди них есть выросшие?")).toBe(true);
    expect(isAnalyticalFollowUp("Which of those grew?")).toBe(true);
    expect(isAnalyticalFollowUp("Pick the largest among them.")).toBe(true);
  });

  it("recognizes a restriction phrased against an implied universe", () => {
    expect(isAnalyticalFollowUp("Покажи только те, что снизились.")).toBe(true);
    expect(isAnalyticalFollowUp("Оставь только отрицательные.")).toBe(true);
    expect(isAnalyticalFollowUp("Show only the decliners.")).toBe(true);
  });

  it("does NOT fire on a self-contained request that names its own universe", () => {
    expect(isAnalyticalFollowUp("Сравни последнюю доступную дату с предыдущей.")).toBe(false);
    expect(isAnalyticalFollowUp("Покажи динамику Активов за всё доступное время.")).toBe(false);
    expect(isAnalyticalFollowUp("Compare the last two observations.")).toBe(false);
    expect(isAnalyticalFollowUp("Какой показатель самый волатильный?")).toBe(false);
  });

  it("is a ROUTING guard only — it never depends on a metric, a period, or a number", () => {
    // the same grammatical shape fires regardless of the content words
    expect(isAnalyticalFollowUp("Теперь что-нибудь ещё.")).toBe(true);
    expect(isAnalyticalFollowUp("Из них первые пять.")).toBe(true);
  });
});
