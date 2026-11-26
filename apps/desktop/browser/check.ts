import { BridgeError } from "../bridge/client.ts";
import type {
  PhysicalBinding,
  PhysicalPartition,
  PhysicalView,
} from "../chatgpt-physical-api.ts";

const id = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const codePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

export function fail(
  code: string,
  state: "refused" | "unknown" = "refused",
): never {
  throw new BridgeError(state, code);
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && id.test(value);
}
export function validControlLiteral(value: unknown): value is string {
  // Match Go ControlFact.Valid without trimming or normalizing the literal.
  // Go TrimSpace includes NEL but excludes BOM; JavaScript trim differs.
  // In Unicode mode the surrogate range matches only unpaired surrogates.
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(
      value,
    ) &&
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)
  );
}
export function validCode(value: unknown): value is string {
  return typeof value === "string" && codePattern.test(value);
}
export function validView(
  view: PhysicalView,
  partition: PhysicalPartition,
): boolean {
  return (
    !!view &&
    validId(view.viewId) &&
    view.partition === partition &&
    Number.isSafeInteger(view.viewGeneration) &&
    view.viewGeneration > 0 &&
    Number.isSafeInteger(view.documentGeneration) &&
    view.documentGeneration > 0
  );
}
export function fixtureOrigin(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  try {
    const url = new URL(value);
    if (
      typeof value === "string" &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      Number(url.port) > 0 &&
      url.origin === value
    )
      return value;
  } catch {
    /* Invalid trusted configuration stays unavailable. */
  }
  return fail("chat_browser_fixture_origin_invalid");
}
export function validBinding(
  b: PhysicalBinding,
  partition: PhysicalPartition,
  e2eOrigin: string | null,
): boolean {
  if (!validView(b, partition)) return false;
  try {
    const url = new URL(b.url);
    if (
      url.origin !== (e2eOrigin ?? "https://chatgpt.com") ||
      url.username ||
      url.password ||
      url.hash
    )
      return false;
    return b.phase === "home"
      ? b.conversationId === null &&
          url.pathname === (e2eOrigin ? "/chatgpt" : "/")
      : b.phase === "conversation" &&
          validId(b.conversationId) &&
          url.pathname ===
            `${e2eOrigin ? "/chatgpt" : ""}/c/${b.conversationId}`;
  } catch {
    return false;
  }
}
export function sameView(a: PhysicalView, b: PhysicalView): boolean {
  return (
    a.viewId === b.viewId &&
    a.viewGeneration === b.viewGeneration &&
    a.documentGeneration === b.documentGeneration &&
    a.partition === b.partition
  );
}
export function sameOwnedView(a: PhysicalView, b: PhysicalView): boolean {
  return (
    a.viewId === b.viewId &&
    a.viewGeneration === b.viewGeneration &&
    a.partition === b.partition
  );
}
