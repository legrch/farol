// Attachment staging at startup: leftovers of operations the previous run did
// not finish are removed before any new operation stages a file. A cleanup that
// fails does not stop startup; it answers not ready, and attachments stay
// unavailable until the profile is restarted. Nothing here retries.

export async function cleanupAttachmentStaging(
  cleanup: () => Promise<void>,
): Promise<boolean> {
  try {
    await cleanup();
    return true;
  } catch {
    return false;
  }
}
