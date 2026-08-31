import type { ToolCallId } from "./ids.js";

export type ToolPermission = "read" | "analysis" | "write" | "destructive";

export interface ToolCall<TArguments extends Readonly<Record<string, unknown>>> {
  readonly schemaVersion: "1";
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly arguments: TArguments;
}

export interface ToolSuccess<TData> {
  readonly success: true;
  readonly data: TData;
  readonly metadata: {
    readonly executionTimeMs: number;
    readonly affectedRange?: string;
  };
}

export interface ToolFailure {
  readonly success: false;
  readonly error: { readonly code: string; readonly message: string };
}

export type ToolResult<TData> = ToolSuccess<TData> | ToolFailure;
