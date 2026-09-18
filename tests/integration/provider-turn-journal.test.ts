import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PrivateProviderTurnJournal } from "../../src/apps/desktop/provider-turn-journal";

const INTENT = "a".repeat(64);
const OTHER_INTENT = "b".repeat(64);
let root = "";

function recordFile(key: string): string {
  return path.join(
    root,
    "turns",
    `${createHash("sha256").update(key).digest("hex")}.json`,
  );
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-turn-journal-")),
  );
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("EV-05 durable provider turn journal", () => {
  it("admits once, then reports a replay or a conflicting intent", async () => {
    const journal = new PrivateProviderTurnJournal({
      root: path.join(root, "turns"),
    });

    await expect(journal.admit("turn-a", INTENT)).resolves.toBe("admitted");
    await expect(journal.admit("turn-a", INTENT)).resolves.toBe("replayed");
    await expect(journal.admit("turn-a", OTHER_INTENT)).resolves.toBe(
      "conflict",
    );
    await expect(journal.admit("turn-b", INTENT)).resolves.toBe("admitted");
    expect((await fs.stat(path.join(root, "turns"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(recordFile("turn-a"))).mode & 0o777).toBe(0o600);
  });

  it("forgets a released request so its repeat is admitted again", async () => {
    const journal = new PrivateProviderTurnJournal({
      root: path.join(root, "turns"),
    });

    await expect(journal.admit("turn-a", INTENT)).resolves.toBe("admitted");
    await journal.release("turn-a");
    await expect(fs.stat(recordFile("turn-a"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(journal.admit("turn-a", INTENT)).resolves.toBe("admitted");
    // Releasing what was never admitted, or twice, changes nothing.
    await journal.release("turn-unknown");
    await expect(journal.admit("turn-a", INTENT)).resolves.toBe("replayed");
  });

  it("treats a record left unreadable by a crash as unknown, never as new", async () => {
    const journal = new PrivateProviderTurnJournal({
      root: path.join(root, "turns"),
    });
    await journal.admit("turn-seed", INTENT);
    // A crash between exclusive creation and the durable write.
    await fs.writeFile(recordFile("turn-crashed"), "", { mode: 0o600 });

    await expect(journal.admit("turn-crashed", INTENT)).resolves.toBe(
      "unknown",
    );
  });

  it("refuses a journal root that is a symbolic link", async () => {
    await fs.mkdir(path.join(root, "elsewhere"), { mode: 0o700 });
    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "turns"));
    const journal = new PrivateProviderTurnJournal({
      root: path.join(root, "turns"),
    });

    await expect(journal.admit("turn-a", INTENT)).rejects.toThrow(
      "PROVIDER_TURN_JOURNAL_ROOT_UNTRUSTED",
    );
  });

  it("drops records older than the retention window on the next start", async () => {
    const now = Date.now();
    await new PrivateProviderTurnJournal({
      root: path.join(root, "turns"),
    }).admit("turn-old", INTENT);
    const old = new Date(now - 31 * 24 * 60 * 60 * 1_000);
    await fs.utimes(recordFile("turn-old"), old, old);

    const restarted = new PrivateProviderTurnJournal({
      root: path.join(root, "turns"),
      now: () => now,
    });
    await expect(restarted.admit("turn-new", INTENT)).resolves.toBe("admitted");
    await expect(fs.access(recordFile("turn-old"))).rejects.toThrow();
  });
});
