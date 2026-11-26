import { createHash } from "node:crypto";
import { connectorRuntimeUncertain } from "../../../src/pkg/product-settings/connector-uncertainty";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import { pendingConnectorReadiness } from "../../../src/apps/desktop/settings/rules";
import { withLastVerifiedAttachmentKept } from "./legacy";
import type {
  OriginalStopSettingsAck,
  OriginalStopSettingsPlan,
} from "./input";

// The pure decisions behind the one-shot stopped publication of the ORIGINAL
// durable C7 operation: whether the caller's selection still names the
// settings the service holds, the stopped candidate that selection authorizes,
// the plan Go must admit before any save, whether the bytes read back after
// the save are exactly that candidate, and the receipt that certifies it. Each
// decides from values alone. The service keeps every await and side effect in
// its own order (the reservation currentness callback, the Go intent
// admission, the conditional save, the loss latch and the settle), and a
// refusal here only ever means "not written": a lost intent reply or a
// post-rename readback that does not match is never decided here, and stays
// the service's UNKNOWN.

export type OriginalStopSelection = Readonly<{
  effectId: string;
  expectedRevision: number;
  expectedDigest: string;
  computerGeneration: number;
  connectorGeneration: number;
  consentDigest: string;
}>;

export type OriginalStopSelectionRefusal =
  "selection_invalid" | "selection_stale" | "digest_mismatch";

export type OriginalStopCandidate =
  | Readonly<{ kind: "candidate"; settings: ProductSettings }>
  | Readonly<{
      kind: "refused";
      cause: "nothing_to_stop" | "candidate_invalid" | "consent_changed";
    }>;

// The owner-consent digest of a settings document. The Computer module owns
// the projection and its hash; the service passes it in, so this module never
// reaches into that module's internals.
export type OwnerConsentDigest = (settings: ProductSettings) => string;

const SHA256_HEX = /^[a-f0-9]{64}$/u;

// The digest of the whole settings document, as Go binds it into the plan.
export function settingsDocumentDigest(settings: ProductSettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

// The checks that must pass before the reservation currentness callback is
// consulted: settings are loaded, delivery is not fenced, the connector
// runtime is not outcome-unknown, and both callbacks exist.
export function originalStopAdmissible(
  original: ProductSettings | null,
  deliveryFenced: boolean,
  admitIntent: unknown,
  current: unknown,
): original is ProductSettings {
  return !(
    original === null ||
    deliveryFenced ||
    connectorRuntimeUncertain(original) ||
    typeof admitIntent !== "function" ||
    typeof current !== "function"
  );
}

// Whether the selection still names these exact settings: a malformed or
// stale selection first, then the document and owner-consent digests.
export function originalStopSelectionRefusal(
  original: ProductSettings,
  selection: OriginalStopSelection,
  consentDigest: OwnerConsentDigest,
): OriginalStopSelectionRefusal | null {
  if (
    !Number.isSafeInteger(selection.expectedRevision) ||
    !SHA256_HEX.test(selection.expectedDigest) ||
    !SHA256_HEX.test(selection.consentDigest) ||
    JSON.stringify(original) === ""
  )
    return "selection_invalid";
  if (
    original.revision !== selection.expectedRevision ||
    original.computer.generation !== selection.computerGeneration ||
    original.connectors.secureMcp.generation !== selection.connectorGeneration
  )
    return "selection_stale";
  if (
    settingsDocumentDigest(original) !== selection.expectedDigest ||
    consentDigest(original) !== selection.consentDigest
  )
    return "digest_mismatch";
  return null;
}

// The stopped settings the selection authorizes: the runtime, challenge and
// attachment are dropped and the connect step returns to pending, but stopping
// may invalidate verification evidence and must never widen, narrow, or
// relabel the original owner-authorized limits.
export function originalStopCandidate(
  original: ProductSettings,
  selection: OriginalStopSelection,
  consentDigest: OwnerConsentDigest,
): OriginalStopCandidate {
  const before = structuredClone(original);
  const connector = before.connectors.secureMcp;
  if (
    connector.runtime === null &&
    connector.challenge === null &&
    connector.attachment === null
  )
    return { kind: "refused", cause: "nothing_to_stop" };
  const stopped = {
    ...connector,
    runtime: null,
    challenge: null,
    attachment: null,
  };
  let candidate: ProductSettings;
  try {
    // Keep a legacy live-only proof before the digest and intent are
    // computed, so the intent, digest and written document all agree.
    candidate = ProductSettingsSchema.parse(
      withLastVerifiedAttachmentKept(before, {
        ...before,
        revision: before.revision + 1,
        connectors: { ...before.connectors, secureMcp: stopped },
        setup: {
          ...before.setup,
          connect: {
            ...pendingConnectorReadiness(
              before.setup.connect,
              stopped,
              undefined,
            ),
            unavailable: null,
          },
        },
      }),
    );
  } catch {
    return { kind: "refused", cause: "candidate_invalid" };
  }
  if (consentDigest(candidate) !== selection.consentDigest)
    return { kind: "refused", cause: "consent_changed" };
  return { kind: "candidate", settings: candidate };
}

// What Go must admit as durable intent before any Settings save is dispatched.
export function originalStopPlan(
  original: ProductSettings,
  candidate: ProductSettings,
  selection: OriginalStopSelection,
): OriginalStopSettingsPlan {
  return {
    effectId: selection.effectId,
    expectedRevision: String(original.revision),
    expectedDigest: selection.expectedDigest,
    nextRevision: String(candidate.revision),
    nextDigest: settingsDocumentDigest(candidate),
    computerGeneration: String(selection.computerGeneration),
    connectorGeneration: String(selection.connectorGeneration),
    consentDigest: selection.consentDigest,
  };
}

// The bytes read back after the save are exactly the admitted candidate: its
// document digest, its owner-consent digest and its revision. Anything else is
// not an ACK; the service latches the loss and answers UNKNOWN.
export function originalStopReadbackMatches(
  readback: ProductSettings,
  candidate: ProductSettings,
  plan: OriginalStopSettingsPlan,
  selection: OriginalStopSelection,
  consentDigest: OwnerConsentDigest,
): boolean {
  return (
    settingsDocumentDigest(readback) === plan.nextDigest &&
    consentDigest(readback) === selection.consentDigest &&
    readback.revision === candidate.revision
  );
}

// Certifies only Settings CAS and readback of the admitted plan.
export function originalStopReceipt(
  plan: OriginalStopSettingsPlan,
): OriginalStopSettingsAck {
  return {
    effectId: plan.effectId,
    revision: plan.nextRevision,
    documentDigest: plan.nextDigest,
    computerGeneration: plan.computerGeneration,
    connectorGeneration: plan.connectorGeneration,
    consentDigest: plan.consentDigest,
  };
}
