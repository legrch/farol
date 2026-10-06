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
    if (!(await ports.verify(lease))) {
      throw new Error("STARTUP_PROMOTION_LEASE_LOST");
    }
    return await critical(() => ports.verify(lease));
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
