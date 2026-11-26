const MAX_PACKAGE_BYTES = 2_147_483_648;
const PUBLISH_INTERVAL_MS = 250;

/** Transfer counters must be sane, monotonic and agree on one total. */
export function transferAdmissible(
  progress: Readonly<{ receivedBytes: number; totalBytes: number }>,
  lastBytes: number,
  knownTotal: number | undefined,
): boolean {
  return !(
    !Number.isSafeInteger(progress.receivedBytes) ||
    !Number.isSafeInteger(progress.totalBytes) ||
    progress.receivedBytes < 0 ||
    progress.receivedBytes > progress.totalBytes ||
    progress.totalBytes <= 0 ||
    progress.totalBytes > MAX_PACKAGE_BYTES ||
    progress.receivedBytes < lastBytes ||
    (knownTotal !== undefined && progress.totalBytes !== knownTotal)
  );
}

/** Intermediate ticks are rate limited; the final byte count always passes. */
export function transferThrottled(
  now: number,
  lastPublishedAt: number,
  receivedBytes: number,
  totalBytes: number | undefined,
): boolean {
  return (
    now >= lastPublishedAt &&
    now - lastPublishedAt < PUBLISH_INTERVAL_MS &&
    receivedBytes !== totalBytes
  );
}
