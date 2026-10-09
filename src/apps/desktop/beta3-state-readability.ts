import { ProductSettingsSchema } from "../../pkg/product-settings/contract";

const originalVersion = "0.2.0-owner.beta.3";
const originalSourceCommit = "24cc7c32f12f2633156efef40c91ea0817109a4c";

// Stored Settings are JSON data, not executable objects. Refuse accessors,
// inherited state, symbols, sparse arrays, cycles and non-JSON values before
// invoking the owner parser. Missing fields remain missing for its defaults.
function isStoredJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    return false;
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) return false;

  ancestors.add(value);
  try {
    let index = 0;
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || (array && key !== String(index++)))
        return false;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (
        !property ||
        !property.enumerable ||
        !("value" in property) ||
        !isStoredJson(property.value, ancestors)
      )
        return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

/** Readability by the ORIGINAL beta3 reader only, never arbitrary history.
 * Audited against 24cc7c32f12f2633156efef40c91ea0817109a4c at base 27c091e5:
 * the complete stored-schema dependency closure has two incompatible additions:
 * general.openAtLaunch="home" and nativeHosts.taskRoute.observeTurnId. The
 * commands/results changes are not stored Settings. tasks was already unknown;
 * all stored defaults and remaining validators have the same old semantics.
 *
 * ON TOUCH: any stored-schema, reachable validator/default or parser dependency
 * change requires a fresh complete comparison against that exact reader and
 * updated refusal coverage BEFORE updating the audit fingerprint in the test.
 * The current owner parser alone must never silently broaden this claim.
 *
 * Validation only: parsed defaults/trimmed values are discarded, never saved or
 * used to normalize the input. This is one original-closed-state forward
 * installer prerequisite; it grants no lease, launch, migration, recovery,
 * post-start rollback or retry authority. The caller owns the source identity,
 * original closed lifetime, resources, lease and existing Settings writer.
 */
export function originalPredecessorSettingsReadable(
  source: { version: string; sourceCommit: string },
  value: unknown,
): boolean {
  try {
    if (
      !isStoredJson(source) ||
      source === null ||
      Array.isArray(source) ||
      Object.keys(source).length !== 2 ||
      !Object.hasOwn(source, "version") ||
      !Object.hasOwn(source, "sourceCommit") ||
      source.version !== originalVersion ||
      source.sourceCommit !== originalSourceCommit
    )
      return false;
    if (!isStoredJson(value)) return false;
    const parsed = ProductSettingsSchema.safeParse(value);
    if (!parsed.success || parsed.data.general.openAtLaunch === "home")
      return false;
    const route = parsed.data.nativeHosts.taskRoute;
    // Presence is incompatible, not just a nonempty value. Never remove it.
    return route === null || !Object.hasOwn(route, "observeTurnId");
  } catch {
    return false;
  }
}
