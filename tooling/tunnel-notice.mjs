import { createHash } from "node:crypto";
import { TUNNEL_CLIENT } from "../apps/desktop/tunnel-client-contract.ts";

// The evidence and exact notice bytes are part of the committed source. The
// check binds them to the independently pinned upstream executable and archive.
export function validateTunnelNotice(bytes, evidence) {
  if (
    !Buffer.isBuffer(bytes) ||
    !evidence ||
    evidence.schema !== "farol.tunnel-attribution-evidence/1" ||
    evidence.tunnelVersion !== TUNNEL_CLIENT.version ||
    evidence.binarySha256 !== TUNNEL_CLIENT.sha256 ||
    evidence.archiveSha256 !== TUNNEL_CLIENT.archiveSHA256 ||
    createHash("sha256").update(bytes).digest("hex") !== evidence.noticeSha256
  ) {
    throw new Error("PACKAGE_TUNNEL_NOTICE_MISMATCH");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
