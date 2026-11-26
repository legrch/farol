import {
  validate,
  type Handshake,
  type Identity,
  type Outcome,
} from "./wire.ts";

export type HandshakeQualification =
  | Readonly<{ code: "invalid_backend_identity" | "wrong_backend_identity" }>
  | Readonly<{ identity: Identity }>;

// Judges the backend's reply to the original handshake against what this host
// asked for. It adopts nothing and sends nothing: the caller freezes and keeps
// the identity and context only when no refusal code is returned.
export function qualifyHandshake(
  result: Outcome,
  expected: Handshake,
): HandshakeQualification {
  if (result.status !== "ok" || !validate("Identity", result.data))
    return { code: "invalid_backend_identity" };
  const identity = result.data as unknown as Identity;
  if (
    identity.protocolMajor !== expected.protocolMajor ||
    identity.protocolMinor < expected.protocolMinor ||
    identity.buildId !== expected.buildId ||
    identity.profileId !== expected.profileId ||
    result.context.backendGeneration !== identity.backendGeneration ||
    result.context.profileId !== identity.profileId
  )
    return { code: "wrong_backend_identity" };
  return { identity };
}
