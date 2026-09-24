import type { ToolSpec } from "../tools/contracts.js";
import { CAPABILITY_PURPOSE, type CapabilityFacts, type CapabilityId } from "./capability-model.js";
import { capabilityIndex, descriptorOf, usableToolsOf, type CapabilityIndex } from "./capability-index.js";
import { capabilityStates, type CapabilityState } from "./capability-availability.js";
import type { CapabilitySelection } from "./capability-selection.js";

const NEWLINE = String.fromCharCode(10);

const HEADER = [
  "Each tool is written as  name(argument:type, \u2026) \u2192 resultType .  \"!\" marks a REQUIRED argument; every other argument is optional.",
  "Types: string, number, boolean, string[], value (a number or a string), object; resultRef / metricRef / periodRef are all the resultId STRING of an earlier result.",
  "Wherever an argument has both a literal and a \u2026Ref form, pass the Ref form when you already hold that result.",
  "Every tool listed below is callable right now, and carries its full argument contract. Tools shown with a one-line purpose keep their longer notes in reserve — ask for a capability by name to read them.",
].join(NEWLINE);

export interface SharedArg {
  readonly name: string;
  readonly type: string;
  readonly describe: string;
  readonly uses: number;
}

export interface ToolContextModel {
  readonly capabilities: readonly CapabilityState[];
  readonly availableCapabilities: readonly CapabilityId[];
  readonly selectedCapabilities: readonly CapabilityId[];
  readonly exposedTools: readonly string[];
  readonly loadedTools: readonly string[];
  readonly absentTools: readonly string[];
  readonly shared: readonly SharedArg[];
  readonly leaks: readonly string[];
  readonly text: string;
}

const TOOL_TOKEN = /[a-z_]+\.[a-z_*]+/gu;
const EXAMPLE_LIST = /\(e\.g\. from ([^)]*)\)/gu;

function absentIn(text: string, exposed: ReadonlySet<string>, known: ReadonlySet<string>): readonly string[] {
  const found = text.match(TOOL_TOKEN) ?? [];
  return found.filter((token) => {
    const base = token.endsWith(".*") ? token.slice(0, -2) : token;
    if (token.endsWith(".*")) return ![...exposed].some((name) => name.startsWith(`${base}.`));
    return known.has(token) && !exposed.has(token);
  });
}

function filterExamples(text: string, exposed: ReadonlySet<string>, known: ReadonlySet<string>): string {
  return text.replace(EXAMPLE_LIST, (whole, list: string) => {
    const items = list
      .split(/,\s*|\s+or\s+/u)
      .map((item) => item.trim())
      .filter((item) => item !== "");
    const kept = items.filter((item) => !known.has(item) || exposed.has(item));
    if (kept.length === items.length) return whole;
    if (kept.length === 0) return "";
    const tail = kept.length === 1 ? kept[0]! : `${kept.slice(0, -1).join(", ")} or ${kept[kept.length - 1]!}`;
    return `(e.g. from ${tail})`;
  });
}

function dropAbsentFragments(text: string, exposed: ReadonlySet<string>, known: ReadonlySet<string>): string {
  const pieces = text.split(/(?<=[.;])\s+/u);
  const kept = pieces.filter((piece) => absentIn(piece, exposed, known).length === 0);
  if (kept.length === pieces.length) return text;
  return kept.join(" ").replace(/\s{2,}/gu, " ").trim();
}

export function withoutAbsentTools(text: string, exposed: ReadonlySet<string>, known: ReadonlySet<string>): string {
  const filtered = filterExamples(text, exposed, known).replace(/\s{2,}/gu, " ").replace(/\s+—/gu, " —").trim();
  return absentIn(filtered, exposed, known).length === 0 ? filtered : dropAbsentFragments(filtered, exposed, known);
}

function sharedArgsOf(tools: readonly ToolSpec[]): readonly SharedArg[] {
  const uses = new Map<string, { name: string; type: string; describe: string; uses: number }>();
  for (const tool of tools) {
    for (const [name, spec] of Object.entries(tool.args)) {
      const key = `${name}\u0000${spec.type}\u0000${spec.describe}`;
      const entry = uses.get(key) ?? { name, type: spec.type, describe: spec.describe, uses: 0 };
      entry.uses += 1;
      uses.set(key, entry);
    }
  }
  return [...uses.values()].filter((e) => e.uses > 1).sort((a, b) => a.name.localeCompare(b.name));
}

function signatureOf(tool: ToolSpec): string {
  const args = Object.entries(tool.args);
  return `${tool.name}(${args.map(([n, spec]) => `${n}${spec.required ? "!" : ""}:${spec.type}`).join(", ")})`;
}

function ownArgLines(tool: ToolSpec, sharedKeys: ReadonlySet<string>, clean: (text: string) => string): readonly string[] {
  return Object.entries(tool.args)
    .filter(([n, spec]) => !sharedKeys.has(`${n}\u0000${spec.type}\u0000${spec.describe}`))
    .map(([n, spec]) => `${n} \u2014 ${clean(spec.describe)}`);
}

function contractLines(tool: ToolSpec, sharedKeys: ReadonlySet<string>, clean: (text: string) => string): string {
  const own = ownArgLines(tool, sharedKeys, clean);
  return `- ${signatureOf(tool)} \u2192 ${tool.returns}${NEWLINE}  ${clean(tool.description)}${own.length > 0 ? `${NEWLINE}  ${own.join("; ")}` : ""}`;
}

function descriptorLine(tool: ToolSpec, sharedKeys: ReadonlySet<string>, clean: (text: string) => string): string {
  const own = ownArgLines(tool, sharedKeys, clean);
  return `- ${signatureOf(tool)} \u2192 ${tool.returns}${NEWLINE}  ${clean(descriptorOf(tool).shortDescription)}${own.length > 0 ? `${NEWLINE}  ${own.join("; ")}` : ""}`;
}

export interface ToolContextInput {
  readonly facts: CapabilityFacts;
  readonly selection: CapabilitySelection;
  readonly index?: CapabilityIndex;
}

export function buildToolContext(input: ToolContextInput): ToolContextModel {
  const index = input.index ?? capabilityIndex();
  const states = capabilityStates(input.facts, index);
  const { available, selected, exposed, loaded } = input.selection;
  const loadedNames = new Set(loaded.map((t) => t.name));
  const exposedNameSet = new Set(exposed.map((t) => t.name));
  const knownNames = new Set(index.byName.keys());
  const clean = (text: string): string => withoutAbsentTools(text, exposedNameSet, knownNames);
  const shared = sharedArgsOf(exposed);
  const sharedKeys = new Set(shared.map((e) => `${e.name}\u0000${e.type}\u0000${e.describe}`));

  const summary = available.map((id) => {
    const state = states.find((s) => s.id === id)!;
    const count = state.toolCount > 0 ? ` (${state.toolCount} tool${state.toolCount === 1 ? "" : "s"})` : "";
    return `- ${id}${count} \u2014 ${CAPABILITY_PURPOSE[id]}`;
  });

  const blocks: string[] = [];
  for (const id of available) {
    const tools = usableToolsOf(id, input.facts, index);
    if (tools.length === 0) continue;
    const rendered = tools.map((tool) => (loadedNames.has(tool.name) ? contractLines(tool, sharedKeys, clean) : descriptorLine(tool, sharedKeys, clean)));
    blocks.push(`${id.toUpperCase()}${NEWLINE}${rendered.join(NEWLINE)}`);
  }

  const text = [
    HEADER,
    "",
    "CAPABILITIES AVAILABLE THIS TURN:",
    ...summary,
    "",
    ...(shared.length > 0 ? ["ARGUMENTS THAT MEAN THE SAME IN EVERY TOOL THAT TAKES THEM:", ...shared.map((e) => `  ${e.name} (${e.type}) \u2014 ${clean(e.describe)}`), ""] : []),
    ...blocks,
  ].join(NEWLINE);

  const exposedNames = exposed.map((t) => t.name);
  const absent = [...knownNames].filter((name) => !exposedNameSet.has(name));
  const leaks = absent.filter((name) => text.includes(name));

  return {
    capabilities: states,
    availableCapabilities: available,
    selectedCapabilities: selected,
    exposedTools: exposedNames,
    loadedTools: [...loadedNames],
    absentTools: absent,
    shared,
    leaks,
    text,
  };
}
