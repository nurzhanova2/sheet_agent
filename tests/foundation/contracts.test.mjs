import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("tool-call schema encodes version, identity, name and arguments", async () => {
  const schema = JSON.parse(
    await readFile(join(root, "packages/contracts/schemas/v1/tool-call.schema.json"), "utf8"),
  );
  assert.deepEqual(schema.required, ["schemaVersion", "toolCallId", "name", "arguments"]);
  assert.deepEqual(schema.properties.schemaVersion, { const: "1" });
  assert.equal(schema.properties.arguments.type, "object");
});

test("change-set schema requires risk, operations and affected ranges", async () => {
  const schema = JSON.parse(
    await readFile(join(root, "packages/contracts/schemas/v1/change-set.schema.json"), "utf8"),
  );
  for (const field of ["id", "description", "operations", "affectedRanges", "risk", "createdAt"]) {
    assert.ok(schema.required.includes(field));
  }
  assert.deepEqual(schema.properties.risk.enum, ["low", "medium", "high"]);
  assert.equal(schema.properties.operations.minItems, 1);
});

test("agent events carry correlation identifiers", async () => {
  const schema = JSON.parse(
    await readFile(join(root, "packages/contracts/schemas/v1/agent-event.schema.json"), "utf8"),
  );
  for (const field of ["conversationId", "runId", "eventId", "timestamp", "type"]) {
    assert.ok(schema.required.includes(field));
  }
});
