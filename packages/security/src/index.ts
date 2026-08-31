export type PermissionClass = "read" | "analysis" | "write" | "destructive";

const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{8,}/g, /Bearer\s+[A-Za-z0-9._-]+/gi, /api[_-]?key\s*[:=]\s*[^\s,}]+/gi];
export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), value);
}
export * from "./enterprise.js";
