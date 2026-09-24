export type EventFollowupIntent =
  | { readonly kind: "when" }
  | { readonly kind: "magnitude" }
  | { readonly kind: "which_metric" }
  | { readonly kind: "dynamics" }
  | { readonly kind: "before" }
  | { readonly kind: "after" };

const WHEN_RE =
  /когда\s+(?:именно\s+)?это\s+произошл\p{L}*|когда\s+это\s+случил\p{L}*|when\s+(?:exactly\s+)?did\s+(?:this|it)\s+happen/iu;
const MAGNITUDE_RE =
  /наскольк\p{L}*\s+(?:он|она|оно|это)\s+измен\p{L}*|как\s+сильно\s+(?:он|она|оно)\s+измен\p{L}*|how\s+much\s+did\s+(?:it|that)\s+change/iu;
const WHICH_METRIC_RE = /как(?:ой|ая|ое)\s+это\s+показатель|which\s+metric\s+(?:is\s+)?(?:this|that)/iu;
const DYNAMICS_RE =
  /покажи\s+(?:его|её|ее)\s+динамик\p{L}*|show\s+its\s+dynamics|show\s+its\s+time\s+series/iu;
const BEFORE_RE = /что\s+было\s+до\s+этого|what\s+(?:was|came)\s+before\s+(?:this|that)/iu;
const AFTER_RE = /что\s+было\s+после\s+этого|what\s+(?:was|came)\s+after\s+(?:this|that)/iu;

/** Detects an EventRef follow-up. Callers only act on this when a compatible
 *  `lastEventRef` exists — a bare "когда это произошло" with no event in
 *  memory is not this stage's concern. */
export function detectEventFollowup(text: string): EventFollowupIntent | null {
  const t = text.trim();
  if (WHEN_RE.test(t)) return { kind: "when" };
  if (MAGNITUDE_RE.test(t)) return { kind: "magnitude" };
  if (WHICH_METRIC_RE.test(t)) return { kind: "which_metric" };
  if (DYNAMICS_RE.test(t)) return { kind: "dynamics" };
  if (BEFORE_RE.test(t)) return { kind: "before" };
  if (AFTER_RE.test(t)) return { kind: "after" };
  return null;
}
