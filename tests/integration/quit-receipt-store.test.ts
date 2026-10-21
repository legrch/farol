import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseQuitReceipt,
  QUIT_RECEIPT_FILE_NAME,
} from "../../src/apps/desktop/quit-receipt";
import { writeQuitReceipt } from "../../src/apps/desktop/quit-receipt-store";
// `tooling/promotion-obligations.mjs` is plain JS with no declaration file:
// `tsconfig.json`'s `include` never lists `tooling/**`, on purpose, because
// it is loaded by Node's unflagged type stripping, not compiled. Every other
// test that reaches it is itself a `.mjs` file; this is the first `.ts` test
// to import it, and a relative-path `declare module` augmentation is
// rejected by TS (TS2665) for a module that already resolves to real,
// untyped source. `activationObligations` is typed locally instead, right
// where it is called, so the `any` this import carries never reaches an
// assertion unnoticed.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- TS7016: no declaration file for this .mjs module.
import { activationObligations } from "../../tooling/promotion-obligations.mjs";

type ActivationObligationsReport = Readonly<{
  schema: string;
  userData: string;
  obligations: readonly string[];
  unreadable: readonly string[];
  changed: readonly string[];
  drained: boolean;
}>;
const readActivationObligations: (
  userData: string,
) => Promise<ActivationObligationsReport> = activationObligations;

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
  return path.join(base, "farol-state");
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

  // ---------------------------------------------------------------------
  // The eight cases above are single guards: each proves one check fires.
  // None of them prove the OPERATION is safe once concurrency, missing
  // state, a failure mid-write, a real restart, or repetition enters the
  // picture. Every case below asserts on the directory's contents
  // afterward, not merely on what the promise resolved or threw — debris
  // left behind in the app's private state directory is exactly the
  // failure mode a single-case guard test cannot see.
  // ---------------------------------------------------------------------

  it("S35-TA-8 leaves exactly one parseable receipt and no scratch when two writes race on the same directory", async () => {
    const root = await stateRoot();
    const first = { drained: true, unconfirmed: [] as readonly string[] };
    const second = { drained: false, unconfirmed: ["route-b"] };
    const firstAt = "2026-09-20T18:00:00.000Z";
    const secondAt = "2026-09-20T18:00:00.500Z";

    // Both are allowed to win — a race is not a defect merely because it
    // exists — but neither may throw, and the loser's temporary must not
    // survive alongside the winner's receipt.
    await Promise.all([
      writeQuitReceipt(root, first, firstAt),
      writeQuitReceipt(root, second, secondAt),
    ]);

    expect(await fs.readdir(root)).toEqual([QUIT_RECEIPT_FILE_NAME]);
    const parsed = parseQuitReceipt(
      await fs.readFile(path.join(root, QUIT_RECEIPT_FILE_NAME), "utf8"),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && [firstAt, secondAt].includes(parsed.receipt.at)).toBe(
      true,
    );
  }, 60_000);

  it("S35-TA-8 creates every missing path segment when neither the state directory nor its parent exists yet", async () => {
    const base = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-quit-receipt-")),
    );
    roots.push(base);
    // Two missing segments, not one: `stateRoot()` always leaves exactly
    // the leaf undone, which is not the same claim as "the whole chain".
    const root = path.join(base, "nested", "farol-state");

    await writeQuitReceipt(root, RECEIPT, AT);

    expect(await fs.readdir(root)).toEqual([QUIT_RECEIPT_FILE_NAME]);
    expect(
      parseQuitReceipt(
        await fs.readFile(path.join(root, QUIT_RECEIPT_FILE_NAME), "utf8"),
      ).ok,
    ).toBe(true);
  });

  it("S35-TA-8 writes into a state directory that already exists but is empty", async () => {
    const root = await stateRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });

    await writeQuitReceipt(root, RECEIPT, AT);

    expect(await fs.readdir(root)).toEqual([QUIT_RECEIPT_FILE_NAME]);
    expect(
      parseQuitReceipt(
        await fs.readFile(path.join(root, QUIT_RECEIPT_FILE_NAME), "utf8"),
      ).ok,
    ).toBe(true);
  });

  it("S35-TA-8 writes the receipt beside an unrelated file already in the state directory, and leaves that file untouched", async () => {
    const root = await stateRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const sibling = path.join(root, "live-tasks.json");
    await fs.writeFile(sibling, '{"unrelated":true}\n', { mode: 0o600 });

    await writeQuitReceipt(root, RECEIPT, AT);

    expect((await fs.readdir(root)).sort()).toEqual(
      [QUIT_RECEIPT_FILE_NAME, "live-tasks.json"].sort(),
    );
    expect(await fs.readFile(sibling, "utf8")).toBe('{"unrelated":true}\n');
    expect(
      parseQuitReceipt(
        await fs.readFile(path.join(root, QUIT_RECEIPT_FILE_NAME), "utf8"),
      ).ok,
    ).toBe(true);
  });

  it("S35-TA-8 leaves the previous receipt intact and parseable when the rename fails after the temporary file already exists", async () => {
    const root = await stateRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const previousAt = "2026-09-20T17:00:00.000Z";
    await writeQuitReceipt(
      root,
      { drained: true, unconfirmed: [] },
      previousAt,
    );
    const target = path.join(root, QUIT_RECEIPT_FILE_NAME);
    const before = await fs.readFile(target, "utf8");

    // Fail the write exactly between "the temporary file exists" and
    // "the rename lands": chmod the directory read-only from inside the
    // real `rename` call, immediately before letting that same real call
    // run, so the rename itself is what the OS refuses (EACCES) — not a
    // fabricated error standing in for one.
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockImplementationOnce(async (oldPath, newPath) => {
        await fs.chmod(root, 0o500);
        return originalRename(oldPath, newPath);
      });

    try {
      await expect(
        writeQuitReceipt(
          root,
          { drained: false, unconfirmed: ["route-b"] },
          "2026-09-20T17:05:00.000Z",
        ),
      ).rejects.toThrow();
    } finally {
      renameSpy.mockRestore();
      await fs.chmod(root, 0o700).catch(() => undefined);
    }

    // The last good receipt must still be there, byte for byte.
    expect(await fs.readFile(target, "utf8")).toBe(before);
    const parsedBefore = parseQuitReceipt(before);
    expect(parsedBefore.ok && parsedBefore.receipt.drained).toBe(true);
    expect(parsedBefore.ok && parsedBefore.receipt.at).toBe(previousAt);
  }, 60_000);

  it("S35-TA-8 a fresh read of the bytes agrees with the writer: parseQuitReceipt and the promotion CLI's own activationObligations both see a drained quit", async () => {
    const root = await stateRoot();
    const userData = path.dirname(root);
    await writeQuitReceipt(root, RECEIPT, AT);

    // "Restart" means reading the bytes fresh, through the exact readers
    // the rest of the app uses, not through anything this test kept warm.
    const bytes = await fs.readFile(
      path.join(root, QUIT_RECEIPT_FILE_NAME),
      "utf8",
    );
    expect(parseQuitReceipt(bytes)).toEqual({
      ok: true,
      receipt: { schema: 1, at: AT, drained: true, unconfirmed: [] },
    });

    const report = await readActivationObligations(userData);
    expect(report).toMatchObject({
      drained: true,
      obligations: [],
      unreadable: [],
    });
  });

  it("S35-TA-8 the promotion CLI's own reader reports an undrained quit as QUIT_UNCONFIRMED, from the same bytes writeQuitReceipt produced", async () => {
    const root = await stateRoot();
    const userData = path.dirname(root);
    await writeQuitReceipt(
      root,
      { drained: false, unconfirmed: ["route-b"] },
      AT,
    );

    const bytes = await fs.readFile(
      path.join(root, QUIT_RECEIPT_FILE_NAME),
      "utf8",
    );
    expect(parseQuitReceipt(bytes)).toEqual({
      ok: true,
      receipt: { schema: 1, at: AT, drained: false, unconfirmed: ["route-b"] },
    });

    const report = await readActivationObligations(userData);
    expect(report).toMatchObject({
      drained: false,
      obligations: ["QUIT_UNCONFIRMED:route-b"],
      unreadable: [],
    });
  });

  it("S35-TA-8 three sequential quits leave only the third receipt, with no scratch accumulated across the cycles", async () => {
    const root = await stateRoot();
    await writeQuitReceipt(
      root,
      { drained: false, unconfirmed: ["a"] },
      "2026-09-20T18:00:00.000Z",
    );
    await writeQuitReceipt(
      root,
      { drained: false, unconfirmed: ["b"] },
      "2026-09-20T18:01:00.000Z",
    );
    await writeQuitReceipt(
      root,
      { drained: true, unconfirmed: [] },
      "2026-09-20T18:02:00.000Z",
    );

    expect(await fs.readdir(root)).toEqual([QUIT_RECEIPT_FILE_NAME]);
    const parsed = parseQuitReceipt(
      await fs.readFile(path.join(root, QUIT_RECEIPT_FILE_NAME), "utf8"),
    );
    expect(parsed).toEqual({
      ok: true,
      receipt: {
        schema: 1,
        at: "2026-09-20T18:02:00.000Z",
        drained: true,
        unconfirmed: [],
      },
    });
  });
});
