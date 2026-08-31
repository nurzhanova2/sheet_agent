export type ExtensionPermission = "read" | "analysis" | "write";
export interface McpTool { readonly name: string; readonly description?: string; readonly permission: ExtensionPermission; }
export interface McpServer { readonly id: string; readonly endpoint: string; readonly tools: readonly McpTool[]; readonly enabled: boolean; readonly trusted: boolean; }
export interface McpInvocation { readonly serverId: string; readonly toolName: string; readonly arguments: Readonly<Record<string, unknown>>; readonly consent: boolean; readonly allowedRange?: string; }
export interface McpTransport { invoke(server: McpServer, tool: McpTool, args: Readonly<Record<string, unknown>>): Promise<unknown>; }

export class McpHttpTransport implements McpTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 30_000) {}
  async invoke(server: McpServer, tool: McpTool, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(server.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: tool.name, arguments: args } }), signal: controller.signal });
      if (!response.ok) throw new Error(`MCP transport HTTP ${response.status}`);
      const payload = await response.json() as { result?: unknown; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message ?? "MCP tool failed");
      if (!("result" in payload)) throw new Error("Invalid MCP response");
      return payload.result;
    } finally { clearTimeout(timer); }
  }
}

export class McpRegistry {
  readonly #servers = new Map<string, McpServer>();
  register(server: McpServer): void {
    if (!/^https?:\/\//.test(server.endpoint)) throw new Error("MCP endpoint must use HTTP(S)");
    if (this.#servers.has(server.id)) throw new Error("MCP server id already registered");
    const names = new Set<string>();
    for (const tool of server.tools) { if (names.has(tool.name)) throw new Error("MCP tool name collision"); names.add(tool.name); }
    this.#servers.set(server.id, server);
  }
  setEnabled(id: string, enabled: boolean): void { const server = this.#servers.get(id); if (!server) throw new Error("MCP server not found"); this.#servers.set(id, { ...server, enabled }); }
  list(): readonly McpServer[] { return [...this.#servers.values()]; }
  async invoke(call: McpInvocation, transport: McpTransport): Promise<unknown> {
    const server = this.#servers.get(call.serverId); if (!server || !server.enabled) throw new Error("MCP server disabled");
    const tool = server.tools.find((candidate) => candidate.name === call.toolName); if (!tool) throw new Error("MCP tool not allowed");
    if (!call.consent) throw new Error("MCP consent required");
    if (tool.permission === "read" && !call.allowedRange) throw new Error("MCP workbook scope required");
    const result = await transport.invoke(server, tool, call.arguments);
    return { data: result, provenance: { serverId: server.id, tool: tool.name, endpoint: server.endpoint } };
  }
}

export interface Skill { readonly id: string; readonly version: string; readonly digest: string; readonly trusted: boolean; readonly steps: readonly string[]; }
export class SkillRegistry {
  readonly #history = new Map<string, Skill[]>();
  constructor(private readonly requireTrusted = true) {}
  install(skill: Skill): void { if (this.requireTrusted && !skill.trusted) throw new Error("Untrusted skill rejected"); const versions = this.#history.get(skill.id) ?? []; if (versions.some((item) => item.version === skill.version)) throw new Error("Skill version already installed"); this.#history.set(skill.id, [...versions, skill]); }
  current(id: string): Skill | undefined { return this.#history.get(id)?.at(-1); }
  rollback(id: string): Skill | undefined { const versions = this.#history.get(id); if (!versions || versions.length < 2) return versions?.[0]; versions.pop(); return versions.at(-1); }
}

export interface SkillSignatureVerifier { verify(skill: Skill): Promise<boolean>; }
export class SignedSkillRegistry extends SkillRegistry {
  constructor(private readonly verifier: SkillSignatureVerifier) { super(true); }
  async installSigned(skill: Skill): Promise<void> { if (!await this.verifier.verify(skill)) throw new Error("Skill signature invalid"); super.install({ ...skill, trusted: true }); }
}

export interface SandboxLimits { readonly timeoutMs: number; readonly memoryMb: number; readonly maxOutputBytes: number; readonly network: boolean; readonly filesystem: "none" | "readonly"; }
export interface SandboxExecutor { execute(code: string, input: unknown, limits: SandboxLimits): Promise<{ readonly output: unknown; readonly artifact?: { readonly name: string; readonly mediaType: string; readonly bytes: number } }>; }
export function validateSandboxLimits(limits: SandboxLimits): void { if (limits.timeoutMs < 1 || limits.timeoutMs > 120_000) throw new Error("Invalid sandbox timeout"); if (limits.memoryMb < 16 || limits.memoryMb > 4096) throw new Error("Invalid sandbox memory limit"); if (limits.maxOutputBytes < 1 || limits.maxOutputBytes > 10_000_000) throw new Error("Invalid sandbox output limit"); if (limits.network) throw new Error("Sandbox network must be disabled"); }
export async function runSandbox(executor: SandboxExecutor, code: string, input: unknown, limits: SandboxLimits) { validateSandboxLimits(limits); if (!code.trim()) throw new Error("Python code is required"); return executor.execute(code, input, limits); }

export class HttpSandboxExecutor implements SandboxExecutor {
  constructor(private readonly endpoint: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async execute(code: string, input: unknown, limits: SandboxLimits) {
    const response = await this.fetchImpl(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, input, limits }) });
    if (!response.ok) throw new Error(`Sandbox HTTP ${response.status}`);
    const payload = await response.json() as { output?: unknown; artifact?: { name?: unknown; mediaType?: unknown; bytes?: unknown } };
    if (!("output" in payload)) throw new Error("Invalid sandbox response");
    if (payload.artifact && (typeof payload.artifact.name !== "string" || typeof payload.artifact.mediaType !== "string" || typeof payload.artifact.bytes !== "number" || payload.artifact.bytes > limits.maxOutputBytes)) throw new Error("Sandbox artifact exceeds output policy");
    return payload as { output: unknown; artifact?: { name: string; mediaType: string; bytes: number } };
  }
}
