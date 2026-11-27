import path from "node:path";
import type { InstalledUpdateResourcesOrigin } from "./startup";

// The pure refusals of who may run the update owner: a correlated relaunch's
// resources origin, and the standalone supervisory controller. Each reads only
// the values it is handed; the caller keeps every filesystem read and recheck.

const SHARED_SLOT = "/Applications/Farol.app";

/** True when the resources origin is not one a correlated relaunch could supply. */
export function resourcesOriginRefused(input: {
  origin: InstalledUpdateResourcesOrigin;
  supervised: boolean;
  actualApp: string;
  userData: string;
}): boolean {
  const { origin } = input;
  return (
    input.supervised ||
    origin.slot !== SHARED_SLOT ||
    !["private-launch", "shared-slot"].includes(origin.kind) ||
    origin.app !== input.actualApp ||
    (origin.kind === "private-launch"
      ? !/^[a-f0-9]{32}$/u.test(origin.operationId) ||
        origin.app !==
          path.join(
            input.userData,
            "installed-updates",
            origin.operationId,
            "launch-Farol.app",
          )
      : origin.app !== SHARED_SLOT)
  );
}

/** True when a supervisory request does not name the captured profile and slot. */
export function supervisedControlRefused(input: {
  userData: string;
  profile: string;
  leaseFile: string;
  leasePath(profile: string): string;
  resourcesApp: string;
  slot: string;
  directory: string;
}): boolean {
  return (
    input.userData !== input.profile ||
    input.leaseFile !== input.leasePath(input.profile) ||
    input.resourcesApp === input.slot ||
    input.resourcesApp.startsWith(input.profile + path.sep) ||
    input.directory !== path.join(input.resourcesApp, "Contents/Resources/app")
  );
}

/** True when a retained Ready record is exactly the one a supervisor must replace. */
export function readyMatches(input: {
  digest: string | null;
  expectedDigest: string;
  manifestBuildId: string | null;
  expectedBuildId: string;
  ready: Readonly<{
    operation: unknown;
    preparation?: unknown;
    helper?: unknown;
    archiveReleased?: boolean | undefined;
    downloadId?: string | undefined;
    handle: string;
  }>;
  root: string;
}): boolean {
  const { ready } = input;
  return (
    input.digest === input.expectedDigest &&
    input.manifestBuildId !== null &&
    input.manifestBuildId === input.expectedBuildId &&
    ready.operation === null &&
    ready.preparation === undefined &&
    (ready.helper === undefined || ready.helper === null) &&
    ready.archiveReleased !== true &&
    ready.downloadId !== undefined &&
    ready.handle.startsWith(
      path.join(input.root, `download-${ready.downloadId}`) + path.sep,
    )
  );
}
