import type { ProductSettings } from "./contract";

/**
 * The fenced Settings document a retained credential recovery is bound to.
 * Main derives it from its in-memory retained state; a window only compares it.
 * `tunnelId` is the tunnel the stored key was written for, which a retry must
 * repeat; it is an identifier, not a secret, and is null when the recovery
 * only releases the fence.
 */
export type CredentialRecovery = Readonly<{
  generation: number;
  revision: number;
  tunnelId: string | null;
}>;

/** An external app check never implies an uncertain credential or helper write. */
export function connectorRuntimeUncertain(settings: ProductSettings): boolean {
  return (
    settings.connectors.secureMcp.runtime?.state === "outcome_unknown" ||
    (settings.setup.connect.outcomeUnknown &&
      settings.connectors.secureMcp.appVerificationPending !== true)
  );
}
