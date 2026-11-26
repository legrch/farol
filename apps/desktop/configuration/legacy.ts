import type { ProductSettings } from "../../../src/pkg/product-settings/contract";
import {
  invalidateStaleCodexTaskSource,
  invalidateUnboundComputerVerification,
} from "../../../src/apps/desktop/settings/rules";

// The pure decisions behind the launch-time handling of settings saved by older
// builds: separating the external-Send fence from a credential write, withdrawing
// a verification that names a folder without a bound identity or a Task source
// that no longer matches its host, and capturing a saved onboarding proof before
// a runtime restart clears the live attachment. Each decides from the loaded
// settings alone and says what the next value is; none reads or writes a store,
// the clock or Go authority. `initialize` keeps every read, await and store call
// in its own order, and runs the transforms inside `mutate`, which owns revision
// admission and persistence.

type SecureMcp = ProductSettings["connectors"]["secureMcp"];
export type SecureMcpAttachment = NonNullable<SecureMcp["attachment"]>;

// The instruction an older build wrote for a pending external Send; it is the
// only text that tells that Send apart from a credential or runtime effect.
const LEGACY_PENDING_APP_ACTION =
  "Check the pending ChatGPT connection result before sending another check.";

// Older builds used the one outcome-unknown flag for an external Send and a
// credential write. Only the exact pending-app record with an intact challenge
// can be separated; unknown credentials or runtime effects keep their fence.
export function legacyAppPendingSeparable(settings: ProductSettings): boolean {
  const connector = settings.connectors.secureMcp;
  const runtime = connector.runtime;
  const challenge = connector.challenge;
  return (
    settings.setup.connect.outcomeUnknown &&
    connector.appVerificationPending !== true &&
    settings.setup.connect.needsAction === LEGACY_PENDING_APP_ACTION &&
    runtime?.state === "ready" &&
    runtime.connectorGeneration === connector.generation &&
    runtime.computerGeneration === settings.computer.generation &&
    challenge?.runtimeGeneration === runtime.runtimeGeneration &&
    challenge.buildId === runtime.buildId &&
    challenge.computerGeneration === runtime.computerGeneration
  );
}

// Records the separated fence and leaves the instruction and the unknown flag
// that the older build wrote exactly as they were.
export function withLegacyAppPendingSeparated(
  settings: ProductSettings,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: {
      ...settings.connectors,
      secureMcp: {
        ...settings.connectors.secureMcp,
        appVerificationPending: true,
      },
    },
  };
}

// Settings saved before folder identities existed may name a verified
// workspace without one, and a Task source can outlive the host it was bound
// to. Either withdrawal is persisted like any other change.
export function legacyVerificationWithdrawalPending(
  settings: ProductSettings,
): boolean {
  return (
    invalidateUnboundComputerVerification(settings) !== settings ||
    invalidateStaleCodexTaskSource(settings) !== settings
  );
}

export function withLegacyVerificationWithdrawn(
  settings: ProductSettings,
): ProductSettings {
  return invalidateStaleCodexTaskSource(
    invalidateUnboundComputerVerification(settings),
  );
}

// When the withdrawal could not be saved it is held in memory, and a Task
// source it dropped must stay dropped for every later read. The floor is the
// host generation that withdrew it; one already held is never lowered.
export function taskSourceWithdrawalFloor(
  before: ProductSettings,
  withdrawn: ProductSettings,
  held: number | null,
): number | null {
  if (
    before.nativeHosts.codex?.taskSource &&
    !withdrawn.nativeHosts.codex?.taskSource
  )
    return Math.max(held ?? 0, withdrawn.nativeHosts.generation);
  return held;
}

// Older Dev profiles stored only the live attachment. A valid saved proof is
// captured before a later runtime restart clears that live field; the result is
// the attachment to keep, or null when the settings hold nothing to capture.
export function lastVerifiedAttachmentCapturable(
  settings: ProductSettings,
): SecureMcpAttachment | null {
  const connector = settings.connectors.secureMcp;
  const attachment = connector.attachment;
  const runtime = connector.runtime;
  const verified = settings.setup.connect.verified;
  if (
    connector.lastVerifiedAttachment === null &&
    attachment !== null &&
    runtime?.state === "ready" &&
    connector.tunnelId === attachment.tunnelId &&
    connector.generation === attachment.connectorGeneration &&
    runtime.runtimeGeneration === attachment.runtimeGeneration &&
    runtime.buildId === attachment.buildId &&
    runtime.computerGeneration === attachment.computerGeneration &&
    settings.computer.generation === attachment.computerGeneration &&
    verified?.configRevision === attachment.connectorGeneration &&
    verified.workspaceId === attachment.workspaceId &&
    verified.runtimeGeneration === attachment.runtimeGeneration &&
    verified.buildId === attachment.buildId &&
    (attachment.workspaceId === null
      ? settings.computer.workspaces.length === 0
      : settings.computer.workspaces.some(
          (workspace) => workspace.workspaceId === attachment.workspaceId,
        ))
  )
    return attachment;
  return null;
}

export function withLastVerifiedAttachment(
  settings: ProductSettings,
  attachment: SecureMcpAttachment,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: {
      ...settings.connectors,
      secureMcp: {
        ...settings.connectors.secureMcp,
        lastVerifiedAttachment: attachment,
      },
    },
  };
}
