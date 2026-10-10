import fs from "node:fs/promises";
import path from "node:path";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
} from "./promotion-lease";

export type StartupPromotionLeasePorts = Readonly<{
  acquire: typeof acquirePromotionLease;
  verify: typeof verifyPromotionLease;
  release: typeof releasePromotionLease;
}>;

const defaultPorts: StartupPromotionLeasePorts = {
  acquire: acquirePromotionLease,
  verify: verifyPromotionLease,
  release: releasePromotionLease,
};

// Maintenance owns publication and durable retirement of this fixed intent.
// Startup never decodes it: valid-looking terminal bytes cannot settle a lost
// completion response. Symlinks, directories and unreadable entries also fence
// startup. Only confirmed absence admits the generation under its existing lock.
async function assertInstalledReplacementAbsent(
  userData: string,
): Promise<void> {
  const pending = path.join(
    userData,
    "farol-next-state",
    "installed-replacement.pending",
  );
  try {
    await fs.lstat(pending);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("STARTUP_INSTALLED_REPLACEMENT_UNCONFIRMED", {
      cause: error,
    });
  }
  throw new Error("STARTUP_INSTALLED_REPLACEMENT_PENDING");
}

export class StartupPromotionLeaseReleaseError extends AggregateError {
  readonly releaseFailure: unknown;
  readonly primaryFailure: Readonly<{ error: unknown }> | undefined;

  constructor(
    releaseFailure: unknown,
    primaryFailure: Readonly<{ error: unknown }> | undefined,
  ) {
    super(
      primaryFailure
        ? [primaryFailure.error, releaseFailure]
        : [releaseFailure],
      "STARTUP_PROMOTION_LEASE_RELEASE_FAILED",
      { cause: primaryFailure ? primaryFailure.error : releaseFailure },
    );
    this.name = "StartupPromotionLeaseReleaseError";
    this.releaseFailure = releaseFailure;
    this.primaryFailure = primaryFailure;
  }
}

/**
 * The caller holds this section from before whenReady through the original
 * marker presence check and publication, fencing immediately before the write
 * with verify. Configuration and normal admission belong after this resolves.
 * Contention is terminal here; only the existing acquire owns its probes.
 */
export async function withStartupPromotionLease<T>(
  userData: string,
  generation: string,
  critical: (verify: () => Promise<boolean>) => Promise<T>,
  ports: StartupPromotionLeasePorts = defaultPorts,
): Promise<T> {
  const lease = await ports.acquire(userData, generation, "admission");
  if (lease === null) throw new Error("STARTUP_PROMOTION_BUSY");

  let primaryFailure: Readonly<{ error: unknown }> | undefined;
  try {
    const verify = async (): Promise<boolean> => {
      if (!(await ports.verify(lease))) return false;
      await assertInstalledReplacementAbsent(userData);
      return true;
    };
    if (!(await verify())) {
      throw new Error("STARTUP_PROMOTION_LEASE_LOST");
    }
    return await critical(verify);
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    try {
      await ports.release(lease);
    } catch (error) {
      throw new StartupPromotionLeaseReleaseError(error, primaryFailure);
    }
  }
}
