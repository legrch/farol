import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseQuitReceipt,
  QUIT_RECEIPT_FILE_NAME,
} from "../../src/apps/desktop/quit-receipt";
import { writeQuitReceipt } from "../../src/apps/desktop/quit-receipt-store";

// S35-TA-8. `main.ts` claimed this write "earns that the same way
// `live-task-store.ts` does" and skipped three of the things the store
// actually does: the private-root check, the replaceable-target check and
// the directory sync after the rename. The claim lived in a comment, and no
// test could check it, because `main.ts` exports nothing and no test loads
// it. These cases are the claim, made checkable.
//
// Two of the three are checkable; the third is not, and saying so is part of
// the claim. Removing the replaceable-target check turns three of these red,
// and removing the private-root check turns two red. Removing the directory
// fsync after the rename turns NONE red, because an fsync has no observable
// effect inside the process that calls it — proving it would take a crash
// between the rename and the next boot. Nothing in this repository tests an
// fsync for that reason, including `live-task-store.ts`, whose discipline
// this one matches. That guard rests on review, not on an oracle, and a
// future reader deleting it as redundant would find every test still green.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await fs.chmod(root, 0o700).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

async function stateRoot(): Promise<string> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-quit-receipt-")),
  );
  roots.push(base);
  return path.join(base, "farol-next-state");
}

const AT = "2026-09-20T18:00:00.000Z";
const RECEIPT = { drained: true, unconfirmed: [] as readonly string[] };

describe("quit receipt store", () => {
  it("S35-TA-8 writes a private regular file the promotion reader parses, and leaves no temporary behind", async () => {
    const root = await stateRoot();
    await writeQuitReceipt(root, RECEIPT, AT);

    const target = path.join(root, QUIT_RECEIPT_FILE_NAME);
    const info = await fs.lstat(target);
    expect(info.isFile()).toBe(true);
    expect(info.nlink).toBe(1);
    expect(info.mode & 0o777).toBe(0o600);

    // The bytes are the contract's, and the reader agrees with the writer.
    const parsed = parseQuitReceipt(await fs.readFile(target, "utf8"));
    expect(parsed).toEqual({
      ok: true,
      receipt: { schema: 1, at: AT, drained: true, unconfirmed: [] },
    });

    // Nothing but the receipt: a crashed write must not leave scratch in
    // the app's private state directory.
    expect(await fs.readdir(root)).toEqual([QUIT_RECEIPT_FILE_NAME]);
  });

  it("S35-TA-8 replaces its own previous receipt in place", async () => {
    const root = await stateRoot();
    await writeQuitReceipt(root, { drained: false, unconfirmed: ["b"] }, AT);
    await writeQuitReceipt(root, RECEIPT, "2026-09-20T18:05:00.000Z");

    const parsed = parseQuitReceipt(
      await fs.readFile(path.join(root, QUIT_RECEIPT_FILE_NAME), "utf8"),
    );
    expect(parsed.ok && parsed.receipt.at).toBe("2026-09-20T18:05:00.000Z");
    expect(parsed.ok && parsed.receipt.drained).toBe(true);
    expect(await fs.readdir(root)).toEqual([QUIT_RECEIPT_FILE_NAME]);
  });

  // The three parity checks, one per row. Each leaves the state directory as
  // it found it: a quit that cannot write its receipt is a quit that never
  // confirmed, and the caller keeps the run marker so the next promotion
  // refuses. Refusing is the whole point — overwriting would be the bug.
  it("S35-TA-8 refuses when the target is a symlink instead of this app's own file", async () => {
    const root = await stateRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const elsewhere = path.join(root, "elsewhere.json");
    await fs.writeFile(elsewhere, "{}\n", { mode: 0o600 });
    await fs.symlink(elsewhere, path.join(root, QUIT_RECEIPT_FILE_NAME));

    await expect(writeQuitReceipt(root, RECEIPT, AT)).rejects.toThrow(
      "QUIT_RECEIPT_STATE_UNSAFE",
    );
    // The symlink is still a symlink and its target is untouched: the write
    // refused rather than replacing somebody else's arrangement.
    expect(
      (
        await fs.lstat(path.join(root, QUIT_RECEIPT_FILE_NAME))
      ).isSymbolicLink(),
    ).toBe(true);
    expect(await fs.readFile(elsewhere, "utf8")).toBe("{}\n");
  });

  it("S35-TA-8 refuses when the target has a second hard link, so something else still holds it", async () => {
    const root = await stateRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, QUIT_RECEIPT_FILE_NAME);
    await fs.writeFile(target, "{}\n", { mode: 0o600 });
    await fs.link(target, path.join(root, "second-link.json"));

    await expect(writeQuitReceipt(root, RECEIPT, AT)).rejects.toThrow(
      "QUIT_RECEIPT_STATE_UNSAFE",
    );
    expect(await fs.readFile(target, "utf8")).toBe("{}\n");
  });

  it("S35-TA-8 refuses when the target is group- or other-readable", async () => {
    const root = await stateRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, QUIT_RECEIPT_FILE_NAME);
    await fs.writeFile(target, "{}\n", { mode: 0o644 });

    await expect(writeQuitReceipt(root, RECEIPT, AT)).rejects.toThrow(
      "QUIT_RECEIPT_STATE_UNSAFE",
    );
  });

  it("S35-TA-8 refuses when the state directory itself is a symlink", async () => {
    const root = await stateRoot();
    const real = path.join(path.dirname(root), "real-state");
    await fs.mkdir(real, { recursive: true, mode: 0o700 });
    await fs.symlink(real, root);

    await expect(writeQuitReceipt(root, RECEIPT, AT)).rejects.toThrow(
      "QUIT_RECEIPT_STATE_UNSAFE",
    );
    // Nothing was written through the link.
    expect(await fs.readdir(real)).toEqual([]);
  });

  it("S35-TA-8 tightens a state directory that is not private, rather than writing into it as it is", async () => {
    const root = await stateRoot();
    // `mkdir` with a mode does nothing when the directory already exists,
    // which is exactly the case the old inline version never handled.
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o755);

    await writeQuitReceipt(root, RECEIPT, AT);

    expect((await fs.lstat(root)).mode & 0o777).toBe(0o700);
    expect(
      parseQuitReceipt(
        await fs.readFile(path.join(root, QUIT_RECEIPT_FILE_NAME), "utf8"),
      ).ok,
    ).toBe(true);
  });

  it("S35-TA-8 refuses a receipt the reader could not read back, before touching the directory", async () => {
    const root = await stateRoot();
    const tooMany = Array.from({ length: 64 }, (_, index) => `child-${index}`);

    // The serializer bounds what it will store; the point here is that the
    // refusal happens before any state exists on disk.
    await expect(
      writeQuitReceipt(root, { drained: false, unconfirmed: tooMany }, AT),
    ).rejects.toThrow();
    await expect(fs.lstat(root)).rejects.toThrow();
  });
});
