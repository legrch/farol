import {
  readConnectorSetupIdentity,
  readConnectorSetupReceipt,
  type ConnectorSetupCode,
  type ConnectorSetupIdentity,
} from "../pkg/product-settings/connector-setup-receipt";

export type ConnectorSetupPresentation = Readonly<{
  status: "local-ready" | "needs-attention" | "unconfirmed";
  title: string;
  description: string;
  next:
    | "review-settings"
    | "inspect-connection"
    | "observe-original"
    | "verify-attachment";
  credentialResult: "saved" | "not-confirmed";
  code: ConnectorSetupCode | null;
}>;

/**
 * Presentation only, not command eligibility, a retry decision or a green
 * external readiness check. Retain the underlying receipt separately from a
 * current Settings snapshot: a refresh/remount must not replay a partial save.
 */
export function connectorSetupPresentation(
  value: unknown,
  identity: ConnectorSetupIdentity,
): ConnectorSetupPresentation {
  const selected = readConnectorSetupIdentity(identity);
  const receipt = readConnectorSetupReceipt(value);
  if (
    !selected ||
    !receipt ||
    receipt.operationId !== selected.operationId ||
    receipt.buildId !== selected.buildId
  )
    return Object.freeze({
      status: "unconfirmed",
      title: "Setup result could not be confirmed",
      description:
        "Inspect the original result before changing credentials or starting another connection.",
      next: "observe-original",
      credentialResult: "not-confirmed",
      code: null,
    });
  if (receipt.state === "completed")
    return Object.freeze({
      status: "local-ready",
      title: "Connection started",
      description:
        "Credentials are saved. Verify Farol in ChatGPT to finish connecting this Mac.",
      next: "verify-attachment",
      credentialResult: "saved",
      code: null,
    });
  const saved = receipt.credentials === "saved";
  if (receipt.state === "unknown")
    return Object.freeze({
      status: "unconfirmed",
      title: saved
        ? "Credentials saved; connection result unconfirmed"
        : "Setup result unconfirmed",
      description: saved
        ? "Do not enter the key again. Inspect the original connection result before another action."
        : "Do not submit the key again. Inspect the original setup result before making another change.",
      next: "observe-original",
      credentialResult: saved ? "saved" : "not-confirmed",
      code: receipt.code,
    });
  if (saved)
    return Object.freeze({
      status: "needs-attention",
      title: "Credentials saved",
      // A refused connection stage may have performed configure/doctor/start
      // work. Do not describe a missing success as proof no process was started.
      description:
        receipt.connection === "not-started"
          ? "The connection step was not started. Review the connection status; the saved key does not need to be entered again."
          : "The connection step did not complete. Review its status before another action; keep the saved key.",
      next: "inspect-connection",
      credentialResult: "saved",
      code: receipt.code,
    });
  return Object.freeze({
    status: "needs-attention",
    title: "Setup needs attention",
    description:
      "The setup request was refused. Review the saved settings and the reported reason before continuing.",
    next: "review-settings",
    credentialResult: "not-confirmed",
    code: receipt.code,
  });
}
