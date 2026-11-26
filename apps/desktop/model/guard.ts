import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time bearer comparison; digesting first hides the length too. */
export function bearerMatches(authorization: string, token: string): boolean {
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const presented = createHash("sha256").update(authorization).digest();
  return timingSafeEqual(expected, presented);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}
