import { WorkbookContextManager, type WorkbookContext } from "@sheet-agent/application";
import { OfficeJsExcelPort } from "@sheet-agent/excel-adapter-officejs";

export type WorkbookContextConnector = (listener: (context: WorkbookContext) => void) => Promise<() => void>;

export const connectWorkbookContext: WorkbookContextConnector = async (listener) => {
  const manager = new WorkbookContextManager(new OfficeJsExcelPort(), { debounceMs: 100 });
  manager.subscribe(listener);
  await manager.start();
  return () => manager.dispose();
};
