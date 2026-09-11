import { describe, expect, it } from "vitest";
import { detectEventFollowup } from "./event-followup.js";

describe("detectEventFollowup (§20/§21/§40–§43)", () => {
  it("recognises 'когда это произошло' / 'когда именно это произошло'", () => {
    expect(detectEventFollowup("Когда это произошло?")).toEqual({ kind: "when" });
    expect(detectEventFollowup("Когда именно это произошло?")).toEqual({ kind: "when" });
  });

  it("recognises 'насколько он изменился'", () => {
    expect(detectEventFollowup("Насколько он изменился?")).toEqual({ kind: "magnitude" });
  });

  it("recognises 'какой это показатель'", () => {
    expect(detectEventFollowup("Какой это показатель?")).toEqual({ kind: "which_metric" });
  });

  it("recognises 'покажи его динамику'", () => {
    expect(detectEventFollowup("Покажи его динамику.")).toEqual({ kind: "dynamics" });
  });

  it("recognises 'что было до/после этого'", () => {
    expect(detectEventFollowup("Что было до этого?")).toEqual({ kind: "before" });
    expect(detectEventFollowup("Что было после этого?")).toEqual({ kind: "after" });
  });

  it("an unrelated question is not an event follow-up", () => {
    expect(detectEventFollowup("Покажи 5 показателей с наибольшим ростом.")).toBeNull();
    expect(detectEventFollowup("Привет, как дела?")).toBeNull();
  });
});
