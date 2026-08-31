export interface FeatureFlags {
  readonly customFunctions: boolean;
  readonly localAi: boolean;
  readonly mcp: boolean;
  readonly pythonSandbox: boolean;
  readonly attachments: boolean;
}

export const SAFE_FEATURE_DEFAULTS: FeatureFlags = Object.freeze({
  customFunctions: false,
  localAi: false,
  mcp: false,
  pythonSandbox: false,
  attachments: false,
});

export function resolveFeatureFlags(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
  return Object.freeze({ ...SAFE_FEATURE_DEFAULTS, ...overrides });
}
