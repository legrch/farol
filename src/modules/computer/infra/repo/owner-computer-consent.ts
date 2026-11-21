import { createHash } from "node:crypto";
import type { ProductSettings } from "../../../../pkg/product-settings/contract";
import { ownerComputerConsentProjection } from "../../contract/consent";
export { ownerComputerConsentProjection };

export function ownerComputerConsentDigest(settings: ProductSettings): string {
  return createHash("sha256")
    .update(JSON.stringify(ownerComputerConsentProjection(settings)))
    .digest("hex");
}
