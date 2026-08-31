import { detectCapabilities, type AddinCapabilities } from "./capabilities.js";

export interface OfficeReadyContext {
  readonly host: Office.HostType;
  readonly platform: Office.PlatformType;
  readonly capabilities: AddinCapabilities;
}

export type OfficeBootstrapErrorCode = "timeout" | "unsupported-host" | "office-unavailable";

export class OfficeBootstrapError extends Error {
  constructor(readonly code: OfficeBootstrapErrorCode, message: string) {
    super(message);
    this.name = "OfficeBootstrapError";
  }
}

export async function waitForOffice(timeoutMs = 10_000): Promise<OfficeReadyContext> {
  if (typeof Office === "undefined") {
    throw new OfficeBootstrapError("office-unavailable", "Office.js is unavailable. Open this page inside Excel.");
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new OfficeBootstrapError("timeout", "Excel took too long to initialize.")),
      timeoutMs,
    );
  });

  try {
    const info = await Promise.race([Office.onReady(), timeout]);
    if (info.host !== Office.HostType.Excel) {
      throw new OfficeBootstrapError("unsupported-host", "This add-in is supported only in Microsoft Excel.");
    }

    return {
      host: info.host,
      platform: info.platform,
      capabilities: detectCapabilities(Office.context.requirements),
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
