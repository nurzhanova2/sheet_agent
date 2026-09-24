import type { HarnessQuestion } from "./live-harness.js";

export type CapabilityTable = "portfolio" | "operations";

export interface CapabilityCase extends HarnessQuestion {
  readonly table: CapabilityTable;
  readonly why: string;
  /** Does this case need the analytical sandbox wired for the turn? */
  readonly sandbox: boolean;
  /** A second request sent on the state the first turn produced. */
  readonly followUp?: string;
  /** Capabilities that must NOT appear in the turn's initial context. */
  readonly forbiddenCapabilities?: readonly string[];
  /** Capabilities the turn is expected to have. */
  readonly expectedCapabilities?: readonly string[];
}

export const CAPABILITY_CASES: readonly CapabilityCase[] = [
  {
    id: "cc-1-deterministic-comparison",
    table: "portfolio",
    text: "На сколько выросла Ангара за год?",
    concepts: ["change", "direct_answer"],
    why: "§33 — a simple deterministic comparison must keep a small context and the same answer",
    sandbox: false,
    forbiddenCapabilities: ["sandbox", "mutation", "visualization", "references"],
    expectedCapabilities: ["schema", "periods", "comparison"],
  },
  {
    id: "cc-2-deterministic-ranking",
    table: "portfolio",
    text: "Назови три продукта с самым сильным падением.",
    concepts: ["ranking", "entity_subject"],
    why: "§33 — ranking tools are not exposed as contracts up front and must still be reached",
    sandbox: false,
    forbiddenCapabilities: ["sandbox", "mutation", "references"],
    expectedCapabilities: ["schema", "periods", "ranking"],
  },
  {
    id: "cc-3-sandbox-clustering",
    table: "portfolio",
    text: "Кластеризуй продукты по динамике.",
    concepts: ["clustering", "sandbox"],
    why: "§34 — the sandbox capability must be visible, and no workbook mutation tool with it",
    sandbox: true,
    forbiddenCapabilities: ["mutation", "visualization"],
    expectedCapabilities: ["sandbox", "schema"],
  },
  {
    id: "cc-4-exploratory",
    table: "portfolio",
    text: "Исследуй таблицу и найди что-нибудь необычное.",
    concepts: ["exploration", "sandbox"],
    why: "§35 — open exploration may reach further, but never the whole catalogue at once",
    sandbox: true,
    forbiddenCapabilities: ["mutation", "visualization"],
    expectedCapabilities: ["sandbox", "statistics"],
  },
  {
    id: "cc-5-hybrid",
    table: "portfolio",
    text: "Возьми последний период и предыдущий, посчитай изменение по каждому продукту и раздели продукты на три кластера по величине изменения.",
    concepts: ["hybrid", "periods", "sandbox"],
    why: "§24/§36 — exact deterministic period resolution plus a clustering operation no deterministic tool performs, in one loop",
    sandbox: true,
    forbiddenCapabilities: ["mutation"],
    expectedCapabilities: ["periods", "sandbox"],
  },
  {
    id: "cc-6-follow-up",
    table: "portfolio",
    text: "Назови три продукта с самым сильным падением.",
    followUp: "А теперь сравни только эти три между собой.",
    concepts: ["follow_up", "references"],
    why: "§26 — the follow-up turn must gain the references it actually holds, and no more",
    sandbox: false,
    expectedCapabilities: ["references"],
  },
  {
    id: "cc-7-no-sandbox",
    table: "portfolio",
    text: "Кластеризуй продукты по динамике.",
    concepts: ["no_runtime", "refusal"],
    why: "§38 — with no runtime the sandbox is never advertised and Python is never promised",
    sandbox: false,
    forbiddenCapabilities: ["sandbox", "mutation", "visualization"],
  },
  {
    id: "cc-8-mutation-request",
    table: "operations",
    text: "Покрась красным строки, где загрузка линии упала.",
    concepts: ["mutation", "capability_absent"],
    why: "§16/§39 — a read-only analytical turn has no mutation capability and must not pretend otherwise",
    sandbox: false,
    forbiddenCapabilities: ["mutation", "visualization"],
  },
];

export const TARGETED_CAPABILITY_IDS: readonly string[] = CAPABILITY_CASES.map((c) => c.id);
