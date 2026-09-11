// Stage 24.5.2 §1 — runtime build identity.
import { describe, expect, it } from "vitest";
import { BUILD_INFO, STAGE, buildInfoLine } from "./build-info.js";

describe("BUILD_INFO", () => {
  it("exposes a non-empty version / buildId / commit and the current stage", () => {
    expect(typeof BUILD_INFO.appVersion).toBe("string");
    expect(BUILD_INFO.appVersion.length).toBeGreaterThan(0);
    expect(typeof BUILD_INFO.buildId).toBe("string");
    expect(BUILD_INFO.buildId.length).toBeGreaterThan(0);
    expect(typeof BUILD_INFO.gitCommit).toBe("string");
    expect(BUILD_INFO.stage).toBe(STAGE);
    expect(STAGE).toBe("24.5.2");
  });

  it("renders a single human identity line", () => {
    const line = buildInfoLine();
    expect(line).toMatch(/^Sheet Agent .+ · Stage 24\.5\.2 · build .+ · .+$/);
  });
});
