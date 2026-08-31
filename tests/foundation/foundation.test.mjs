import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));

async function filesUnder(path) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else output.push(absolute);
    }
  }
  await visit(join(root, path));
  return output;
}

test("workspace declares every application and shared package", async () => {
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);

  const expectedPackages = [
    "apps/addin",
    "apps/server",
    "packages/application",
    "packages/agent",
    "packages/excel-adapter-officejs",
    "packages/excel-tools",
    "packages/changes",
    "packages/analysis",
    "packages/llm",
    "packages/contracts",
    "packages/security",
    "packages/observability",
    "packages/testkit",
  ];

  for (const packagePath of expectedPackages) {
    const manifest = await readJson(`${packagePath}/package.json`);
    assert.equal(manifest.private, true, `${packagePath} must remain private`);
    assert.equal(manifest.type, "module", `${packagePath} must be ESM`);
    assert.equal(manifest.exports["."], "./src/index.ts", `${packagePath} must expose a typed entry point`);
  }
});

test("versioned foundation schemas have stable ids and reject unspecified fields", async () => {
  const schemas = [
    "tool-call.schema.json",
    "tool-result.schema.json",
    "agent-event.schema.json",
    "change-set.schema.json",
    "api-error.schema.json",
  ];

  for (const name of schemas) {
    const schema = await readJson(`packages/contracts/schemas/v1/${name}`);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /^https:\/\/schemas\.sheet-agent\.local\/v1\//);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0);
  }
});

test("error catalog contains every architecture error class", async () => {
  const source = await readFile(join(root, "packages/contracts/src/errors.ts"), "utf8");
  for (const code of [
    "OFFICE_API_ERROR",
    "LLM_ERROR",
    "TOOL_ERROR",
    "VALIDATION_ERROR",
    "PERMISSION_ERROR",
    "RATE_LIMIT",
    "CONTEXT_LIMIT",
    "NETWORK_ERROR",
    "CANCELLED",
    "UNSUPPORTED_CAPABILITY",
    "CONFLICT",
  ]) {
    assert.match(source, new RegExp(`\\b${code}\\b`), `${code} is missing`);
  }
});

test("configuration is parsed from explicit input and never exposes secrets", async () => {
  const source = await readFile(join(root, "packages/application/src/config.ts"), "utf8");
  assert.match(source, /parseAppConfig/);
  assert.match(source, /Record<string, string \| undefined>/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /API_KEY|SECRET|TOKEN/);
});

test("feature flags are typed and default to the safest state", async () => {
  const source = await readFile(join(root, "packages/application/src/feature-flags.ts"), "utf8");
  for (const flag of ["customFunctions", "localAi", "mcp", "pythonSandbox", "attachments"]) {
    assert.match(source, new RegExp(`${flag}: false`), `${flag} must default to false`);
  }
});

test("configuration parser enforces HTTPS and safe defaults", async () => {
  const { parseAppConfig } = await import("../../packages/application/src/config.ts");
  const config = parseAppConfig({ SHEET_AGENT_API_BASE_URL: "https://api.example.test" });
  assert.equal(config.environment, "development");
  assert.equal(config.logLevel, "info");
  assert.equal(config.apiBaseUrl.href, "https://api.example.test/");
  assert.throws(
    () => parseAppConfig({ SHEET_AGENT_API_BASE_URL: "http://api.example.test" }),
    /must use HTTPS/,
  );
});

test("feature flag resolver is immutable and opt-in", async () => {
  const { resolveFeatureFlags, SAFE_FEATURE_DEFAULTS } = await import(
    "../../packages/application/src/feature-flags.ts"
  );
  assert.deepEqual(SAFE_FEATURE_DEFAULTS, {
    customFunctions: false,
    localAi: false,
    mcp: false,
    pythonSandbox: false,
    attachments: false,
  });
  assert.deepEqual(resolveFeatureFlags({ attachments: true }), {
    ...SAFE_FEATURE_DEFAULTS,
    attachments: true,
  });
  assert.ok(Object.isFrozen(SAFE_FEATURE_DEFAULTS));
});

test("application errors preserve stable codes and safe metadata", async () => {
  const { AppError } = await import("../../packages/contracts/src/errors.ts");
  const error = new AppError({
    code: "CONTEXT_LIMIT",
    message: "Range is too large",
    retryable: false,
    correlationId: "run-1",
  });
  assert.equal(error.name, "AppError");
  assert.equal(error.code, "CONTEXT_LIMIT");
  assert.equal(error.retryable, false);
  assert.equal(error.correlationId, "run-1");
});

test("Office.js imports are confined to the Office.js adapter and add-in host", async () => {
  const sourceFiles = (await filesUnder(".")).filter(
    (file) => /\.(?:ts|tsx|js|jsx|mjs)$/.test(file) && !file.includes("node_modules"),
  );
  const violations = [];

  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    if (!/(?:from\s+["']office-js["']|Office\.context|Excel\.run)/.test(source)) continue;
    const path = relative(root, file).replaceAll("\\", "/");
    if (!path.startsWith("packages/excel-adapter-officejs/") && !path.startsWith("apps/addin/")) {
      violations.push(path);
    }
  }

  assert.deepEqual(violations, []);
});

test("architecture governance documents are present", async () => {
  for (const path of [
    "documentation/adr/README.md",
    "documentation/adr/0001-office-web-addin.md",
    "documentation/adr/0002-production-backend.md",
    "documentation/adr/0003-local-changeset-execution.md",
    "documentation/adr/0004-sse-streaming.md",
    "documentation/adr/0005-local-snapshot-storage.md",
    "documentation/THREAT_MODEL.md",
    "documentation/DATA_CLASSIFICATION.md",
    "documentation/DEVELOPMENT.md",
  ]) {
    const contents = await readFile(join(root, path), "utf8");
    assert.ok(contents.length > 100, `${path} should contain an actionable decision`);
  }
});
