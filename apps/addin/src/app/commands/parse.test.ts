import { describe, expect, it } from "vitest";
import { parseSlashInput, resolveSlashSubmission } from "./parse.js";

describe("parseSlashInput (Stage 22.1)", () => {
  it("returns null for ordinary chat", () => {
    expect(parseSlashInput("build a chart of revenue")).toBeNull();
    expect(parseSlashInput("")).toBeNull();
  });

  it("returns a partial (palette query) while the command name is still being typed", () => {
    expect(parseSlashInput("/")).toEqual({ kind: "partial", query: "" });
    expect(parseSlashInput("/ch")).toEqual({ kind: "partial", query: "ch" });
    expect(parseSlashInput("/CHART")).toEqual({ kind: "partial", query: "chart" });
  });

  it("returns a command once whitespace separates the name from the arguments", () => {
    const parsed = parseSlashInput("/chart mean Plan and Fact by Category");
    expect(parsed).toMatchObject({ kind: "command", args: "mean Plan and Fact by Category" });
    expect(parsed?.kind === "command" && parsed.command.name).toBe("chart");
  });

  it("flags an unknown slash token", () => {
    expect(parseSlashInput("/foobar do something")).toEqual({ kind: "unknown", token: "/foobar" });
  });
});

describe("resolveSlashSubmission (submit-time)", () => {
  it("resolves a bare command name with no arguments", () => {
    expect(resolveSlashSubmission("/undo")).toMatchObject({ kind: "command", args: "" });
    expect(resolveSlashSubmission("  /summary  ")).toMatchObject({ kind: "command", args: "" });
  });

  it("keeps the natural-language argument tail", () => {
    const resolved = resolveSlashSubmission("/filter Fact less than Plan");
    expect(resolved).toMatchObject({ kind: "command", args: "Fact less than Plan" });
  });

  it("an unknown command fails safely (never silently another command)", () => {
    expect(resolveSlashSubmission("/foo test")).toEqual({ kind: "unknown", token: "/foo" });
    expect(resolveSlashSubmission("/foo")).toEqual({ kind: "unknown", token: "/foo" });
  });

  it("a lone slash and ordinary chat resolve to null", () => {
    expect(resolveSlashSubmission("/")).toBeNull();
    expect(resolveSlashSubmission("hello")).toBeNull();
  });
});
