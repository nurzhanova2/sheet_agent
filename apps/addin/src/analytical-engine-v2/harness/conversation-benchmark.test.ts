// @vitest-environment node
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { HttpChatClient } from "../../app/chat-client.js";
import { CONVERSATIONS, PARAPHRASE_CONVERSATIONS } from "./conversation-suite.js";
import { runConversation, type ConversationTurnReport } from "./conversation-harness.js";

const endpoint = process.env["SHEET_AGENT_LIVE_ENDPOINT"];
const model = process.env["SHEET_AGENT_LIVE_MODEL"];
const suite = process.env["SHEET_AGENT_LIVE_SUITE"] ?? "main";
const jsonFile = process.env["SHEET_AGENT_LIVE_JSON"];
// a single conversation, for smoke-testing the plumbing without a full run
const only = process.env["SHEET_AGENT_LIVE_CONV"];
const live = Boolean(endpoint && model);

describe.skipIf(!live)("Stage 26.7 §39 — live multi-turn conversation benchmark", () => {
  it(
    "runs the held-out conversations against the real model and reports what happened",
    async () => {
      const chatClient = new HttpChatClient(endpoint!, model!);
      const all = suite === "paraphrase" ? PARAPHRASE_CONVERSATIONS : suite === "all" ? [...CONVERSATIONS, ...PARAPHRASE_CONVERSATIONS] : CONVERSATIONS;
      const conversations = only ? all.filter((c) => c.id === only) : all;
      const turns: ConversationTurnReport[] = [];

      for (const conversation of conversations) {
        const reports = await runConversation({ chatClient, conversation, model: model! });
        turns.push(...reports);
        for (const r of reports) {
          process.stderr.write(
            `  [${r.conversationId}#${r.index}] ${r.outcome}${r.failureClass ? ` ${r.failureClass}` : ""}` +
              `${r.referenceRequired ? ` ref=${r.referenceCorrect ? "ok" : "WRONG"}` : ""} ${r.elapsedMs}ms\n`,
          );
        }
      }

      const required = turns.filter((t) => t.referenceRequired);
      const correct = required.filter((t) => t.referenceCorrect === true);
      process.stderr.write(
        `\n  turns ${turns.length} | reference required ${required.length} | correct ${correct.length} ` +
          `(${required.length > 0 ? ((100 * correct.length) / required.length).toFixed(1) : "—"}%)\n`,
      );

      if (jsonFile) {
        const host = (() => {
          try {
            return new URL(endpoint!).host;
          } catch {
            return "unknown";
          }
        })();
        writeFileSync(
          jsonFile,
          JSON.stringify(
            {
              stage: "26.7",
              generatedAt: new Date().toISOString(),
              endpointHost: host,
              model,
              suite,
              turns: turns.map((t) => ({
                ...t,
                trace: {
                  rounds: t.trace.rounds.map((r) => ({
                    round: r.round,
                    decision: r.decision ?? null,
                    toolError: r.toolError ?? null,
                    toolResultId: r.toolResultId ?? null,
                    decisionProblem: r.decisionProblem ?? null,
                    serialization: r.serialization ?? null,
                  })),
                  budget: t.trace.budget ?? null,
                  stateAfter: t.trace.stateAfter ?? null,
                  narratorStatus: t.trace.narratorStatus ?? null,
                  outcome: t.trace.outcome,
                  failureReason: t.trace.failureReason ?? null,
                },
              })),
            },
            null,
            2,
          ),
          "utf8",
        );
        process.stderr.write(`  wrote ${jsonFile}\n`);
      }
    },
    { timeout: 4 * 60 * 60 * 1000 },
  );
});
