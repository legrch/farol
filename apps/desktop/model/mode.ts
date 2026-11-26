import type { FarolModelDelivery } from "./build";

export type FarolModelConfigInsecurePermissions = Readonly<{
  status: "insecure_permissions";
  mode: number;
}>;

export function insecurePermissionsRefusal(
  delivery: FarolModelDelivery,
  mode: number | undefined,
): FarolModelConfigInsecurePermissions | undefined {
  // Only the literal-token delivery writes a secret into the file. A newly
  // created file is written 0600 by this module (see `defaultModeFor`), so
  // only an EXISTING file's current mode can trigger this refusal.
  if (delivery.mode !== "bearer-token" || mode === undefined) return undefined;
  if ((mode & 0o077) !== 0) return { status: "insecure_permissions", mode };
  return undefined;
}

export function defaultModeFor(delivery: FarolModelDelivery): number {
  return delivery.mode === "bearer-token" ? 0o600 : 0o644;
}
