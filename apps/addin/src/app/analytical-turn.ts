const FOLLOW_UP_OPENER_RE = /^\s*(?:а\s+)?(?:теперь|тогда|дальше|затем|now|then|next)(?![\p{L}])/iu;
const FOLLOW_UP_PARTITIVE_RE =
  /(?<![\p{L}])(?:из\s+(?:них|этих|этого|тех|списка|набора)|среди\s+них|у\s+них|among\s+(?:them|those|these)|of\s+(?:them|those|these)|from\s+(?:them|those|these))(?![\p{L}])/iu;
const FOLLOW_UP_RESTRICTOR_RE =
  /(?<![\p{L}])(?:только|лишь|оставь|отфильтруй|исключи|only|just\s+the|filter|keep|exclude)(?![\p{L}])/iu;

export function isAnalyticalFollowUp(text: string): boolean {
  return FOLLOW_UP_OPENER_RE.test(text) || FOLLOW_UP_PARTITIVE_RE.test(text) || FOLLOW_UP_RESTRICTOR_RE.test(text);
}

const EXPLORATORY_RE =
  /необычн\p{L}*|подозрительн\p{L}*|стоит\s+провер\p{L}*|worth\s+check\p{L}*|\bunusual\b|что\s+(?:здесь\s+)?интересн\p{L}*|если\s+бы\s+тебе\s+нужно\s+было\s+выбрать|which\s+.{0,15}worth\s+investigat/iu;

export function isExploratoryRequest(text: string): boolean {
  return EXPLORATORY_RE.test(text);
}
