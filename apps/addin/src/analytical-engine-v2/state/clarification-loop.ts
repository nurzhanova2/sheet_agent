/** §28 — one clarification that WAS answered, kept with the answer. */
export interface AnsweredClarification {
  readonly signature: string;
  readonly question: string;
  readonly reply: string;
}

const STOP_WORDS = new Set([
  // deliberately generic: articles, pronouns, question words, auxiliaries. Not
  // an analytical vocabulary, and nothing domain-specific belongs here.
  "the", "a", "an", "of", "for", "to", "in", "on", "at", "by", "with", "and", "or",
  "is", "are", "do", "does", "did", "should", "would", "which", "what", "who", "how",
  "you", "your", "me", "my", "it", "this", "that", "these", "those", "want", "like",
  "и", "или", "в", "во", "на", "по", "за", "с", "со", "у", "о", "об", "от", "для",
  "как", "что", "какой", "какая", "какие", "каком", "какого", "чем", "это", "этот",
  "эта", "эти", "вы", "ты", "мне", "вас", "ли", "бы", "не", "хотите", "нужно",
]);

/**
 * §28 — the question's SEMANTIC SLOT, as far as it can be recovered without
 * asking the planner to declare one.
 *
 * Content words, lowercased, de-duplicated, sorted — minus every metric label
 * and period string the table itself supplies. Subtracting those is the whole
 * trick: it is what makes "укажите порог для «Доля брака»" and "укажите порог
 * для «Очередь заявок»" the same signature, and it uses the SCHEMA to do it, so
 * no wording is hardcoded anywhere.
 *
 * Numbers are dropped too — a question that differs only in a number it quotes
 * back is the same question.
 */
export function clarificationSignature(question: string, tableTerms: readonly string[]): string {
  let text = question.toLowerCase();
  // longest first, so "доля брака" is removed before "доля"
  for (const term of [...tableTerms].map((t) => t.toLowerCase()).sort((a, b) => b.length - a.length)) {
    if (term.length < 3) continue;
    while (text.includes(term)) text = text.replace(term, " ");
  }
  const words = text
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 6 ? w.slice(0, 6) : w));
  return [...new Set(words)].sort().join(" ");
}

/** §28 — has this exact slot already been answered in this task? */
export function alreadyAnswered(signature: string, answered: readonly AnsweredClarification[]): AnsweredClarification | null {
  if (signature === "") return null;
  return answered.find((a) => a.signature === signature) ?? null;
}

/**
 * §28/§30 — the protocol feedback sent back to the planner when it asks again.
 *
 * It states the fact and refuses to interpret it. "The user already told you X"
 * — not "the threshold is 20%", which would be the engine deciding what X means
 * and for which output it holds.
 */
export function repeatedClarificationFeedback(prior: AnsweredClarification, language: "ru" | "en"): string {
  return language === "ru"
    ? `Вы уже задавали этот вопрос («${prior.question}»), и пользователь ответил: «${prior.reply}». Этот ответ относится к текущей задаче — примените его и продолжайте. Не задавайте тот же вопрос снова; если он относится не ко всем выходам, решите это сами.`
    : `You already asked this ("${prior.question}") and the user answered: "${prior.reply}". That answer belongs to the task you are working on — apply it and continue. Do not ask the same thing again; if it applies to only some of your outputs, decide that yourself.`;
}

/**
 * §29 — the loop's floor. After the bound is spent the user gets a message that
 * says what is still missing and what was already supplied, so the task is
 * visibly still theirs to steer. It never silently abandons the request, and it
 * never fabricates the value (§30).
 */
export function clarificationLoopMessage(question: string, prior: AnsweredClarification, language: "ru" | "en"): string {
  return language === "ru"
    ? `Не удалось применить ваш ответ «${prior.reply}» — запрос продолжает требовать уточнения: ${question}\n\nПопробуйте задать вопрос одним предложением вместе с этим условием — например, повторите запрос и укажите условие прямо в нём.`
    : `I couldn't apply your answer "${prior.reply}" — the request still needs clarifying: ${question}\n\nTry asking it as a single sentence with that condition included — repeat the request and state the condition inside it.`;
}
