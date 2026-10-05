/**
 * Credential stores in the owner's home directory. Unlike the root-relative
 * conventions every workspace denies (`.env`, `.git`, and other store names
 * directly under any root), these are absolute: they stay protected whichever
 * folder the owner selects. A root that is one of them, or lies inside one, is
 * refused outright, because no deny prefix relative to that root can name the
 * store that encloses it. A root that encloses a store carries the store as
 * one more deny prefix. Owner exclusions stay separate, and nested names such
 * as `service/.env.example` are not scanned: path policy is not a secret
 * detector.
 * `.npmrc` is HOME-only protection; repository copies follow owner/task scope.
 */
// Agent stores (.codex/.claude) are ordinary workspaces, not mandatory
// denials. Their contents, including credentials, follow the owner/task grant.
export const HOME_CREDENTIAL_STORES = Object.freeze([
  ".ssh",
  ".aws",
  ".gnupg",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".docker/config.json",
  ".kube/config",
  "Library/Keychains",
]);

export type CredentialStorePolicy =
  | Readonly<{ kind: "inside-store" }>
  | Readonly<{ kind: "outside"; deniedPaths: readonly string[] }>;

function components(absolute: string): string[] {
  return absolute.split("/").filter((part) => part.length > 0);
}

// macOS volumes compare names case- and normalisation-insensitively, and the
// helper folds its own deny check the same way, so `.SSH` is `.ssh`. Lower
// case alone is not case folding: U+017F LONG S has no lower-case change but
// names the same file as "s" on APFS, so letters are upper-cased first, which
// maps it, like "ß" and the Kelvin sign, onto what Python's casefold gives.
function folded(part: string): string {
  return part.normalize("NFC").toUpperCase().toLowerCase();
}

function hasPrefix(parts: readonly string[], prefix: readonly string[]) {
  return (
    prefix.length <= parts.length &&
    prefix.every((part, index) => folded(part) === folded(parts[index] ?? ""))
  );
}

export function credentialStorePolicy(
  root: string,
  homeDirectory: string,
): CredentialStorePolicy {
  const rootParts = components(root);
  const deniedPaths: string[] = [];
  for (const store of HOME_CREDENTIAL_STORES) {
    const storeParts = [...components(homeDirectory), ...store.split("/")];
    if (hasPrefix(rootParts, storeParts)) return { kind: "inside-store" };
    if (hasPrefix(storeParts, rootParts)) {
      deniedPaths.push(storeParts.slice(rootParts.length).join("/"));
    }
  }
  return { kind: "outside", deniedPaths };
}
