/** The roles that decode differently. `chat` keeps the provider default. */
export type GenerationRole = "agent" | "planner" | "code" | "narrator" | "evaluator" | "chat";

export interface GenerationProfile {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly seed?: number;
  readonly max_tokens?: number;
}

/**
 * §8 — starting profiles, to be moved by measurement rather than by taste.
 *
 * `chat` is deliberately empty. It is the existing product surface, its
 * behaviour is what users already have, and changing how it samples is not
 * something this stage measured or was asked to do.
 */
export const GENERATION_PROFILES: Readonly<Record<GenerationRole, GenerationProfile>> = {
  // Choosing a tool, a shape, or the next action: there is a right answer and
  // sampling away from it is pure loss.
  agent: { temperature: 0, top_p: 1 },
  planner: { temperature: 0, top_p: 1 },
  // Python. Same argument, more so — a sampled identifier is a NameError.
  code: { temperature: 0, top_p: 1 },
  // Prose. Some freedom produces a better sentence; not so much that it starts
  // inventing structure the findings do not support.
  narrator: { temperature: 0.3, top_p: 0.9, max_tokens: 700 },
  // Judging an answer. A judge that changes its mind between runs is not one.
  evaluator: { temperature: 0, top_p: 1 },
  chat: {},
};

/**
 * §9 — a fixed seed, for diagnostics only.
 *
 * Production does not need one and does not get one: pinning a seed globally
 * would make every user's every turn identical for no benefit. The diagnostic
 * suite sets it so a comparison between two configurations is about the
 * configurations.
 */
export function withSeed(profile: GenerationProfile, seed: number | undefined): GenerationProfile {
  return seed === undefined ? profile : { ...profile, seed };
}

/** The request fields for a role, ready to spread into the JSON body. */
export function generationFields(role: GenerationRole, seed?: number): GenerationProfile {
  return withSeed(GENERATION_PROFILES[role], seed);
}
