import { describe, expect, it } from "vitest";
import { boundedHistory, type ConversationMessage } from "./conversation.js";

describe("boundedHistory", () => {
  it("keeps only the most recent messages up to the count limit, oldest first", () => {
    const messages: ConversationMessage[] = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `m${index}`,
    }));
    const result = boundedHistory(messages, 6);
    expect(result).toHaveLength(6);
    expect(result[0]?.content).toBe("m24");
    expect(result[5]?.content).toBe("m29");
  });

  it("drops empty messages and respects the character budget", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "a".repeat(5_000) },
      { role: "assistant", content: "" },
      { role: "user", content: "b".repeat(5_000) },
      { role: "assistant", content: "c".repeat(5_000) },
    ];
    const result = boundedHistory(messages, 16, 8_000);
    expect(result.map((message) => message.content[0])).toEqual(["c"]);
  });

  it("always keeps at least the latest message even if it is large", () => {
    const result = boundedHistory([{ role: "user", content: "x".repeat(50_000) }], 16, 1_000);
    expect(result).toHaveLength(1);
  });
});
