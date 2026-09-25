const INTERNAL_ID_RE = /\b(res|fact|event|analysis)_[a-z0-9_]+\b/i;
const LEGACY_LEAK_RE = /\bFAILED\b|ANALYSIS RESULT|\brejected\b|\(rejected\)|requested operation\(s\)|analysis unavailable|Анализ недоступен/i;
const TOOL_NAME_LEAK_RE = /\b(resultId|AgentObservation|tool_call|ExprNode|UNRESOLVED_METRIC|derive\.compute|set\.filter)\b/i;
const CANONICAL_FIELD_LEAK_RE = /\b(?:startPeriodCanonical|endPeriodCanonical|periodCanonical|metricCanonical|start\s*period\s*canonical|end\s*period\s*canonical|source\s*cells?)\b/i;
const INTERNAL_FIELD_LEAK_RE =
  /\b\w+\s+in\s+#\d+\b|#\d+\s*[:)]|\bdirection\s+(?:increasing|decreasing)\b|\bmatched\s*=\s*\d\b|\bsource\s+observation\b|\bresult\s+row\b|\btool\s+output\b/i;
const RAW_JSON_LEAK_RE = /^\s*\{|"kind"\s*:\s*"(?:tool_call|clarify|final)"|"tool"\s*:\s*"[a-z_][a-z0-9_.]*"/i;

export function containsForbiddenLeak(text: string): boolean {
  return (
    TOOL_NAME_LEAK_RE.test(text) ||
    INTERNAL_ID_RE.test(text) ||
    LEGACY_LEAK_RE.test(text) ||
    RAW_JSON_LEAK_RE.test(text) ||
    INTERNAL_FIELD_LEAK_RE.test(text) ||
    CANONICAL_FIELD_LEAK_RE.test(text)
  );
}
