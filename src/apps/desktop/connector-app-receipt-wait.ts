import type { ProductSettings } from "../../pkg/product-settings/contract";
import { connectorWorkspaceSelection } from "../../pkg/product-settings/connector-workspace-selection";

// A successful check consumes its one-time challenge. Subsequent read-only
// checks use the already validated attachment, scoped to the live runtime and
// Computer authority, rather than asking for a challenge that no longer exists.
export function currentConnectorAttachment(
  settings: ProductSettings,
  expectedBuildId: string,
  expectedWorkspaceId?: string | null,
): NonNullable<
  ProductSettings["connectors"]["secureMcp"]["attachment"]
> | null {
  const connector = settings.connectors.secureMcp;
  const runtime = connector.runtime;
  const attachment = connector.attachment;
  const verified = settings.setup.connect.verified;
  return attachment !== null &&
    connector.challenge === null &&
    runtime?.state === "ready" &&
    connector.tunnelId === attachment.tunnelId &&
    connector.generation === attachment.connectorGeneration &&
    runtime.runtimeGeneration === attachment.runtimeGeneration &&
    runtime.computerGeneration === attachment.computerGeneration &&
    runtime.buildId === attachment.buildId &&
    runtime.buildId === expectedBuildId &&
    settings.computer.generation === attachment.computerGeneration &&
    connectorWorkspaceSelection(settings) === attachment.workspaceId &&
    verified?.workspaceId === attachment.workspaceId &&
    verified.runtimeGeneration === attachment.runtimeGeneration &&
    !settings.setup.connect.outcomeUnknown &&
    (expectedWorkspaceId === undefined ||
      expectedWorkspaceId === attachment.workspaceId)
    ? attachment
    : null;
}

/** Waits for a matching receipt through read-only probes after one send. */
export async function readPendingConnectorReceipt<T>(
  readReceipt: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await readReceipt();
  } catch (error) {
    // The recorder creates the private file before writing its JSON. An
    // incomplete observation can settle on the next read; a persistently
    // invalid receipt still times out without another ChatGPT message.
    if (
      error instanceof Error &&
      error.message === "CONNECTOR_VERIFICATION_RECEIPT_INVALID"
    ) {
      return null;
    }
    throw error;
  }
}

export async function waitForConnectorAppReceipt<T>(
  readReceipt: () => Promise<T | null>,
  matchesAttempt: (receipt: T) => boolean,
  options: Readonly<{
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
  }> = {},
): Promise<T | null> {
  const now = options.now ?? Date.now;
  const pause =
    options.pause ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 45_000);
  const interval = options.intervalMs ?? 1_000;
  while (now() < deadline) {
    const remaining = deadline - now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const receipt = await Promise.race([
      readReceipt(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), remaining);
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    if (receipt !== null && matchesAttempt(receipt)) return receipt;
    const remainingAfterRead = deadline - now();
    if (remainingAfterRead <= 0) return null;
    await pause(Math.min(interval, remainingAfterRead));
  }
  return null;
}
