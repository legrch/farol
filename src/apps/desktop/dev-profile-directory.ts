import { lstatSync } from "node:fs";
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
