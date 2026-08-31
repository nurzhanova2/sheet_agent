export type EnvironmentName = "development" | "test" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  readonly apiBaseUrl: URL;
  readonly environment: EnvironmentName;
  readonly logLevel: LogLevel;
}

const environments = new Set<EnvironmentName>(["development", "test", "production"]);
const logLevels = new Set<LogLevel>(["debug", "info", "warn", "error"]);

export function parseAppConfig(input: Record<string, string | undefined>): AppConfig {
  const rawUrl = input["SHEET_AGENT_API_BASE_URL"];
  if (!rawUrl) throw new Error("SHEET_AGENT_API_BASE_URL is required");

  const apiBaseUrl = new URL(rawUrl);
  if (apiBaseUrl.protocol !== "https:" && apiBaseUrl.hostname !== "localhost") {
    throw new Error("SHEET_AGENT_API_BASE_URL must use HTTPS outside localhost");
  }

  const environment = input["SHEET_AGENT_ENVIRONMENT"] ?? "development";
  if (!environments.has(environment as EnvironmentName)) throw new Error("Invalid environment");

  const logLevel = input["SHEET_AGENT_LOG_LEVEL"] ?? "info";
  if (!logLevels.has(logLevel as LogLevel)) throw new Error("Invalid log level");

  return { apiBaseUrl, environment: environment as EnvironmentName, logLevel: logLevel as LogLevel };
}
