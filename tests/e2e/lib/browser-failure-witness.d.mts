import type { BrowserPumpFailure } from "../../../../apps/desktop/bridge/browser.ts";
export function browserFailureCollector(): {
  failures: BrowserPumpFailure[];
  ingest(chunk: string | Buffer): void;
};
