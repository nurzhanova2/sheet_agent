export interface AddinCapabilities {
  readonly excelApi12: boolean;
  readonly excelApi13: boolean;
  readonly excelApi14: boolean;
  readonly sharedRuntime12: boolean;
}

interface RequirementSets {
  isSetSupported(name: string, minimumVersion?: string): boolean;
}

export function detectCapabilities(requirements: RequirementSets): AddinCapabilities {
  return Object.freeze({
    excelApi12: requirements.isSetSupported("ExcelApi", "1.2"),
    excelApi13: requirements.isSetSupported("ExcelApi", "1.3"),
    excelApi14: requirements.isSetSupported("ExcelApi", "1.4"),
    sharedRuntime12: requirements.isSetSupported("SharedRuntime", "1.2"),
  });
}
