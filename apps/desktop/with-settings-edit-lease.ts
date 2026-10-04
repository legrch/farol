// Host resource mechanics: the promotion lease covers the original attempt and
// its result recording, not the later human delivery acknowledgement.
export async function withSettingsEditLease<T>(
  operationId: string,
  attempt: () => Promise<T>,
  release: (operationId: string) => Promise<void>,
): Promise<T> {
  try {
    return await attempt();
  } finally {
    await release(operationId);
  }
}
