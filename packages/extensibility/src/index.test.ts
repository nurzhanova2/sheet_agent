import { describe, expect, it, vi } from "vitest";
import { McpHttpTransport, McpRegistry, SignedSkillRegistry, SkillRegistry, HttpSandboxExecutor, runSandbox, type McpServer } from "./index.js";

const server: McpServer = { id: "docs", endpoint: "https://mcp.example", enabled: true, trusted: true, tools: [{ name: "search", permission: "read" }] };
describe("extensibility trust boundaries", () => {
  it("requires consent and workbook scope, and returns provenance", async () => {
    const registry = new McpRegistry(); registry.register(server);
    await expect(registry.invoke({ serverId: "docs", toolName: "search", arguments: { q: "x" }, consent: false, allowedRange: "Sheet1!A1" }, { invoke: vi.fn() })).rejects.toThrow("consent");
    await expect(registry.invoke({ serverId: "docs", toolName: "search", arguments: { q: "x" }, consent: true }, { invoke: vi.fn() })).rejects.toThrow("scope");
    const result = await registry.invoke({ serverId: "docs", toolName: "search", arguments: { q: "x" }, consent: true, allowedRange: "Sheet1!A1" }, { invoke: async () => ({ answer: "ok" }) });
    expect(result).toMatchObject({ provenance: { serverId: "docs", tool: "search" } });
  });
  it("supports trusted skill upgrades and rollback", () => { const registry = new SkillRegistry(); registry.install({ id: "report", version: "1", digest: "a", trusted: true, steps: ["clean"] }); registry.install({ id: "report", version: "2", digest: "b", trusted: true, steps: ["clean", "chart"] }); expect(registry.current("report")?.version).toBe("2"); expect(registry.rollback("report")?.version).toBe("1"); expect(() => registry.install({ id: "x", version: "1", digest: "x", trusted: false, steps: [] })).toThrow("Untrusted"); });
  it("uses JSON-RPC MCP transport and verifies signed skills", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: "1", result: { rows: [] } }));
    const transport = new McpHttpTransport(fetchImpl); const result = await transport.invoke(server, server.tools[0]!, { q: "x" }); expect(result).toEqual({ rows: [] }); expect(fetchImpl).toHaveBeenCalledOnce();
    const skills = new SignedSkillRegistry({ verify: async (skill) => skill.digest === "trusted" }); await skills.installSigned({ id: "x", version: "1", digest: "trusted", trusted: false, steps: [] }); await expect(skills.installSigned({ id: "y", version: "1", digest: "bad", trusted: false, steps: [] })).rejects.toThrow("invalid");
  });
  it("enforces a networkless Python sandbox policy", async () => { const executor = { execute: vi.fn(async () => ({ output: { mean: 2 } })) }; await expect(runSandbox(executor, "print(1)", [1, 2, 3], { timeoutMs: 5_000, memoryMb: 256, maxOutputBytes: 10_000, network: true, filesystem: "none" })).rejects.toThrow("network"); await expect(runSandbox(executor, "print(1)", [1], { timeoutMs: 5_000, memoryMb: 256, maxOutputBytes: 10_000, network: false, filesystem: "none" })).resolves.toMatchObject({ output: { mean: 2 } }); });
  it("rejects sandbox responses that exceed artifact limits", async () => { const executor = new HttpSandboxExecutor("https://sandbox.test", async () => Response.json({ output: 1, artifact: { name: "x", mediaType: "text/csv", bytes: 999 } })); await expect(runSandbox(executor, "print(1)", [], { timeoutMs: 1000, memoryMb: 128, maxOutputBytes: 10, network: false, filesystem: "none" })).rejects.toThrow("artifact"); });
});
