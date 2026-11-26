import { connectorRuntimeUncertain } from "../../../src/pkg/product-settings/connector-uncertainty";
import type { ProductSettings } from "../../../src/pkg/product-settings/contract";
import {
  ContinuityWriteIntentSchema,
  type ContinuityWriteFence,
} from "../../../src/apps/desktop/workspace-continuity-writer";

// The pure admission decision of the trusted continuity commit: whether the
// intent is well-formed, settings are loaded, delivery is not fenced, the
// connector runtime is not outcome-unknown and the fence carries all three
// callbacks. It never calls the fence: the service consults the fence's own
// currentness, withdrawal ACK and native requalification in its own order,
// around its awaits and the conditional save, and answers UNKNOWN itself when a
// save or a rejection cannot be proven. A refusal here only ever means "not
// written".
export function continuityCommitAdmissible(
  intent: unknown,
  settings: ProductSettings | null,
  deliveryFenced: boolean,
  fence: ContinuityWriteFence | undefined,
): settings is ProductSettings {
  return !(
    !ContinuityWriteIntentSchema.safeParse(intent).success ||
    settings === null ||
    deliveryFenced ||
    connectorRuntimeUncertain(settings) ||
    typeof fence?.current !== "function" ||
    typeof fence.withdrawalAcknowledged !== "function" ||
    typeof fence.requalifyNative !== "function"
  );
}
