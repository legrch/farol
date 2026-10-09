import { isDeepStrictEqual } from "node:util";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../pkg/product-settings/contract";
import type {
  ConditionalSettingsWrite,
  ProductSettingsStore,
} from "./product-configuration";

// Verified in the beta3 reader at 24cc7c32f12f2633156efef40c91ea0817109a4c.
export type Beta3StartupChoice =
  "browser" | "computer" | "activity" | "settings";
type Store = Pick<
  ProductSettingsStore,
  "saveConditional" | "fenceConditionalWrites"
>;
type PublicationGuard = Required<
  NonNullable<Parameters<Store["saveConditional"]>[2]>
>;

// These are trusted, already-bound caller dependencies, never admission proof
// supplied by this adapter. The caller owns the single Settings writer and keeps
// the original closed lifetime, app pair, exact update operation and held lease
// alive throughout publication. currentSettings checks the complete input.
export type ClosedStartupCompatibilityGuards = Readonly<{
  closure: PublicationGuard;
  appPair: PublicationGuard;
  currentSettings: PublicationGuard;
  originalOperation: PublicationGuard;
  promotionLease: PublicationGuard;
}>;

export type ClosedStartupCompatibilityResult =
  | Readonly<{
      status: "committed";
      originalStoreResult: Extract<
        ConditionalSettingsWrite,
        { status: "committed" }
      >;
    }>
  | Readonly<{
      status: "not_written";
      originalStoreResult: Extract<
        ConditionalSettingsWrite,
        { status: "not_written" }
      > | null;
    }>
  | Readonly<{
      status: "unknown";
      originalStoreResult: ConditionalSettingsWrite | null;
    }>;

export type ClosedStartupCompatibility =
  | Readonly<{
      status: "refused";
      reason:
        | "invalid_current_settings"
        | "invalid_retained_choice"
        | "revision_exhausted";
    }>
  | Readonly<{ status: "not_applicable" }>
  | Readonly<{
      status: "ready";
      plan: Readonly<{
        expectedRevision: number;
        nextRevision: number;
        openAtLaunch: Beta3StartupChoice;
      }>;
      // Every call observes the SAME original attempt, including not_written.
      // Constructing another adapter is not permission to replace that operation.
      apply(): Promise<ClosedStartupCompatibilityResult>;
    }>;

/** Unwired, private closed-state adapter for beta3's Home incompatibility only.
 * The retained choice must come from independent caller evidence, never from a
 * default or a backup used as replacement Settings. This grants no restore,
 * consent, retry, helper, launch or promotion authority.
 */
export function prepareClosedStartupCompatibility(
  input: Readonly<{
    currentSettings: ProductSettings;
    retainedStartupChoice: Beta3StartupChoice;
    store: Store;
    guards: ClosedStartupCompatibilityGuards;
  }>,
): ClosedStartupCompatibility {
  let expected: ProductSettings;
  try {
    const copied = structuredClone(input.currentSettings);
    const parsed = ProductSettingsSchema.safeParse(copied);
    // Reject normalization/default insertion rather than silently changing any
    // other field. Full current Settings from the retained writer are required.
    if (!parsed.success || !isDeepStrictEqual(copied, parsed.data))
      return { status: "refused", reason: "invalid_current_settings" };
    expected = copied;
  } catch {
    return { status: "refused", reason: "invalid_current_settings" };
  }
  const choice = input.retainedStartupChoice;
  if (
    choice !== "browser" &&
    choice !== "computer" &&
    choice !== "activity" &&
    choice !== "settings"
  )
    return { status: "refused", reason: "invalid_retained_choice" };
  if (expected.general.openAtLaunch !== "home")
    return { status: "not_applicable" };
  if (!Number.isSafeInteger(expected.revision + 1))
    return { status: "refused", reason: "revision_exhausted" };
  const next: ProductSettings = {
    ...structuredClone(expected),
    revision: expected.revision + 1,
    general: { ...expected.general, openAtLaunch: choice },
  };
  const store = input.store;
  const guards = [
    input.guards.closure,
    input.guards.appPair,
    input.guards.currentSettings,
    input.guards.originalOperation,
    input.guards.promotionLease,
  ].map((guard) => ({
    beforeWrite: guard.beforeWrite.bind(guard),
    assertBeforePublication: guard.assertBeforePublication.bind(guard),
  }));
  const beforeWrite = async () => {
    for (const guard of guards) await guard.beforeWrite();
  };
  const assertBeforePublication = () => {
    for (const guard of guards) guard.assertBeforePublication();
  };
  const unknown = (
    originalStoreResult: ConditionalSettingsWrite | null,
  ): ClosedStartupCompatibilityResult => {
    // Lost outer acknowledgement also fences the original writer; a visible
    // document or a later read cannot upgrade this operation's failed ACK.
    try {
      store.fenceConditionalWrites();
    } catch {
      // The original attempt remains unknown even if the trusted fence fails.
    }
    return { status: "unknown", originalStoreResult };
  };
  const execute = async (): Promise<ClosedStartupCompatibilityResult> => {
    try {
      await beforeWrite();
      assertBeforePublication();
    } catch {
      return { status: "not_written", originalStoreResult: null };
    }
    try {
      const originalStoreResult = await store.saveConditional(expected, next, {
        beforeWrite,
        assertBeforePublication,
      });
      switch (originalStoreResult.status) {
        case "not_written":
          return { status: "not_written", originalStoreResult };
        case "unknown":
          return unknown(originalStoreResult);
        case "committed":
          return isDeepStrictEqual(originalStoreResult.settings, next)
            ? { status: "committed", originalStoreResult }
            : unknown(originalStoreResult);
        default:
          return unknown(originalStoreResult);
      }
    } catch {
      return unknown(null);
    }
  };
  let attempt: Promise<ClosedStartupCompatibilityResult> | undefined;
  return {
    status: "ready",
    plan: Object.freeze({
      expectedRevision: expected.revision,
      nextRevision: next.revision,
      openAtLaunch: choice,
    }),
    apply() {
      // Set the promise before caller guards execute, including reentrant calls.
      attempt ??= Promise.resolve().then(execute);
      return attempt;
    },
  };
}
