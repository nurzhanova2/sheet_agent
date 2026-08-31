import { describe, expect, it } from "vitest";
import { QwenApiKeyStore } from "./qwen-key-store.js";

describe("QwenApiKeyStore", () => {
  it("stores and clears a local key without exposing it in a workbook contract", () => {
    const values = new Map<string, string>();
    const store = new QwenApiKeyStore({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } });
    store.set(" qwen-test ");
    expect(store.get()).toBe("qwen-test");
    store.clear();
    expect(store.get()).toBeUndefined();
  });
});
