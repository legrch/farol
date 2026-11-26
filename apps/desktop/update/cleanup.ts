import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// `package-cleanup-pending.json` fences updates while a verifier extraction may
// still be on disk. Its content is untrusted: a handle names the downloaded
// archive, never a staging directory, so it only has to be a believable path
// inside the update root. Whether the fence may fall is decided elsewhere, by
// whether every extraction is gone; this file only judges the marker itself.
export const CLEANUP_MARKER_SCHEMA = "farol.update-package-cleanup/1";
// A NUL or other control character in a path is never a believable name.
const markerPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
export const CleanupMarker = z.strictObject({
  schema: z.literal(CLEANUP_MARKER_SCHEMA),
  handle: markerPath,
  operationRoot: markerPath.optional(),
});
const OPERATION_ROOT = /^[0-9a-f]{32}$/u;

function inside(root: string, candidate: string): boolean {
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate)
    return false;
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep)[0] !== ".."
  );
}

/**
 * Clear the fence only when the marker is well formed, names paths inside the
 * update root, every verifier extraction is absent or reclaimed, and an
 * operation root it names holds no prepared copy. Anything else returns false
 * and changes nothing. A marker that changed since it was read is not cleared.
 */
export async function settleCleanupMarker(input: {
  root: string;
  file: string;
  marker: unknown;
  extractionsGone: boolean;
  /**
   * The update root as the same reclaim pass captured it. The outcome is about
   * that directory, so it is confirmed again right before the unlink.
   */
  rootIdentity: Readonly<{ dev: bigint; ino: bigint }> | null;
  read(): Promise<unknown>;
}): Promise<boolean> {
  const parsed = CleanupMarker.safeParse(input.marker);
  if (!parsed.success || !input.extractionsGone || input.rootIdentity === null)
    return false;
  const { handle, operationRoot } = parsed.data;
  if (!inside(input.root, handle)) return false;
  if (operationRoot !== undefined) {
    if (
      path.dirname(operationRoot) !== input.root ||
      !OPERATION_ROOT.test(path.basename(operationRoot))
    )
      return false;
    try {
      await fs.lstat(path.join(operationRoot, "staged.app"));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  if (JSON.stringify(await input.read()) !== JSON.stringify(input.marker))
    return false;
  const root = await fs.lstat(input.root, { bigint: true });
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.dev !== input.rootIdentity.dev ||
    root.ino !== input.rootIdentity.ino ||
    (await fs.realpath(input.root)) !== input.root
  )
    return false;
  await fs.unlink(input.file);
  const parent = await fs.open(
    input.root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return true;
}
