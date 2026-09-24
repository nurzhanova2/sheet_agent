import { hasWorkbookDeixis, isConceptQuestion, isMutationRequest, routeTurn } from "../../app/conversation-route.js";
import { isAnalyticalFollowUp, isExploratoryRequest } from "../../app/analytical-turn.js";
import { detectResultAction } from "../../app/result-action-intent.js";
import { detectResultTransform } from "../../app/result-transforms.js";
import { isUndoPhrase } from "../../app/conversation-memory.js";
import type { ResultRef } from "../../app/session-memory.js";
import type { OwnershipContext } from "./turn-owner.js";

export interface TurnFacts {
  readonly canPlan: boolean;
  readonly isSlash: boolean;
  readonly hasSelection: boolean;
  readonly lastV1Result: ResultRef | undefined;
  readonly v1ResultCount: number;
  readonly v1ClarificationPending: boolean;
  readonly v2ClarificationPending: boolean;
  readonly hasV2Table: boolean;
}

export function buildOwnershipContext(text: string, facts: TurnFacts): Omit<OwnershipContext, "hasTable" | "selectionIsForeign"> {
  const route = routeTurn(text, {
    hasSelection: facts.hasSelection,
    knownEntities: [],
    hasPriorResult: facts.v1ResultCount > 0,
  });
  const concept = isConceptQuestion(text);
  const mutation = isMutationRequest(text);
  const resultAction = detectResultAction(text) !== null;
  return {
    canPlan: facts.canPlan,
    isSlash: facts.isSlash,
    isUndo: isUndoPhrase(text),
    hasResultAction: resultAction,
    isMutation: mutation,
    isResultTransform: facts.lastV1Result !== undefined && detectResultTransform(text, facts.lastV1Result).kind === "transform",
    hasV1Result: facts.v1ResultCount > 0,
    v1ClarificationPending: facts.v1ClarificationPending,
    v2ClarificationPending: facts.v2ClarificationPending,
    isTopicSwitch: concept || mutation || resultAction || (route.route !== "general_chat" && text.trim().split(/\s+/).length >= 4),
    hasV2Table: facts.hasV2Table,
    isConceptQuestion: concept,
    hasWorkbookDeixis: hasWorkbookDeixis(text),
    isAnalytical:
      route.route === "workbook_analysis" || route.route === "workbook_qa" || route.route === "mixed" || isExploratoryRequest(text),
    isAnalyticalFollowUp: isAnalyticalFollowUp(text),
    route,
  };
}
