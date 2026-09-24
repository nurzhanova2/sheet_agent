import { describeDataset, SANDBOX_INPUT_RULES, type CodeMessage } from "./code-generator.js";
import { renderHistory, renderVariable } from "./analysis-observation.js";
import type { AgentContext, DeterministicTool } from "./analysis-agent.js";
import type { AnalysisActionKind } from "./analysis-decision.js";
import type { SandboxPlan } from "./types.js";

const NEWLINE = String.fromCharCode(10);

/**
 * The decision protocol, stated once.
 *
 * Two lines here are doing most of the work. "A Python error is an
 * observation" is §1 said to the model in the model's own terms — without it,
 * a model trained on chat behaviour apologises and asks what to do instead of
 * reading the error it was just handed. And "COMPLETE names results, never
 * prose" is §21: the failure mode it prevents is a model that has written a
 * satisfying paragraph in its head and treats that as being finished.
 */
const PROTOCOL = [
  "You are an analyst working inside a Python sandbox, one action at a time.",
  "",
  "Each turn you return EXACTLY ONE JSON object and nothing else. No prose, no markdown fences.",
  "",
  "ONE decision, not a plan. Do not send two objects, do not send an array, do not append the",
  "next step you intend to take. You will be asked again — with the RESULT of this action — before",
  "anything else happens, and what that action produced usually changes what the next one should be.",
  "If you send several anyway, ONLY THE FIRST ONE RUNS and the rest are thrown away, so a plan",
  "written ahead of the results is wasted effort.",
  "",
  "@@ACTIONS@@",
  "",
  "INSPECT targets: table.info, table.schema, table.head, variable.summary, variable.head,",
  "variable.shape, variable.dtype, variable.columns, result.preview.",
  "The variable.* targets need a variable name. Inspection is bounded — at most 10 rows.",
  "",
  "YOU ALREADY HAVE THE TABLE'S STRUCTURE. Its columns, their kinds, how many values are missing",
  "from each, and the first rows are all in the message below. Do not spend an action fetching",
  "what you have already been told, and never fetch the same thing twice.",
  "INSPECT is for what you CANNOT already see: a variable YOU created, or what you have emitted",
  "so far. If you can already answer the question from the schema below, go straight to",
  "EXECUTE_CODE.",
  "",
  "HOW THE SESSION WORKS",
  "  Variables you create SURVIVE between EXECUTE_CODE steps. Build `features` in one step and",
  "  use it in the next. Do not rebuild what you already have.",
  "  A step that fails changes nothing — everything from your earlier successful steps is intact.",
  "  You are told what exists after each step. You never have to guess a name.",
  "",
  "WHEN A STEP FAILS",
  "  A Python error is an OBSERVATION, not a failure of the task, and not a reason to apologise",
  "  or to ask the user anything. Read the type, the failing line and the list of what exists,",
  "  then send another EXECUTE_CODE that takes the error into account.",
  "  If a name was wrong, use the real one. If a method does not exist on that type, use the type",
  "  that has it. If shapes did not line up, INSPECT the shapes and align them.",
  "",
  "FINISHING",
  "  Emit results as you go with `result.emit` — the exact forms are at the end of this prompt.",
  "  Then COMPLETE, naming the results you emitted. primaryResultRefs are the ones that ANSWER",
  "  the question; supportingResultRefs are evidence for them.",
  "  COMPLETE names results, never prose. You cannot finish by describing an answer — only by",
  "  pointing at numbers you computed. Someone else writes the answer from them.",
  "",
  "CLARIFY is only for a genuine ambiguity in the REQUEST — which metric, which period, what a",
  "word means. Never because code failed: write different code instead.",
  "",
  "Prefer one coherent operation per step. Do not split mean, std and normalise into three",
  "rounds. Do not write a forty-line program either — a step you can check is worth more.",
].join(NEWLINE);


/**
 * How an iterative analysis records its results.
 *
 * This replaces the one-shot "assign a dict to RESULT" contract, which is
 * actively wrong here: `result` wraps the RESULT that already exists, so
 * rebinding the name detaches the emitter from what gets collected. The first
 * live run did both in one script and recorded half an analysis twice.
 */
const EMISSION = [
  "HOW TO RECORD RESULTS",
  "  Emit as you go, with the `result` object. Do NOT assign to RESULT — rebinding that name",
  "  disconnects it from what gets collected, and your results are lost.",
  "",
  '  result.emit("table",      "cluster_profiles", value=frame)   # a DataFrame',
  '  result.emit("series",     "monthly_growth",   value=series)  # a Series over periods',
  '  result.emit("scalar",     "december_total",   value=3665.0)  # one number',
  '  result.emit("group",      value={"label": "…", "members": ["…"], "profile": {"…": 1.0}})',
  '  result.emit("diagnostic", "silhouette",       value=0.41)',
  "",
  '  result.method("kmeans", {"k": 3}, random_state=0)            # once, naming what you ran',
  '  result.missing_policy("exclude", "rows with gaps are dropped", affected_rows=2)',
  "",
  "  Name each emission after WHAT IT HOLDS, in lowercase English. A table's first column and any",
  "  group member must be a label the data actually carries — never a row number or an index.",
  "",
  "  Then COMPLETE, naming what you emitted. If you name something you never emitted, you will be",
  "  told so and asked again.",
].join(NEWLINE);

/**
 * The system prompt, built for the capabilities this turn ACTUALLY has.
 *
 * `CALL_TOOL` is listed only when deterministic tools are wired. This looks
 * like a detail and was the single largest cause of failure in the live runs:
 * the action was advertised unconditionally, no tools were ever wired, and the
 * model dutifully called one — then another after being refused — until the
 * turn died on CONTROL_FAILURE with the analysis half-finished. Offering a
 * capability that does not exist is not a neutral act; the model believes the
 * prompt.
 */
const ACTION_LINES: Readonly<Record<AnalysisActionKind, string>> = {
  EXECUTE_CODE: '  {"action": "EXECUTE_CODE", "purpose": "...", "code": "..."}',
  INSPECT: '  {"action": "INSPECT", "purpose": "...", "target": "variable.summary", "variable": "features"}',
  CALL_TOOL: '  {"action": "CALL_TOOL", "purpose": "...", "tool": "...", "input": {}}',
  DISCOVER_TOOLS: '  {"action": "DISCOVER_TOOLS", "purpose": "...", "capability": "..."}',
  CLARIFY: '  {"action": "CLARIFY", "question": "...", "candidates": ["...", "..."]}',
  COMPLETE: '  {"action": "COMPLETE", "primaryResultRefs": ["..."], "supportingResultRefs": []}',
};

const ACTION_ORDER: readonly AnalysisActionKind[] = ["EXECUTE_CODE", "INSPECT", "CALL_TOOL", "DISCOVER_TOOLS", "CLARIFY", "COMPLETE"];

export function actionsOf(context: AgentContext): readonly AnalysisActionKind[] {
  if (context.capabilities) return context.capabilities.actions;
  const base: AnalysisActionKind[] = ["EXECUTE_CODE", "INSPECT", "CLARIFY", "COMPLETE"];
  return context.tools.length > 0 ? [...base, "CALL_TOOL"] : base;
}

function systemPrompt(actions: readonly AnalysisActionKind[]): string {
  const offered = ACTION_ORDER.filter((action) => actions.includes(action));
  const lines = offered.map((action) => ACTION_LINES[action]);
  const protocol = PROTOCOL.split(NEWLINE)
    .flatMap((line) => (line === "@@ACTIONS@@" ? lines : [line]))
    .filter((line) => (line.includes("INSPECT targets:") || line.startsWith("The variable.* targets")) && !offered.includes("INSPECT") ? false : true)
    .join(NEWLINE);
  return [protocol, "", "=".repeat(60), "", SANDBOX_INPUT_RULES, "", "=".repeat(60), "", EMISSION].join(NEWLINE);
}

const SYSTEM_CACHE = new Map<string, string>();

function systemFor(actions: readonly AnalysisActionKind[]): string {
  const key = [...actions].sort().join("|");
  const hit = SYSTEM_CACHE.get(key);
  if (hit !== undefined) return hit;
  const built = systemPrompt(actions);
  SYSTEM_CACHE.set(key, built);
  return built;
}

function capabilitySection(context: AgentContext): readonly string[] {
  const purposes = context.capabilities?.purposes ?? [];
  if (purposes.length === 0) return [];
  return ["", "CAPABILITIES AVAILABLE THIS TURN:", ...purposes.map((c) => `  ${c.id} — ${c.purpose}`)];
}

function toolSection(tools: readonly DeterministicTool[]): readonly string[] {
  if (tools.length === 0) return [];
  return [
    "",
    "DETERMINISTIC TOOLS YOU CAN CALL NOW — prefer these over reimplementing them in Python:",
    ...tools.map((tool) => `  ${tool.signature ?? tool.name} — ${tool.summary}`),
  ];
}

/** The objective and the outputs owed, restated every round (§4). */
function objectiveSection(plan: SandboxPlan): readonly string[] {
  const lines = ["ANALYTICAL OBJECTIVE", plan.objective, "", "OUTPUTS THIS ANALYSIS OWES"];
  for (const output of plan.requestedOutputs) lines.push(`  ${output.id} (${output.shape}) — ${output.description}`);
  if (plan.methodConstraints && plan.methodConstraints.length > 0) {
    lines.push("", `METHODS REQUESTED: ${plan.methodConstraints.join(", ")}`);
    if (plan.methodConstraints.length > 1) {
      lines.push("You must actually EXECUTE each of them and compare the results. Naming them is not comparing them.");
    }
  }
  if (plan.assumptions && plan.assumptions.length > 0) lines.push("", "ASSUMPTIONS ALREADY MADE:", ...plan.assumptions.map((a) => `  - ${a}`));
  return lines;
}

/** §4/§10 — the session state, as descriptors. Contents are never inlined. */
function environmentSection(context: AgentContext): readonly string[] {
  if (context.environment.length === 0) return ["WHAT YOU HAVE CREATED SO FAR", "  nothing yet — the prepared views above are all that exists"];
  return ["WHAT YOU HAVE CREATED SO FAR", ...context.environment.map((v) => `  ${renderVariable(v)}`)];
}

/** One decision round, as messages. */
export function buildAgentMessages(context: AgentContext): readonly CodeMessage[] {
  const budget = context.remaining;
  const user = [
    "THE USER ASKED",
    context.request,
    "",
    ...objectiveSection(context.plan),
    "",
    "THE TABLE",
    describeDataset(context.dataset),
    ...capabilitySection(context),
    ...toolSection(context.tools),
    "",
    ...environmentSection(context),
    "",
    "WHAT HAS HAPPENED",
    renderHistory(context.observations),
    "",
    `BUDGET LEFT: ${budget.decisionRounds} decisions, ${budget.codeExecutions} code executions, ${budget.inspections} inspections, ${budget.toolCalls} tool calls.`,
  ];

  // §16 — a protocol correction is stated as a protocol correction. Folding it
  // into the analytical history would teach the model that its last ANALYTICAL
  // move was wrong, when what was wrong was the envelope around it.
  if (context.controlError) {
    user.push(
      "",
      "YOUR LAST RESPONSE WAS NOT A VALID DECISION",
      context.controlError,
      "Send exactly one JSON object in the format above. Nothing before it, nothing after it.",
    );
  }

  // The live run exhausted its rounds four times in ten. The warning used to
  // require BOTH budgets to be nearly gone, which in practice meant it arrived
  // on the last round — too late to be a warning about anything.
  if (budget.decisionRounds <= 3 || budget.codeExecutions <= 1) {
    user.push(
      "",
      `BUDGET IS RUNNING OUT: ${budget.decisionRounds} decision${budget.decisionRounds === 1 ? "" : "s"} and ${budget.codeExecutions} code execution${budget.codeExecutions === 1 ? "" : "s"} left.`,
      "Stop exploring. Compute the requested output in the next EXECUTE_CODE, emit it, and COMPLETE.",
      "An analysis that returns nothing is worse than one that returns less.",
    );
  }

  return [
    { role: "system", content: systemFor(actionsOf(context)) },
    { role: "user", content: user.join(NEWLINE) },
  ];
}

/** §3 — the decision text, with the fences a model adds anyway stripped. */
export function extractDecision(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}
