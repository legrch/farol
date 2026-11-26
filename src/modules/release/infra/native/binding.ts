import { sha } from "./request";
import type {
  AcceptedInstalledBuild,
  InstalledAppLocation,
  InstalledUpdateRequest,
} from "./request";

export const INSTALLED_SLOT_BINDING_FILE = "slot-binding.json";
export type InstalledBoundOperation = Pick<
  InstalledUpdateRequest,
  "operationId" | "source" | "target"
>;

/** Identical ASCII canonical bytes in desktop and the attested native helper. */
export function installedSlotBindingBytes(
  operation: InstalledBoundOperation,
  installLocation: InstalledAppLocation,
): Buffer {
  const build = (value: AcceptedInstalledBuild) => {
    if (
      !value ||
      !sha.test(value.digest) ||
      !sha.test(value.buildId) ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version) ||
      value.version.length > 128
    )
      throw new Error("UPDATE_SLOT_BINDING_INVALID");
    return {
      buildId: value.buildId,
      digest: value.digest,
      version: value.version,
    };
  };
  if (
    !["shared", "legacy"].includes(installLocation) ||
    !/^[0-9a-f]{32}$/u.test(operation.operationId)
  )
    throw new Error("UPDATE_SLOT_BINDING_INVALID");
  return Buffer.from(
    JSON.stringify({
      installLocation,
      operationId: operation.operationId,
      schema: "farol.installed-operation-slot/1",
      source: build(operation.source),
      target: build(operation.target),
    }) + "\n",
    "ascii",
  );
}
