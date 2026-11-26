import { BridgeError } from "../bridge/client.ts";
import {
  validate,
  type CoreRetirementAcknowledged,
  type CoreRetirementPrepared,
} from "../bridge/wire.ts";

type Reply = Readonly<{ status: string; data?: unknown }>;

const DIGEST = /^[a-f0-9]{64}$/u;

// Pure shape checks of the two retirement replies. They only classify bytes
// already received; the host keeps the requests, pump joins and ordering.
export function acceptRetirementPrepared(
  handoffId: string,
  prepared: Reply,
): CoreRetirementPrepared {
  if (
    prepared.status !== "ok" ||
    !validate("CoreRetirementPrepared", prepared.data)
  )
    throw new BridgeError("unknown", "core_retirement_prepare_unconfirmed");
  const publication = prepared.data as unknown as CoreRetirementPrepared;
  if (
    publication.handoffId !== handoffId ||
    !DIGEST.test(publication.receiptDigest)
  )
    throw new BridgeError("unknown", "core_retirement_publication_crossed");
  return publication;
}

export function acceptRetirementAck(
  publication: CoreRetirementPrepared,
  acknowledged: Reply,
): CoreRetirementAcknowledged {
  if (
    acknowledged.status !== "ok" ||
    !validate("CoreRetirementAcknowledged", acknowledged.data)
  )
    throw new BridgeError("unknown", "core_retirement_ack_unconfirmed");
  const ack = acknowledged.data as unknown as CoreRetirementAcknowledged;
  if (
    ack.handoffId !== publication.handoffId ||
    ack.receiptDigest !== publication.receiptDigest ||
    !DIGEST.test(ack.ackDigest)
  )
    throw new BridgeError("unknown", "core_retirement_ack_crossed");
  return ack;
}
