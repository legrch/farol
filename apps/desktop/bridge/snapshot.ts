import { BridgeError } from "./client.ts";
import { validate } from "./wire.ts";

// These trusted DTOs contain only strings. Copy data properties without invoking
// accessors, then validate the exact wire shape; no authority is selected here.
export function trustedSnapshot<T>(name: string, value: T): T {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw Error("invalid_binding");
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw Error("invalid_binding");
    const copy: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string"
      )
        throw Error("invalid_binding");
      copy[key] = descriptor.value;
    }
    if (!validate(name, copy)) throw Error("invalid_binding");
    return Object.freeze(copy) as T;
  } catch {
    throw new BridgeError("refused", "invalid_computer_mcp_binding");
  }
}
