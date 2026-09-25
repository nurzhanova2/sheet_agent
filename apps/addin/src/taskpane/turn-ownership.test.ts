// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Stage 28G §14/§16 — the decomposition, pinned as ownership rather than as a
 * file count. Each assertion below is a boundary that would be silently
 * re-crossed by a convenient import, which is exactly how `use-agent.ts`
 * became a 4 369-line routing graph in the first place.
 */
const TASKPANE = join("src", "taskpane");
const USE_AGENT = join(TASKPANE, "use-agent.ts");

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__fixtures__" || entry === "harness") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) productionFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

describe("Stage 28G — turn ownership after the decomposition", () => {
  const useAgent = source(USE_AGENT);

  it("the analytical engine is reached only through the analytical bridge", () => {
    expect(useAgent).not.toContain("analytical-engine-v2/engine.js");
    expect(source(join(TASKPANE, "analytical-turn.ts"))).toContain("analytical-engine-v2/engine.js");
  });

  it("the sandbox capability is wired only by the analytical bridge", () => {
    expect(useAgent).not.toContain("analysis-capability.js");
    expect(source(join(TASKPANE, "analytical-turn.ts"))).toContain("analysis-capability.js");
  });

  it("the flat-records agent loop is reached only through its own module", () => {
    expect(useAgent).not.toContain("agent/agent-loop.js");
    expect(source(join(TASKPANE, "flat-records-turn.ts"))).toContain("agent/agent-loop.js");
  });

  it("the result-action write builders are reached only through the result-action turn", () => {
    expect(useAgent).not.toContain("buildWriteResultActions");
    expect(useAgent).not.toContain("buildCopyRowSetActions");
    expect(source(join(TASKPANE, "result-action-turn.ts"))).toContain("buildWriteResultActions");
  });

  it("the developer surface is rendered in exactly one production module", () => {
    const consumers = productionFiles("src").filter((f) => /getAnalyticalTraces|renderAgentTraces|summarizeTimings/.test(source(f)) && !f.includes("analytical-engine-v2"));
    expect(consumers.map((f) => f.slice("src".length + 1))).toEqual([join("taskpane", "debug-console.ts")]);
  });

  it("no extracted module imports the routing file back", () => {
    for (const name of ["analytical-turn.ts", "flat-records-turn.ts", "result-action-turn.ts", "turn-helpers.ts", "debug-console.ts"]) {
      expect(source(join(TASKPANE, name))).not.toContain("use-agent.js");
    }
  });

  it("every extracted module owns a named responsibility, not a single call", () => {
    for (const name of ["analytical-turn.ts", "flat-records-turn.ts", "result-action-turn.ts", "turn-helpers.ts", "debug-console.ts"]) {
      const lines = source(join(TASKPANE, name)).split("\n").length;
      expect(lines).toBeGreaterThan(80);
    }
  });

  it("the routing file stays a router — it holds no analytical or agent semantics", () => {
    expect(useAgent.split("\n").length).toBeLessThan(2000);
    expect(useAgent.split("\n").filter((l) => l.startsWith("import")).length).toBeLessThan(55);
  });
});
