import { describe, expect, it } from "vitest";
import {
  filterSlashCommands,
  findSlashCommand,
  groupedSlashCommands,
  isDeterministicSlash,
  SLASH_COMMANDS,
} from "./registry.js";

describe("slash command registry (Stage 22.2 / 23)", () => {
  it("registers the ten Stage 22 commands plus the six Stage 23 workbook commands", () => {
    expect(SLASH_COMMANDS.map((c) => c.name).sort()).toEqual(
      [
        "analyze", "chart", "clean", "filter", "formula", "highlight", "pivot", "sort", "summary", "undo",
        "workbook", "sheets", "find", "compare", "new-sheet", "copy",
      ].sort(),
    );
  });

  it("every command has user-facing copy and no implementation terminology", () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.label).toBe(`/${command.name}`);
      expect(command.description.length).toBeGreaterThan(10);
      expect(command.description).not.toMatch(/goalintent|\bop#\b|planner (output|repair)|dependency id/i);
    }
  });

  it("classifies mutation vs read-only correctly", () => {
    expect(SLASH_COMMANDS.filter((c) => c.mutating).map((c) => c.name).sort()).toEqual(
      ["copy", "formula", "highlight", "new-sheet"].sort(),
    );
    expect(findSlashCommand("chart")?.route).toBe("visualization");
    expect(findSlashCommand("/undo")?.route).toBe("undo");
    expect(findSlashCommand("filter")?.route).toBe("analysis");
    expect(findSlashCommand("workbook")?.route).toBe("analysis");
    expect(findSlashCommand("new-sheet")?.route).toBe("mutation");
  });

  it("findSlashCommand accepts bare name or label, case-insensitively; unknown → undefined", () => {
    expect(findSlashCommand("CHART")?.name).toBe("chart");
    expect(findSlashCommand("/Pivot")?.name).toBe("pivot");
    expect(findSlashCommand("foobar")).toBeUndefined();
  });

  it("filter surfaces /chart for the query 'ch', prefix matches rank first", () => {
    const names = filterSlashCommands("ch").map((c) => c.name);
    expect(names[0]).toBe("chart");
    expect(filterSlashCommands("").length).toBe(SLASH_COMMANDS.length);
    expect(filterSlashCommands("zzz")).toHaveLength(0);
  });

  it("groups filtered commands in category order with empty groups dropped", () => {
    const groups = groupedSlashCommands("");
    expect(groups.map(([category]) => category)).toEqual(["analyze", "transform", "visualize", "create", "history"]);
    const single = groupedSlashCommands("undo");
    expect(single).toHaveLength(1);
    expect(single[0]?.[0]).toBe("history");
  });

  it("marks the argument-free / interpretation-free commands deterministic", () => {
    expect(isDeterministicSlash("analyze")).toBe(true);
    expect(isDeterministicSlash("summary")).toBe(true);
    expect(isDeterministicSlash("pivot")).toBe(true);
    expect(isDeterministicSlash("clean")).toBe(true);
    expect(isDeterministicSlash("chart")).toBe(false);
    expect(isDeterministicSlash("formula")).toBe(false);
  });
});
