export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  readonly role: ConversationRole;
  readonly content: string;
}

export const HISTORY_MAX_MESSAGES = 16;
export const HISTORY_MAX_CHARS = 12_000;

/**
 * Returns the most recent slice of a conversation that fits inside the message-count and
 * character budgets, oldest-first. Never sends an unbounded transcript to the model.
 * A trailing empty assistant placeholder (created when a request starts) is dropped.
 */
export function boundedHistory(
  messages: readonly ConversationMessage[],
  maxMessages: number = HISTORY_MAX_MESSAGES,
  maxChars: number = HISTORY_MAX_CHARS,
): ConversationMessage[] {
  const cleaned = messages.filter((message) => message.content.trim().length > 0);
  const recent = cleaned.slice(-maxMessages);
  const kept: ConversationMessage[] = [];
  let budget = maxChars;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    if (!message) continue;
    const cost = message.content.length + 16;
    if (kept.length > 0 && cost > budget) break;
    kept.unshift(message);
    budget -= cost;
  }
  return kept;
}
