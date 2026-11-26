import { isDeepStrictEqual } from "node:util";
import { QuitReceiptSchema } from "../../../src/apps/desktop/quit-receipt";
import { RunMarkerSchema } from "../../../src/apps/desktop/run-marker";

export function installedPreservedQuitScope(run: unknown, quit: unknown): void {
  const marker = RunMarkerSchema.safeParse(run);
  const receipt = QuitReceiptSchema.safeParse(quit);
  if (
    !marker.success ||
    !receipt.success ||
    receipt.data.drained ||
    Date.parse(receipt.data.at) <= Date.parse(marker.data.startedAt) ||
    !receipt.data.unconfirmed.includes("go-core") ||
    receipt.data.unconfirmed.some(
      (v) => v !== "go-core" && v !== "connector",
    ) ||
    new Set(receipt.data.unconfirmed).size !== receipt.data.unconfirmed.length
  )
    throw Error("INSTALLED_PRESERVED_RECOVERY_QUIT_CHANGED");
}

export function installedEmptyQuitScope(run: unknown, quit: unknown): void {
  const marker = RunMarkerSchema.safeParse(run);
  const receipt = QuitReceiptSchema.safeParse(quit);
  if (
    !marker.success ||
    !receipt.success ||
    receipt.data.drained ||
    Date.parse(receipt.data.at) <= Date.parse(marker.data.startedAt) ||
    receipt.data.unconfirmed.length !== 2 ||
    new Set(receipt.data.unconfirmed).size !== 2 ||
    !receipt.data.unconfirmed.includes("connector") ||
    !receipt.data.unconfirmed.includes("go-core")
  )
    throw Error("INSTALLED_EMPTY_RECOVERY_QUIT_CHANGED");
}

// A previous clean Quit does not confirm the run that followed it. This
// selection only classifies which original bytes to preserve; absence of the
// actual processes and empty Chat/settled Computer proof are still mandatory.
export function unacknowledgedDevQuitScope(
  run: unknown,
  quit: unknown,
): "current-unconfirmed" | "previous-confirmed" {
  const marker = RunMarkerSchema.safeParse(run);
  const receipt = QuitReceiptSchema.safeParse(quit);
  if (!marker.success || !receipt.success)
    throw Error("INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED");
  if (
    !receipt.data.drained &&
    isDeepStrictEqual(receipt.data.unconfirmed, ["go-core", "connector"])
  )
    return "current-unconfirmed";
  if (
    receipt.data.drained &&
    receipt.data.unconfirmed.length === 0 &&
    Date.parse(receipt.data.at) < Date.parse(marker.data.startedAt)
  )
    return "previous-confirmed";
  throw Error("INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED");
}
