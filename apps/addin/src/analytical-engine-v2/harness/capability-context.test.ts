// @vitest-environment node
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { HttpChatClient } from "../../app/chat-client.js";
import { createNodeSandbox } from "./node-sandbox.js";
import { benchmarkPortfolio } from "./sandbox-tables.js";
import { benchmarkOperations } from "./benchmark-tables.js";
import { CAPABILITY_CASES, type CapabilityCase } from "./capability-questions.js";
import { runHarnessTurn, type HarnessTableEnv, type HarnessTurnReport } from "./live-harness.js";
import { countMissingPolicy, countViolations } from "./sandbox-scoring.js";
import { buildToolCatalog } from "../context/build-context.js";
import type { ToolContextTrace } from "../debug/analytical-trace.js";
import type { AnalyticalConversationState } from "../state/conversation-state.js";
import type { EngineTurn } from "../engine.js";

const endpoint = process.env["SHEET_AGENT_LIVE_ENDPOINT"];
const model = process.env["SHEET_AGENT_LIVE_MODEL"];
const outFile = process.env["SHEET_AGENT_CAPABILITY_OUT"];
const onlyCases = (process.env["SHEET_AGENT_CAPABILITY_CASES"] ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
const live = Boolean(endpoint && model);

const NEWLINE = String.fromCharCode(10);
const RULE = "=".repeat(74);

interface Scored {
  readonly probe: CapabilityCase;
  readonly report: HarnessTurnReport;
  readonly outcome: EngineTurn["kind"];
  readonly body: string;
  readonly context?: ToolContextTrace;
  readonly followBody?: string;
  readonly followContext?: ToolContextTrace;
  readonly failureReason?: string;
  readonly failureClass?: string;
  readonly followFailureReason?: string;
  readonly rounds: readonly string[];
  readonly followRounds?: readonly string[];
  readonly gates: {
    readonly advertisedUnavailable: number;
    readonly mutationOffered: number;
    readonly schemaLeaks: number;
    readonly unknownTool: number;
    readonly toolSubstitutions: number;
    readonly callToolNoInvoker: number;
    readonly executeCodeNoRuntime: number;
    readonly silentSubstitutions: number;
    readonly missingToZero: number;
    readonly stalePresentations: number;
    readonly unsafeEscapes: number;
    readonly unnamedSubjectPresented: number;
    readonly unsupportedCausalPresented: number;
    readonly unsupportedNumericPresented: number;
    readonly unsupportedRecommendationsPresented: number;
    readonly rawEvidenceDumpsPresented: number;
  };
  readonly elapsedMs: number;
}

function reasonOf(turn: EngineTurn): string | undefined {
  return turn.kind === "failed" ? `${turn.reason}: ${turn.detail}` : undefined;
}

function roundsOf(report: HarnessTurnReport): readonly string[] {
  return report.trace.rounds.map((r, i) => {
    const decision = r.decision ? (r.decision as { kind?: string; tool?: string }) : null;
    const what = decision ? `${decision.kind ?? "?"}${decision.tool ? ` ${decision.tool}` : ""}` : `parse error: ${r.parseError ?? "?"}`;
    const error = r.toolError ? ` -> ${r.toolError.code}: ${r.toolError.message}` : r.toolResultId ? ` -> ${r.toolResultId}` : "";
    return `  ${i + 1}. ${what}${error}`;
  });
}

function substitutionsIn(report: HarnessTurnReport): number {
  let found = 0;
  for (const round of report.trace.rounds) {
    const decision = round.decision as { kind?: string; tool?: string } | null;
    if (!decision || decision.kind !== "tool_call" || !round.toolResultId || !decision.tool) continue;
    const produced = report.trace.results.find((r) => r.resultId === round.toolResultId);
    if (produced && produced.tool !== decision.tool) found += 1;
  }
  return found;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

describe.skipIf(!live)("Stage 27.2C §50 — targeted live capability review", () => {
  it(
    "runs the capability cases and reports what each turn was actually offered",
    async () => {
      const chatClient = new HttpChatClient(endpoint!, model!);
      const portfolio = benchmarkPortfolio();
      const operations = benchmarkOperations();
      const tables: Record<CapabilityCase["table"], HarnessTableEnv> = {
        portfolio: { schema: portfolio.schema, grids: portfolio.grids },
        operations: { schema: operations.schema, grids: operations.grids },
      };

      const sandbox = createNodeSandbox();
      await sandbox.runtime.validate("RESULT = {}");
      const scored: Scored[] = [];
      const fullCatalogChars = buildToolCatalog().length;

      try {
        const cases = onlyCases.length > 0 ? CAPABILITY_CASES.filter((c) => onlyCases.includes(c.id)) : CAPABILITY_CASES;
        for (const probe of cases) {
          const started = Date.now();
          const first = await runHarnessTurn({
            chatClient,
            table: tables[probe.table],
            question: probe,
            model: model!,
            ...(probe.sandbox ? { runtime: sandbox.runtime } : {}),
          });
          const body = first.turn.kind === "answered" ? first.turn.body : first.turn.kind === "clarify" ? first.turn.question : "";
          const base = countViolations(first.report, first.turn);
          const gapDetail = countMissingPolicy(first.report, false);
          const quality = first.report.trace.answerQuality;
          const context = first.report.trace.toolContext;

          let followBody: string | undefined;
          let followContext: ToolContextTrace | undefined;
          let followFailureReason: string | undefined;
          let followRounds: readonly string[] | undefined;
          if (probe.followUp) {
            const state: AnalyticalConversationState = first.state;
            const second = await runHarnessTurn({
              chatClient,
              table: tables[probe.table],
              question: { ...probe, id: `${probe.id}-follow`, text: probe.followUp },
              model: model!,
              state,
              ...(probe.sandbox ? { runtime: sandbox.runtime } : {}),
            });
            followBody = second.turn.kind === "answered" ? second.turn.body : second.turn.kind === "clarify" ? second.turn.question : "";
            followContext = second.report.trace.toolContext;
            followFailureReason = reasonOf(second.turn);
            followRounds = roundsOf(second.report);
          }

          const offered = new Set(context?.availableCapabilities ?? []);
          const advertisedUnavailable = (probe.forbiddenCapabilities ?? []).filter((id) => offered.has(id)).length;

          scored.push({
            probe,
            report: first.report,
            outcome: first.turn.kind,
            body,
            ...(context ? { context } : {}),
            ...(followBody !== undefined ? { followBody } : {}),
            ...(followContext ? { followContext } : {}),
            ...(followFailureReason ? { followFailureReason } : {}),
            ...(followRounds ? { followRounds } : {}),
            gates: {
              advertisedUnavailable,
              mutationOffered: context?.mutationCapabilityOffered ?? 0,
              schemaLeaks: context?.toolSchemaLeaks ?? 0,
              unknownTool: context?.unknownToolErrors ?? 0,
              toolSubstitutions: substitutionsIn(first.report),
              callToolNoInvoker: context?.callToolWithoutInvoker ?? 0,
              executeCodeNoRuntime: context?.executeCodeWithoutRuntime ?? 0,
              silentSubstitutions: base.counts.silentSubstitutions,
              missingToZero: base.counts.missingToZero + (gapDetail ? 1 : 0),
              stalePresentations: base.counts.stalePresentations,
              unsafeEscapes: base.counts.unsafeEscapes,
              unnamedSubjectPresented: quality?.unnamedSubjectClaimsPresented ?? 0,
              unsupportedCausalPresented: quality?.unsupportedCausalClaimsPresented ?? 0,
              unsupportedNumericPresented: quality?.unsupportedNumericClaimsPresented ?? 0,
              unsupportedRecommendationsPresented: quality?.unsupportedRecommendationsPresented ?? 0,
              rawEvidenceDumpsPresented: quality?.rawEvidenceDumpsPresented ?? 0,
            },
            ...(reasonOf(first.turn) ? { failureReason: reasonOf(first.turn)! } : {}),
            ...(first.report.failureClass ? { failureClass: first.report.failureClass } : {}),
            rounds: roundsOf(first.report),
            elapsedMs: Date.now() - started,
          });

          process.stderr.write(
            `  [${probe.id}] ${first.turn.kind} caps=${context?.availableCapabilityCount ?? 0} ` +
              `exposed=${context?.initiallyExposedToolCount ?? 0} loaded=${context?.initiallyLoadedToolCount ?? 0}->${context?.finalLoadedToolCount ?? 0} ` +
              `called=${context?.calledToolCount ?? 0} toolCtx=${context?.initialToolContextChars ?? 0}ch ${Date.now() - started}ms${NEWLINE}`,
          );
        }
      } finally {
        await sandbox.dispose();
      }

      const gates = {
        advertisedUnavailableCapabilities: scored.reduce((n, s) => n + s.gates.advertisedUnavailable, 0),
        mutationCapabilityInReadOnlyTurn: scored.reduce((n, s) => n + s.gates.mutationOffered, 0),
        toolSchemaLeakOutsideExposedSet: scored.reduce((n, s) => n + s.gates.schemaLeaks, 0),
        unknownToolSilentSubstitution: scored.reduce((n, s) => n + s.gates.toolSubstitutions, 0),
        CALL_TOOLWhenNoInvoker: scored.reduce((n, s) => n + s.gates.callToolNoInvoker, 0),
        EXECUTE_CODEWhenNoRuntime: scored.reduce((n, s) => n + s.gates.executeCodeNoRuntime, 0),
        silentSubstitutionsPresented: scored.reduce((n, s) => n + s.gates.silentSubstitutions, 0),
        missingToZeroPresented: scored.reduce((n, s) => n + s.gates.missingToZero, 0),
        stalePresentations: scored.reduce((n, s) => n + s.gates.stalePresentations, 0),
        unsafeEscapes: scored.reduce((n, s) => n + s.gates.unsafeEscapes, 0),
        unnamedSubjectClaimsPresented: scored.reduce((n, s) => n + s.gates.unnamedSubjectPresented, 0),
        unsupportedCausalClaimsPresented: scored.reduce((n, s) => n + s.gates.unsupportedCausalPresented, 0),
        unsupportedNumericClaimsPresented: scored.reduce((n, s) => n + s.gates.unsupportedNumericPresented, 0),
        unsupportedRecommendationsPresented: scored.reduce((n, s) => n + s.gates.unsupportedRecommendationsPresented, 0),
        rawEvidenceDumpsPresented: scored.reduce((n, s) => n + s.gates.rawEvidenceDumpsPresented, 0),
      };

      const toolCtxChars = scored.map((s) => s.context?.initialToolContextChars ?? 0);
      const promptChars = scored.map((s) => s.context?.initialPromptChars ?? 0);
      const exposedCounts = scored.map((s) => s.context?.initiallyExposedToolCount ?? 0);
      const loadedCounts = scored.map((s) => s.context?.initiallyLoadedToolCount ?? 0);
      const capCounts = scored.map((s) => s.context?.availableCapabilityCount ?? 0);
      const calledCounts = scored.map((s) => s.context?.calledToolCount ?? 0);

      const lines: string[] = [
        "STAGE 27.2C — TARGETED LIVE CAPABILITY REVIEW",
        `model: ${model}`,
        `when: ${new Date().toISOString()}`,
        `cases: ${scored.length}`,
        "",
        "HARD GATES (§52)",
        ...Object.entries(gates).map(([name, value]) => `  ${name} = ${value}${value === 0 ? "" : "   <-- FAIL"}`),
        "",
        "DIAGNOSTICS (not gates — a refusal is the protection, not the violation)",
        `  unknownToolRefusals        ${scored.reduce((n, s) => n + s.gates.unknownTool, 0)}`,
        `  capabilityUnavailableErrors ${scored.reduce((n, s) => n + (s.context?.capabilityUnavailableErrors ?? 0), 0)}`,
        `  toolDiscoveryRequests      ${scored.reduce((n, s) => n + (s.context?.toolDiscoveryRequests ?? 0), 0)}`,
        "",
        "CONTEXT SIZE (§28 — chars, not tokens)",
        `  full registry serialization   ${fullCatalogChars} chars`,
        `  tool context   median ${median(toolCtxChars)}  max ${Math.max(...toolCtxChars)}  (${Math.round((1 - median(toolCtxChars) / fullCatalogChars) * 100)}% off median)`,
        `  whole prompt   median ${median(promptChars)}  max ${Math.max(...promptChars)}`,
        "",
        "SELECTION (§29)",
        `  capabilities visible   median ${median(capCounts)}  max ${Math.max(...capCounts)}`,
        `  tools exposed          median ${median(exposedCounts)}  max ${Math.max(...exposedCounts)}`,
        `  tool contracts loaded  median ${median(loadedCounts)}  max ${Math.max(...loadedCounts)}`,
        `  tools actually called  median ${median(calledCounts)}  max ${Math.max(...calledCounts)}`,
        "",
        RULE,
      ];

      for (const s of scored) {
        const c = s.context;
        lines.push(
          "",
          `## ${s.probe.id} — ${s.outcome}`,
          `question: ${s.probe.text}`,
          `why this case: ${s.probe.why}`,
          `sandbox wired: ${s.probe.sandbox}`,
          "",
          `initial capabilities: ${c?.availableCapabilities.join(", ") ?? "(none recorded)"}`,
          `selected up front:    ${c?.selectedCapabilities.join(", ") ?? "-"}`,
          `tools exposed=${c?.initiallyExposedToolCount ?? 0} loaded=${c?.initiallyLoadedToolCount ?? 0} -> ${c?.finalLoadedToolCount ?? 0} called=${c?.calledToolCount ?? 0}`,
          `EXECUTE_CODE available: ${c?.availableCapabilities.includes("sandbox") ?? false}   CALL_TOOL available: ${(c?.initiallyExposedToolCount ?? 0) > 0}`,
          `capability errors: unavailable=${c?.capabilityUnavailableErrors ?? 0} unknownTool=${c?.unknownToolErrors ?? 0} discovery=${c?.toolDiscoveryRequests ?? 0} leaks=${c?.toolSchemaLeaks ?? 0}`,
          `tool context ${c?.initialToolContextChars ?? 0} chars of ${fullCatalogChars} full; prompt ${c?.initialPromptChars ?? 0} chars`,
          `latency ${s.elapsedMs}ms (planner ${s.report.stages.plannerMs}ms, sandbox ${s.report.stages.sandboxExecMs}ms, narration ${s.report.stages.narrationMs}ms)`,
          `ANALYSIS: requested=${s.report.analysis?.requested ?? false} attempts=${s.report.analysis?.attempts ?? 0}${s.report.analysis?.failureCode ? ` failure=${s.report.analysis.failureCode}` : ""}`,
          "",
          ...(s.failureReason ? [`FAILED: ${s.failureReason}`, `failure class: ${s.failureClass ?? "-"}`, "PLANNER ROUNDS:", ...s.rounds, ""] : []),
          "ANSWER AS THE READER SEES IT:",
          "-".repeat(74),
          s.body === "" ? "(no answer)" : s.body,
          "-".repeat(74),
        );
        if (s.followBody !== undefined) {
          lines.push(
            "",
            `FOLLOW-UP: ${s.probe.followUp}`,
            `follow-up capabilities: ${s.followContext?.availableCapabilities.join(", ") ?? "(none recorded)"}`,
            `follow-up tools exposed=${s.followContext?.initiallyExposedToolCount ?? 0} loaded=${s.followContext?.initiallyLoadedToolCount ?? 0}`,
            ...(s.followFailureReason ? [`FAILED: ${s.followFailureReason}`, "PLANNER ROUNDS:", ...(s.followRounds ?? [])] : []),
            "-".repeat(74),
            s.followBody === "" ? "(no answer)" : s.followBody,
            "-".repeat(74),
          );
        }
        const drafts = s.report.trace.answerQuality?.rejectedDrafts ?? [];
        for (const draft of drafts) {
          lines.push("", `REJECTED ${draft.stage.toUpperCase()} (§48 — observability only, never shown to the user)`, `  gate: ${draft.gateReasons.join("; ") || "-"}`, `  evaluator: ${draft.evaluatorIssues.join(", ") || "-"}`, `  text: ${draft.text.replace(/\s+/gu, " ").slice(0, 400)}`);
        }
      }

      const text = lines.join(NEWLINE);
      if (outFile) writeFileSync(outFile, text, "utf8");
      process.stdout.write(NEWLINE + text.slice(0, 6000) + NEWLINE);

      expect(scored.length).toBe(onlyCases.length > 0 ? onlyCases.length : CAPABILITY_CASES.length);
      expect(gates).toEqual({
        advertisedUnavailableCapabilities: 0,
        mutationCapabilityInReadOnlyTurn: 0,
        toolSchemaLeakOutsideExposedSet: 0,
        unknownToolSilentSubstitution: 0,
        CALL_TOOLWhenNoInvoker: 0,
        EXECUTE_CODEWhenNoRuntime: 0,
        silentSubstitutionsPresented: 0,
        missingToZeroPresented: 0,
        stalePresentations: 0,
        unsafeEscapes: 0,
        unnamedSubjectClaimsPresented: 0,
        unsupportedCausalClaimsPresented: 0,
        unsupportedNumericClaimsPresented: 0,
        unsupportedRecommendationsPresented: 0,
        rawEvidenceDumpsPresented: 0,
      });
    },
    45 * 60 * 1000,
  );
});
