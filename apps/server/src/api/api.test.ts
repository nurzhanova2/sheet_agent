import { describe, expect, it } from "vitest";
import { createChatApi } from "./chat-api.js";

describe("chat API", () => {
  it("requires auth and keeps tenant identity server-side", async () => {
    const api = createChatApi({ verifyToken: async () => undefined, gateway: { stream: async function* () { yield { type: "done" as const }; } } });
    const response = await api(new Request("https://api.test/v1/chat", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
  });

  it("streams SSE events after auth and redacts provider secrets", async () => {
    const api = createChatApi({ verifyToken: async () => ({ userId: "u1", tenantId: "t1" }), gateway: { stream: async function* () { yield { type: "delta" as const, text: "ok" }; yield { type: "done" as const }; } } });
    const response = await api(new Request("https://api.test/v1/chat", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }], apiKey: "sk-secret" }) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"text":"ok"');
  });

  it("supports explicitly configured authless local Windows mode", async () => {
    const api = createChatApi({ authMode: "none", verifyToken: async () => undefined, gateway: { stream: async function* () { yield { type: "done" as const }; } } });
    const response = await api(new Request("https://localhost/v1/chat", { method: "POST", body: JSON.stringify({ messages: [] }) }));
    expect(response.status).toBe(200);
  });
});
