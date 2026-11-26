// Pure shape and path rules for workspace requests. Nothing here touches the
// filesystem; the checks only decide whether a value is well formed.

export function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

export function plainString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    })
  );
}

export function canonicalAbsolutePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 4_096 ||
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    !plainString(value, 4_096)
  ) {
    return false;
  }
  return value
    .split("/")
    .slice(1)
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        Buffer.byteLength(part, "utf8") <= 255,
    );
}

export function canonicalRelativePath(
  value: unknown,
  { root = false }: Readonly<{ root?: boolean }> = {},
): value is string {
  if (root && value === ".") return true;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    !plainString(value, 4_096)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        Buffer.byteLength(part, "utf8") <= 255,
    );
}

export function validWorkspaceId(value: unknown): value is string {
  return plainString(value, 120);
}

export function hasOwn(value: unknown, key: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

export function validGitMetadataGrant(value: unknown): boolean {
  if (!exactKeys(value, ["gitDirectory", "commonDirectory"])) return false;
  const grant = value as Readonly<Record<string, unknown>>;
  return (
    canonicalAbsolutePath(grant.gitDirectory) &&
    canonicalAbsolutePath(grant.commonDirectory)
  );
}

// The approved root is the folder the owner approved, bound to the device and
// inode it had then. It is the requested root or one of its ancestors, so a
// narrowed subtree is still checked against the folder that was approved.
export function validApprovedRoot(value: unknown, root: unknown): boolean {
  if (!exactKeys(value, ["path", "device", "inode"])) return false;
  const approved = value as Readonly<Record<string, unknown>>;
  return (
    canonicalAbsolutePath(approved.path) &&
    typeof root === "string" &&
    (root === approved.path || root.startsWith(`${approved.path}/`)) &&
    typeof approved.device === "string" &&
    /^[0-9]{1,20}$/u.test(approved.device) &&
    typeof approved.inode === "string" &&
    /^[0-9]{1,20}$/u.test(approved.inode)
  );
}

export function validRelativePaths(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((entry) => canonicalRelativePath(entry)) &&
    value.length === new Set(value).size
  );
}

export function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
