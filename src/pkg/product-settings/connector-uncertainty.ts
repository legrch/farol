import type { ProductSettings } from "./contract";

/** An external app check never implies an uncertain credential or helper write. */
export function connectorRuntimeUncertain(settings: ProductSettings): boolean {
  return (
    settings.connectors.secureMcp.runtime?.state === "outcome_unknown" ||
    (settings.setup.connect.outcomeUnknown &&
      settings.connectors.secureMcp.appVerificationPending !== true)
  );
}
