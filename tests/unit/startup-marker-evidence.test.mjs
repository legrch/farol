import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertArchivedMarker } from "../e2e/fixtures/startup-marker-evidence.mjs";

it("accepts exactly one byte-identical predecessor and rejects missing, duplicated or altered custody", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-marker-evidence-"),
  );
  const archive = path.join(root, "run-history", "one");
  const old = Buffer.from("old marker\n");
  const quit = Buffer.from("old unknown quit\n");
  try {
    await fs.mkdir(archive, { recursive: true });
    await fs.writeFile(path.join(archive, "running.json"), old);
    await fs.writeFile(path.join(archive, "last-quit.json"), quit);
    expect(await assertArchivedMarker(root, old, quit)).toBe("one");
    await expect(
      assertArchivedMarker(root, Buffer.from("other"), quit),
    ).rejects.toThrow("ORIGINAL_FAILED_MARKER_COPY_NOT_UNIQUE");
    await fs.writeFile(path.join(archive, "last-quit.json"), "changed");
    await expect(assertArchivedMarker(root, old, quit)).rejects.toThrow();
    await fs.writeFile(path.join(archive, "last-quit.json"), quit);
    const duplicate = path.join(root, "run-history", "two");
    await fs.mkdir(duplicate);
    await fs.writeFile(path.join(duplicate, "running.json"), old);
    await expect(assertArchivedMarker(root, old, quit)).rejects.toThrow(
      "ORIGINAL_FAILED_MARKER_COPY_NOT_UNIQUE",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
