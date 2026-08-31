export const ERROR_CODES = [
  "OFFICE_API_ERROR",
  "LLM_ERROR",
  "TOOL_ERROR",
  "VALIDATION_ERROR",
  "PERMISSION_ERROR",
  "RATE_LIMIT",
  "CONTEXT_LIMIT",
  "NETWORK_ERROR",
  "CANCELLED",
  "UNSUPPORTED_CAPABILITY",
  "CONFLICT",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorData {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly correlationId: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(data: AppErrorData, options?: ErrorOptions) {
    super(data.message, options);
    this.name = "AppError";
    this.code = data.code;
    this.retryable = data.retryable;
    this.correlationId = data.correlationId;
    this.details = data.details;
  }
}
