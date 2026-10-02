import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

// Storage identifiers are explicit compatibility values, not display-name
// transformations. A cosmetic rename must never select an empty profile.
export const DEV_DATA_DIRECTORY_NAME = "Farol Dev";
export const LEGACY_DEV_DATA_DIRECTORY_NAME = "Farol DEV";
export type DevDataDirectoryName =
  typeof DEV_DATA_DIRECTORY_NAME | typeof LEGACY_DEV_DATA_DIRECTORY_NAME;

export interface ProfileDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
  readonly directory: boolean;
  readonly symbolicLink: boolean;
}

type InspectDirectory = (
  absolutePath: string,
) => ProfileDirectoryIdentity | null;

function inspectDirectory(
  absolutePath: string,
): ProfileDirectoryIdentity | null {
  try {
    const info = lstatSync(absolutePath, { bigint: true });
    return {
      device: info.dev.toString(),
      inode: info.ino.toString(),
      directory: info.isDirectory(),
      symbolicLink: info.isSymbolicLink(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("DEV_PROFILE_DIRECTORY_UNREADABLE");
  }
}

/**
 * Inspect only the two app-owned directory entries, never cookies or settings.
 * Use the preferred spelling when it exists (including same-inode aliases).
 * Retain a legacy-only directory on case-sensitive volumes. Two distinct
 * profiles require explicit owner recovery; never merge or delete.
 * There are deliberately no filesystem writes or automatic profile migrations.
 */
export function resolveDevDataDirectoryName(
  appData: string,
  inspect: InspectDirectory = inspectDirectory,
): DevDataDirectoryName {
  if (!path.isAbsolute(appData) || appData.includes("\0")) {
    throw new Error("DESKTOP_APP_DATA_INVALID");
  }
  const legacy = inspect(path.join(appData, LEGACY_DEV_DATA_DIRECTORY_NAME));
  const preferred = inspect(path.join(appData, DEV_DATA_DIRECTORY_NAME));
  for (const entry of [legacy, preferred]) {
    if (entry !== null && (!entry.directory || entry.symbolicLink)) {
      throw new Error("DEV_PROFILE_DIRECTORY_UNSAFE");
    }
  }
  if (
    legacy !== null &&
    preferred !== null &&
    (legacy.device !== preferred.device || legacy.inode !== preferred.inode)
  ) {
    throw new Error("DEV_PROFILE_DIRECTORY_AMBIGUOUS");
  }
  return preferred === null && legacy !== null
    ? LEGACY_DEV_DATA_DIRECTORY_NAME
    : DEV_DATA_DIRECTORY_NAME;
}

/** Use the existing entry's physical spelling before profile locks or MCP.
 * Only fixed Dev entries are admissible; no contents or migrations are involved.
 */
export function resolvePhysicalDevDataDirectoryName(
  appData: string,
  inspect: InspectDirectory = inspectDirectory,
  canonicalize: (absolutePath: string) => string = realpathSync.native,
): DevDataDirectoryName {
  const observed = new Map<string, ProfileDirectoryIdentity | null>();
  const selected = resolveDevDataDirectoryName(appData, (candidate) => {
    const entry = inspect(candidate);
    observed.set(candidate, entry);
    return entry;
  });
  const selectedPath = path.join(appData, selected);
  const selectedEntry = observed.get(selectedPath);
  // A genuinely new profile has no physical entry yet. Electron may create
  // the preferred fixed entry; an existing but unreadable entry never gets here.
  if (selectedEntry === null) return selected;
  if (selectedEntry === undefined)
    throw new Error("DEV_PROFILE_DIRECTORY_UNREADABLE");
  let physical: string;
  try {
    physical = canonicalize(selectedPath);
  } catch {
    throw new Error("DEV_PROFILE_DIRECTORY_UNREADABLE");
  }
  const legacyPath = path.join(appData, LEGACY_DEV_DATA_DIRECTORY_NAME);
  const preferredPath = path.join(appData, DEV_DATA_DIRECTORY_NAME);
  if (physical !== legacyPath && physical !== preferredPath)
    throw new Error("DEV_PROFILE_DIRECTORY_UNSAFE");
  const current = inspect(physical);
  if (
    current === null ||
    !current.directory ||
    current.symbolicLink ||
    current.device !== selectedEntry.device ||
    current.inode !== selectedEntry.inode
  )
    throw new Error("DEV_PROFILE_DIRECTORY_UNSAFE");
  return physical === legacyPath
    ? LEGACY_DEV_DATA_DIRECTORY_NAME
    : DEV_DATA_DIRECTORY_NAME;
}
