import {
  PendingWorkspaceEditDeliverySchema,
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract.ts";
import {
  validate,
  type SettingsStoreChange,
  type SettingsStorePending,
  type SettingsStoreSnapshot,
} from "./bridge/wire.ts";

// Trusted composition supplies this scope. The renderer cannot select it.
export type SettingsStoreScope = Readonly<{
  profileId: string;
  ownerId: string;
}>;
export class SettingsStoreUnsupported extends Error {}
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const inspectionGuidance =
  "Inspect the selected file, then verify workspace access again.";
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

// Content-free projection of the existing document; no second settings store.
// Historical TS delivery remains a distinct reader and is never an empty Go slot.
export function settingsStoreSnapshot(
  input: ProductSettings,
  scope: SettingsStoreScope,
): SettingsStoreSnapshot {
  const settings = ProductSettingsSchema.parse(input);
  if (
    !uuidV4.test(scope.profileId) ||
    !positive(settings.revision) ||
    !positive(settings.computer.generation)
  )
    throw new SettingsStoreUnsupported();
  const saved = settings.computer.pendingEdit;
  let pending: SettingsStorePending | undefined;
  if (saved !== null) {
    if (
      !("backend" in saved) ||
      saved.backend !== "go-owner-v2" ||
      saved.profileId !== scope.profileId ||
      !positive(saved.computerGeneration)
    )
      throw new SettingsStoreUnsupported();
    pending = {
      backend: saved.backend,
      operationId: saved.operationId,
      profileId: saved.profileId,
      workspaceId: saved.workspaceId,
      relativePath: saved.relativePath,
      computerGeneration: String(saved.computerGeneration),
      beforeSHA256: saved.beforeSha256,
      submittedAt: saved.submittedAt,
    };
  }
  const readiness = settings.setup.computer;
  const snapshot: SettingsStoreSnapshot = {
    revision: String(settings.revision),
    current: {
      ...scope,
      computerId: settings.computer.computerId,
      generation: String(settings.computer.generation),
    },
    ...(pending ? { pending } : {}),
    verificationInvalidated:
      readiness.configured &&
      readiness.verified === null &&
      readiness.reachable === "unknown" &&
      readiness.outcomeUnknown &&
      readiness.unavailable === null &&
      readiness.needsAction === inspectionGuidance,
  };
  if (!validate("SettingsStoreSnapshot", snapshot))
    throw new SettingsStoreUnsupported();
  return snapshot;
}

function pendingKey(p: SettingsStorePending | undefined): unknown {
  return p === undefined
    ? null
    : [
        p.backend,
        p.operationId,
        p.profileId,
        p.workspaceId,
        p.relativePath,
        p.computerGeneration,
        p.beforeSHA256,
        p.submittedAt,
      ];
}
export function sameSettingsStoreSnapshot(
  a: SettingsStoreSnapshot,
  b: SettingsStoreSnapshot,
): boolean {
  return (
    a.revision === b.revision &&
    a.current.profileId === b.current.profileId &&
    a.current.ownerId === b.current.ownerId &&
    a.current.computerId === b.current.computerId &&
    a.current.generation === b.current.generation &&
    a.verificationInvalidated === b.verificationInvalidated &&
    JSON.stringify(pendingKey(a.pending)) ===
      JSON.stringify(pendingKey(b.pending))
  );
}

// Apply only Go-selected fields. This mapping grants no execution, retry or ACK
// authority; the Go policy chooses the transition and owns its one-shot receipt.
export function settingsStoreReplacement(
  before: ProductSettings,
  scope: SettingsStoreScope,
  input: unknown,
): ProductSettings | undefined {
  if (!validate("SettingsStoreChange", input)) return undefined;
  const change = input as SettingsStoreChange;
  const actual = settingsStoreSnapshot(before, scope);
  if (
    !sameSettingsStoreSnapshot(actual, change.expected) ||
    before.revision >= Number.MAX_SAFE_INTEGER
  )
    return undefined;
  const next = change.next;
  if (
    next &&
    (next.profileId !== scope.profileId ||
      !positive(Number(next.computerGeneration)))
  )
    return undefined;
  const pending = next
    ? PendingWorkspaceEditDeliverySchema.safeParse({
        backend: next.backend,
        operationId: next.operationId,
        profileId: next.profileId,
        workspaceId: next.workspaceId,
        relativePath: next.relativePath,
        computerGeneration: Number(next.computerGeneration),
        beforeSha256: next.beforeSHA256,
        submittedAt: next.submittedAt,
      })
    : undefined;
  if (pending && !pending.success) return undefined;
  const candidate = structuredClone(before);
  candidate.revision++;
  candidate.computer.pendingEdit = pending?.success ? pending.data : null;
  if (change.invalidateVerification) {
    candidate.setup.computer = {
      ...candidate.setup.computer,
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: inspectionGuidance,
      unavailable: null,
      outcomeUnknown: true,
    };
  }
  return ProductSettingsSchema.parse(candidate);
}
