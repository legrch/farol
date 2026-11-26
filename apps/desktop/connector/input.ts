import { createHash } from "node:crypto";
import { absolutePath, runtimeError } from "./command";

// What the runtime accepts before it takes any effect: the executable path,
// the tunnel id, the credential reference and the start identity. Each check
// refuses with one classified code and reads nothing but its argument.

export type ConnectorStartInput = Readonly<{
  beforeEffect?: () => void;
  executablePath: string;
  executableSha256: string;
  connectorGeneration: number;
  computerGeneration: number;
  buildId: string;
  launchContractSha256: string;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const TUNNEL_ID = /^[0-9A-Za-z._:-]{1,160}$/u;

export function validateExecutable(executablePath: string): void {
  if (!absolutePath(executablePath)) {
    runtimeError("CONNECTOR_EXECUTABLE_INVALID");
  }
}

export function validateTunnelId(tunnelId: string): void {
  if (!TUNNEL_ID.test(tunnelId)) {
    runtimeError("CONNECTOR_TUNNEL_ID_INVALID");
  }
}

// Only an absolute `file:` reference is a credential the connector may read.
export function validateCredentialReference(reference: string): void {
  const credentialPath = reference.startsWith("file:")
    ? reference.slice("file:".length)
    : "";
  if (!absolutePath(credentialPath)) {
    runtimeError("CONNECTOR_CREDENTIAL_REFERENCE_INVALID");
  }
}

export function validateStartInput(input: ConnectorStartInput): void {
  validateExecutable(input.executablePath);
  if (
    !SHA256.test(input.executableSha256) ||
    !Number.isInteger(input.connectorGeneration) ||
    input.connectorGeneration < 1 ||
    !Number.isInteger(input.computerGeneration) ||
    input.computerGeneration < 1 ||
    !SHA256.test(input.buildId) ||
    !SHA256.test(input.launchContractSha256)
  ) {
    runtimeError("CONNECTOR_START_INPUT_INVALID");
  }
}

// One digest over the caller's nonce and the exact identity being started.
export function deriveGeneration(
  nonce: string,
  input: ConnectorStartInput,
): string {
  return createHash("sha256")
    .update(
      [
        nonce,
        input.executableSha256,
        String(input.connectorGeneration),
        String(input.computerGeneration),
        input.buildId,
        input.launchContractSha256,
      ].join("\0"),
    )
    .digest("hex");
}
