import { createHash } from "node:crypto";
import { TUNNEL_CLIENT } from "../apps/desktop/tunnel-client-contract.ts";

// Exact dependency evidence for the separately pinned v0.0.16 executable.
// A tunnel update requires re-verifying both the module closure and embedded UI.
const PINNED_ATTRIBUTION_SHA256 =
  "a3386e1b5524acad7b1e66449f280976a58c375e78f0b09e9744fc0afafa243e";
function evidenceDigest(value) {
  try {
    return createHash("sha256")
      .update(JSON.stringify(value) ?? "")
      .digest("hex");
  } catch {
    return null;
  }
}

// The evidence and exact notice bytes are part of the committed source. The
// check binds them to the independently pinned upstream executable and archive.
export function validateTunnelNotice(
  bytes,
  evidence,
  contract = TUNNEL_CLIENT,
) {
  if (
    !Buffer.isBuffer(bytes) ||
    !evidence ||
    evidence.schema !== "farol.tunnel-attribution-evidence/1" ||
    evidence.tunnelVersion !== contract?.version ||
    evidence.binarySha256 !== contract?.sha256 ||
    evidence.archiveSha256 !== contract?.archiveSHA256 ||
    evidenceDigest(evidence) !== PINNED_ATTRIBUTION_SHA256 ||
    createHash("sha256").update(bytes).digest("hex") !== evidence.noticeSha256
  ) {
    throw new Error("PACKAGE_TUNNEL_NOTICE_MISMATCH");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
