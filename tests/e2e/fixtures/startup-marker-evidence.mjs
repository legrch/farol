import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

// Read-only evidence: the predecessor remains byte-identical in one archive.
export async function assertArchivedMarker(
  stateRoot,
  originalMarker,
  originalQuit,
) {
  const history = path.join(stateRoot, "run-history");
  const matching = [];
  for (const name of await fs.readdir(history)) {
    const copy = await fs.readFile(path.join(history, name, "running.json"));
    if (copy.equals(originalMarker)) matching.push(name);
  }
  assert.equal(matching.length, 1, "ORIGINAL_FAILED_MARKER_COPY_NOT_UNIQUE");
  const quitCopy = path.join(history, matching[0], "last-quit.json");
  if (originalQuit) assert.deepEqual(await fs.readFile(quitCopy), originalQuit);
  else await assert.rejects(fs.lstat(quitCopy), { code: "ENOENT" });
  return matching[0];
}
