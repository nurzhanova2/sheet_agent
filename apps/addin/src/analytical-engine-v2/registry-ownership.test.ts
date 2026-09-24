import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { V2_TOOLS, findTool, toolNames } from "./tools/registry.js";
import { projectTools, signatureOf, sharedArgumentsOf } from "./tools/projection.js";
import { capabilityIndex, descriptorOf, toolsOf, usableToolsOf } from "./capability/capability-index.js";
import { CAPABILITY_IDS } from "./capability/capability-model.js";
import { capabilityFactsOf } from "./capability/capability-availability.js";
import { selectCapabilities } from "./capability/capability-selection.js";
import { buildToolContext } from "./capability/tool-context.js";
import { toolCatalogModel } from "./context/build-context.js";
import { validateCall } from "./tools/validator.js";
import { buildToolEnv } from "./tools/registry.js";
import { ResultStore } from "./results/result-store.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { ENGINE_BOUNDS } from "./types.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { createAgentToolRegistry } from "../agent/tool-registry.js";

const table = fixtureOperations();
const periodIndex = buildPeriodIndex(table.schema, table.grids);
const facts = capabilityFactsOf({ schema: table.schema, periodIndex, state: EMPTY_ANALYTICAL_STATE });
const selection = selectCapabilities({ facts });
const context = buildToolContext({ facts, selection });
const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, {
  maxRowsPerResult: ENGINE_BOUNDS.maxRowsPerResult,
  maxResultCells: ENGINE_BOUNDS.maxResultCells,
});
const env = buildToolEnv(table.schema, table.grids, store, EMPTY_ANALYTICAL_STATE);
const codeOf = (outcome: ReturnType<typeof validateCall>): string | null => (outcome.ok ? null : outcome.error.ok ? null : outcome.error.error.code);

describe("one authoritative V2 tool registry", () => {
  it("no tool name is declared twice", () => {
    const names = toolNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("every planner-visible tool is a registry tool", () => {
    for (const name of context.exposedTools) expect(findTool(name), name).toBeDefined();
    for (const name of context.loadedTools) expect(findTool(name), name).toBeDefined();
  });

  it("every registry tool belongs to exactly one declared capability", () => {
    for (const tool of V2_TOOLS) {
      expect(CAPABILITY_IDS, tool.name).toContain(tool.capability);
      const owning = CAPABILITY_IDS.filter((id) => toolsOf(id).some((t) => t.name === tool.name));
      expect(owning, tool.name).toEqual([tool.capability]);
    }
  });

  it("the capability index is a projection of the registry, not a second list", () => {
    const index = capabilityIndex();
    expect(index.total).toBe(V2_TOOLS.length);
    expect([...index.byName.keys()].sort()).toEqual([...toolNames()].sort());
  });

  it("every metadata field a projection shows comes from the tool spec", () => {
    for (const tool of V2_TOOLS) {
      const descriptor = descriptorOf(tool);
      expect(descriptor.id).toBe(tool.name);
      expect(descriptor.capability).toBe(tool.capability);
      expect(descriptor.outputSummary).toBe(tool.returns);
      expect(tool.description.startsWith(descriptor.shortDescription.slice(0, 20))).toBe(true);
    }
  });

  it("the full catalogue and the capability view render a tool identically", () => {
    const model = toolCatalogModel();
    expect(model.entries).toHaveLength(V2_TOOLS.length);
    for (const tool of V2_TOOLS) {
      const entry = model.entries.find((e) => e.name === tool.name)!;
      expect(entry.signature).toBe(signatureOf(tool));
      expect(entry.returns).toBe(tool.returns);
      if (context.loadedTools.includes(tool.name)) expect(context.text).toContain(entry.signature);
    }
  });

  it("the shared-argument rule has one implementation", () => {
    const fromProjection = projectTools(V2_TOOLS).shared;
    expect(fromProjection).toEqual(sharedArgumentsOf(V2_TOOLS));
    for (const arg of fromProjection) expect(arg.uses).toBeGreaterThan(1);
  });
});

describe("the dynamic capability subset is derived, not declared", () => {
  it("exposes fewer tools than the registry holds, and every one of them is usable now", () => {
    expect(context.exposedTools.length).toBeGreaterThan(0);
    expect(context.exposedTools.length).toBeLessThan(V2_TOOLS.length);
    const usable = new Set(CAPABILITY_IDS.flatMap((id) => usableToolsOf(id, facts).map((t) => t.name)));
    for (const name of context.exposedTools) expect(usable, name).toContain(name);
  });

  it("names no tool it did not expose", () => {
    expect(context.leaks).toEqual([]);
  });

  it("a selected capability exposes exactly the registry tools of that capability that are usable", () => {
    for (const id of selection.selected) {
      const expected = usableToolsOf(id, facts).map((t) => t.name);
      for (const name of expected) expect(context.exposedTools, `${id}/${name}`).toContain(name);
    }
  });
});

describe("the runtime validator and the planner schema agree", () => {
  it("a required argument the planner is shown is a required argument the validator enforces", () => {
    for (const tool of V2_TOOLS) {
      const required = Object.entries(tool.args).filter(([, spec]) => spec.required);
      if (required.length === 0) continue;
      expect(codeOf(validateCall({ kind: "tool_call", tool: tool.name, arguments: {} }, env)), tool.name).not.toBeNull();
      expect(signatureOf(tool), tool.name).toContain(`${required[0]![0]}!:`);
    }
  });

  it("an argument no tool declares is refused by name", () => {
    const tool = V2_TOOLS[0]!;
    expect(codeOf(validateCall({ kind: "tool_call", tool: tool.name, arguments: { definitelyNotAnArgument: 1 } }, env))).toBe("INVALID_ARGUMENT");
  });

  it("a tool the registry does not hold is refused", () => {
    expect(codeOf(validateCall({ kind: "tool_call", tool: "not.a.tool", arguments: {} }, env))).toBe("UNKNOWN_TOOL");
  });
});

describe("the flat-records registry stays a separate domain", () => {
  const flatTools = createAgentToolRegistry();

  it("V2 advertises no records-table capability", () => {
    const text = context.text.toLowerCase();
    expect(text).not.toContain("row_records");
    expect(text).not.toContain("group_by");
    expect(text).not.toContain("filter_rows");
  });

  it("the flat-records route keeps its own tools, and they are not V2 tools", () => {
    const flatNames = flatTools.names();
    expect(flatNames.length).toBeGreaterThan(0);
    for (const name of flatNames) expect(findTool(name), name).toBeUndefined();
  });

  it("no tool name is claimed by both registries", () => {
    const overlap = flatTools.names().filter((name) => toolNames().includes(name));
    expect(overlap).toEqual([]);
  });
});

const SRC = "src";

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__fixtures__" || entry === "harness") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) productionFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

describe("the projection helpers have one home", () => {
  it("no production module declares its own signature or shared-argument renderer", () => {
    const offenders = productionFiles(SRC)
      .filter((f) => !f.endsWith(join("tools", "projection.ts")))
      .filter((f) => /function signatureOf|function sharedArgsOf|function summarizeArgs|function ownArgLines\b/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });
});
