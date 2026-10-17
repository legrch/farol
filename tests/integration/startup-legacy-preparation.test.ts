import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStartupLegacyPreparation,
  selectStartupLegacyPreparation,
} from "../../apps/desktop/recovery/legacy-preparation";
import {
  MAX_CHATGPT_TASK_JOURNAL_BYTES,
  type ChatGptTaskJournalRecord,
  type ChatGptTaskJournalResult,
} from "../../src/apps/desktop/chatgpt-task-journal-record";

// Real fresh private filesystem custody and one-shot memoization only. The
// owner callback and opaque pending fence below are controlled test inputs:
// they qualify no Go intent, preparation, outcome, current authority, process,
// Electron, native lease or recovery acceptance. No host/helper/FS mocks.
// Retain EVERY fixture and displaced original, including failed transitions.
// Do not add cleanup hooks or repair/retry a failed retirement.
const ARCHIVE_NAME = "legacy-chatgpt-prepared.json";
const TIMESTAMP = "2026-10-16T00:00:00.000Z";
const PENDING_BYTES = Buffer.from([0x00, 0xff, 0x46, 0x49, 0x58, 0x0a]);
const sum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");

function record(
  patch: Partial<ChatGptTaskJournalRecord> = {},
): ChatGptTaskJournalRecord {
  return {
    schema: 1,
    operationId: randomUUID(),
    kind: "readonly",
    phase: "prepared",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    result: null,
    ...patch,
  };
}

const retainedResult: ChatGptTaskJournalResult = {
  state: "outcome_unknown",
  code: "CHATGPT_TASK_INTERRUPTED_AFTER_INTENT",
  deltaCount: 0,
  observedCharacters: 0,
  attachmentCount: 0,
  totalBytes: 0,
  stagingCleanup: null,
};

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function privateFile(file: string, bytes: Buffer): Promise<void> {
  await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  await fs.chmod(file, 0o600);
}

type Missing = "userData" | "state" | "legacy" | "file";
async function fixture(
  options: {
    missing?: Missing;
    value?: ChatGptTaskJournalRecord;
    bytes?: Buffer;
  } = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-legacy-prep-")),
  );
  console.info("Retained legacy preparation fixture:", root);
  await fs.chmod(root, 0o700);
  const retained = path.join(root, "retained-originals");
  const userData = path.join(root, "Farol Dev");
  const state = path.join(userData, "farol-next-state");
  const legacy = path.join(state, "chatgpt-task-journal");
  const file = path.join(legacy, "chatgpt-task-journal.json");
  const core = path.join(state, "go-core");
  const archive = path.join(core, "chat-retired-" + randomUUID());
  const target = path.join(archive, ARCHIVE_NAME);
  const pending = path.join(state, "go-core.empty-recovery.pending");
  const value = options.value ?? record();
  const bytes = options.bytes ?? json(value);
  await privateDirectory(retained);
  if (options.missing !== "userData") {
    await privateDirectory(userData);
    if (options.missing !== "state") {
      for (const directory of [state, core, archive])
        await privateDirectory(directory);
      // Opaque fence only: this is deliberately not a Go preparation receipt.
      await privateFile(pending, PENDING_BYTES);
      if (options.missing !== "legacy") {
        await privateDirectory(legacy);
        if (options.missing !== "file") await privateFile(file, bytes);
      }
    }
  }
  return {
    root,
    retained,
    userData,
    state,
    legacy,
    file,
    core,
    archive,
    target,
    pending,
    value,
    bytes,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function displace(f: Fixture, file: string, name: string) {
  const retained = path.join(f.retained, name);
  // Destination names are test-owned and unique; never overwrite evidence.
  await expect(fs.lstat(retained)).rejects.toMatchObject({ code: "ENOENT" });
  await fs.rename(file, retained);
  console.info("Retained displaced legacy preparation original:", retained);
  return retained;
}

async function preserveBytes(f: Fixture, file: string, name: string) {
  const retained = path.join(f.retained, name);
  await fs.copyFile(file, retained, constants.COPYFILE_EXCL);
  console.info("Retained legacy preparation preimage:", retained);
  return retained;
}

async function evidence(file: string) {
  const stat = await fs.lstat(file);
  return {
    bytes: await fs.readFile(file),
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode & 0o777,
    uid: stat.uid,
    links: stat.nlink,
  };
}

// Independent inventory of namespace, physical identity, permissions and bytes.
// Reads may update atime; exclude it. Never follow a fixture symlink.
async function inventory(root: string) {
  const entries: {
    path: string;
    metadata: bigint[];
    bytes?: string;
    target?: string;
  }[] = [];
  async function visit(file: string): Promise<void> {
    const stat = await fs.lstat(file, { bigint: true });
    const entry = {
      path: path.relative(root, file) || ".",
      metadata: [
        stat.dev,
        stat.ino,
        stat.uid,
        stat.gid,
        stat.mode,
        stat.nlink,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
      ],
    };
    if (stat.isSymbolicLink())
      entries.push({ ...entry, target: await fs.readlink(file) });
    else if (stat.isFile())
      entries.push({
        ...entry,
        bytes: (await fs.readFile(file)).toString("hex"),
      });
    else entries.push(entry);
    if (stat.isDirectory())
      for (const name of (await fs.readdir(file)).sort())
        await visit(path.join(file, name));
  }
  await visit(root);
  return entries;
}

async function select(
  f: Fixture,
  assertCurrent: () => Promise<void> = async () => {},
) {
  const pin = await selectStartupLegacyPreparation(f.userData, assertCurrent);
  expect(pin).not.toBeNull();
  if (pin === null) throw new Error("Expected prepared readonly fixture pin");
  return pin;
}

async function refusesUnchanged(f: Fixture, action: () => Promise<unknown>) {
  const before = await inventory(f.root);
  await expect(action()).rejects.toThrow();
  expect(await inventory(f.root)).toEqual(before);
}

async function absent(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

const ineligible: { name: string; patch: Partial<ChatGptTaskJournalRecord> }[] =
  [
    { name: "dispatch intent", patch: { phase: "dispatch_intent" } },
    {
      name: "retained unknown result",
      patch: { phase: "result_retained", result: retainedResult },
    },
    {
      name: "already acknowledged legacy metadata",
      patch: { phase: "delivery_acknowledged", result: retainedResult },
    },
    { name: "prepared attachment", patch: { kind: "attachment" } },
    {
      name: "prepared with a full nonnull result",
      patch: { result: retainedResult },
    },
  ];

const malformed = [
  {
    name: "malformed JSON",
    bytes: () => Buffer.from('{"schema":'),
  },
  {
    name: "duplicate kind even when the final value would be ineligible",
    bytes: () =>
      Buffer.from(
        JSON.stringify(record({ kind: "attachment" })).replace(
          '"kind":',
          '"kind":"readonly","kind":',
        ),
      ),
  },
  {
    name: "escaped duplicate phase",
    bytes: () =>
      Buffer.from(
        JSON.stringify(record()).replace(
          '"phase":',
          '"\\u0070hase":"prepared","phase":',
        ),
      ),
  },
  {
    name: "invalid UTF-8 in an otherwise complete record",
    bytes: () => {
      const original = json(record());
      const offset = original.indexOf("readonly");
      return Buffer.concat([
        original.subarray(0, offset),
        Buffer.from([0xc3, 0x28]),
        original.subarray(offset + "readonly".length),
      ]);
    },
  },
  {
    name: "incomplete schema even when the phase is not prepared",
    bytes: () => json({ schema: 1, phase: "dispatch_intent" }),
  },
];

describe.skipIf(process.platform === "win32")(
  "startup legacy preparation on retained real files (no recovery authority)",
  () => {
    it("preserves original bytes/inode in the exact archive and consumes only this pin", async () => {
      const f = await fixture();
      const original = await evidence(f.file);
      const pending = await evidence(f.pending);
      const legacyIdentity = await fs.lstat(f.legacy);
      const pin = await select(f);
      expect(pin.operationId).toBe(f.value.operationId);
      expect(pin.sha256).toBe(sum(f.bytes));
      expect(Object.isFrozen(pin)).toBe(true);
      expect(Reflect.set(pin, "operationId", randomUUID())).toBe(false);
      expect(Reflect.set(pin, "verify", async () => {})).toBe(false);
      expect(() =>
        assertStartupLegacyPreparation(pin, f.userData),
      ).not.toThrow();
      await pin.verify();

      const first = pin.retireInto(f.archive);
      expect(pin.retireInto(f.archive)).toBe(first);
      await expect(pin.verify()).rejects.toThrow(
        "STARTUP_LEGACY_PREPARATION_CONSUMED",
      );
      const retired = await first;
      expect(retired).toEqual({
        bytes: f.bytes,
        device: original.device,
        inode: original.inode,
      });
      expect(pin.retireInto(f.archive)).toBe(first);
      await expect(pin.retireInto(f.archive + "-changed")).rejects.toThrow(
        "STARTUP_LEGACY_PREPARATION_SELECTION_CHANGED",
      );
      console.info("Retained retired legacy preparation original:", f.target);
      expect(await evidence(f.target)).toEqual(original);
      expect(
        JSON.parse((await fs.readFile(f.target)).toString("utf8")),
      ).toEqual(f.value);
      expect(f.value.phase).toBe("prepared");
      expect(f.value.result).toBeNull();
      expect(await fs.readdir(f.archive)).toEqual([ARCHIVE_NAME]);
      expect(await fs.readdir(f.legacy)).toEqual([]);
      expect(await absent(f.file)).toBe(true);
      expect(await evidence(f.pending)).toEqual(pending);
      const legacyAfter = await fs.lstat(f.legacy);
      expect([legacyAfter.dev, legacyAfter.ino]).toEqual([
        legacyIdentity.dev,
        legacyIdentity.ino,
      ]);
      for (const directory of [
        f.root,
        f.userData,
        f.state,
        f.legacy,
        f.core,
        f.archive,
      ]) {
        const stat = await fs.lstat(directory);
        expect(stat.isDirectory()).toBe(true);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.mode & 0o777).toBe(0o700);
        expect(stat.uid).toBe(process.geteuid!());
        expect(await fs.realpath(directory)).toBe(directory);
      }
      // Membership remains true after consumption; active eligibility does not.
      expect(() =>
        assertStartupLegacyPreparation(pin, f.userData),
      ).not.toThrow();
      await expect(pin.verify()).rejects.toThrow(
        "STARTUP_LEGACY_PREPARATION_CONSUMED",
      );
    });

    it("refuses raw/copied tokens and an authentic token scoped to other userData", async () => {
      const f = await fixture();
      const other = await fixture({ missing: "state" });
      const before = await inventory(f.root);
      const otherBefore = await inventory(other.root);
      const pin = await select(f);
      const raw = Object.freeze({
        operationId: pin.operationId,
        sha256: pin.sha256,
        verify: pin.verify,
        retireInto: pin.retireInto,
      });
      for (const copied of [raw, { ...pin }])
        expect(() =>
          assertStartupLegacyPreparation(copied, f.userData),
        ).toThrow("STARTUP_LEGACY_PREPARATION_SELECTION_INVALID");
      expect(() => assertStartupLegacyPreparation(pin, other.userData)).toThrow(
        "STARTUP_LEGACY_PREPARATION_SELECTION_INVALID",
      );
      await pin.verify();
      expect(await inventory(f.root)).toEqual(before);
      expect(await inventory(other.root)).toEqual(otherBefore);
    });

    it.each(["userData", "state", "legacy", "file"] as const)(
      "returns null without provisioning missing %s",
      async (missing) => {
        const f = await fixture({ missing });
        const before = await inventory(f.root);
        expect(
          await selectStartupLegacyPreparation(f.userData, async () => {}),
        ).toBeNull();
        expect(await inventory(f.root)).toEqual(before);
      },
    );

    it.each(ineligible)(
      "returns null and leaves the complete original unchanged: $name",
      async ({ patch }) => {
        const f = await fixture({ value: record(patch) });
        const before = await inventory(f.root);
        expect(
          await selectStartupLegacyPreparation(f.userData, async () => {}),
        ).toBeNull();
        expect(await inventory(f.root)).toEqual(before);
      },
    );

    it.each(malformed)(
      "throws rather than filtering $name",
      async ({ bytes }) => {
        const f = await fixture({ bytes: bytes() });
        await refusesUnchanged(f, () =>
          selectStartupLegacyPreparation(f.userData, async () => {}),
        );
      },
    );

    it.each([
      "file-mode",
      "state-mode",
      "legacy-mode",
      "file-symlink",
      "root-symlink",
      "file-hardlink",
      "oversize",
    ] as const)("refuses unsafe original storage: %s", async (kind) => {
      const f = await fixture();
      if (kind === "file-mode") await fs.chmod(f.file, 0o644);
      else if (kind === "state-mode") await fs.chmod(f.state, 0o755);
      else if (kind === "legacy-mode") await fs.chmod(f.legacy, 0o755);
      else if (kind === "file-symlink") {
        const original = await displace(f, f.file, "journal-original.json");
        await fs.symlink(original, f.file);
      } else if (kind === "root-symlink") {
        const original = await displace(f, f.legacy, "journal-root-original");
        await fs.symlink(original, f.legacy);
      } else if (kind === "file-hardlink") {
        const alias = path.join(f.retained, "journal-hardlink.json");
        await fs.link(f.file, alias);
        console.info("Retained legacy preparation hardlink:", alias);
      } else {
        await preserveBytes(f, f.file, "journal-before-oversize.json");
        await fs.appendFile(
          f.file,
          Buffer.alloc(
            MAX_CHATGPT_TASK_JOURNAL_BYTES + 1 - f.bytes.length,
            0x20,
          ),
        );
      }
      await refusesUnchanged(f, () =>
        selectStartupLegacyPreparation(f.userData, async () => {}),
      );
    });

    it.each(["bytes", "inode", "root", "root-mode"] as const)(
      "verify and retirement refuse a selected original changed at %s",
      async (kind) => {
        const f = await fixture();
        const pin = await select(f);
        const original = await evidence(f.file);
        if (kind === "bytes") {
          await preserveBytes(f, f.file, "journal-before-byte-change.json");
          const changed = Buffer.from(f.bytes);
          changed[changed.length - 1] = 0x20; // Same length, still valid JSON.
          await fs.writeFile(f.file, changed);
          expect((await fs.lstat(f.file)).ino).toBe(original.inode);
        } else if (kind === "inode") {
          await displace(f, f.file, "journal-original.json");
          await privateFile(f.file, f.bytes);
          expect((await fs.lstat(f.file)).ino).not.toBe(original.inode);
        } else if (kind === "root") {
          const previous = await fs.lstat(f.legacy);
          await displace(f, f.legacy, "journal-root-original");
          await privateDirectory(f.legacy);
          await privateFile(f.file, f.bytes);
          expect((await fs.lstat(f.legacy)).ino).not.toBe(previous.ino);
        } else await fs.chmod(f.legacy, 0o755);
        await refusesUnchanged(f, pin.verify);
        await refusesUnchanged(f, () => pin.retireInto(f.archive));
      },
    );

    it.each([1, 3])(
      "propagates a throwing original owner callback during selection gate %s",
      async (failureAt) => {
        const f = await fixture();
        const before = await inventory(f.root);
        const failure = new Error("Controlled current-owner assertion refused");
        let calls = 0;
        await expect(
          selectStartupLegacyPreparation(f.userData, async () => {
            if (++calls === failureAt) throw failure;
          }),
        ).rejects.toBe(failure);
        expect(calls).toBe(failureAt);
        expect(await inventory(f.root)).toEqual(before);
      },
    );

    it("captures the original callback and requires it again for verify", async () => {
      const f = await fixture();
      const before = await inventory(f.root);
      const failure = new Error("Original owner callback now refuses");
      let calls = 0;
      let replacementCalls = 0;
      let refuse = false;
      const input = {
        assertCurrent: async () => {
          calls++;
          if (refuse) throw failure;
        },
      };
      const selecting = selectStartupLegacyPreparation(
        f.userData,
        input.assertCurrent,
      );
      input.assertCurrent = async () => {
        replacementCalls++;
      };
      const pin = await selecting;
      if (pin === null) throw new Error("Expected original callback pin");
      const afterSelection = calls;
      await pin.verify();
      expect(calls).toBeGreaterThan(afterSelection);
      refuse = true;
      await expect(pin.verify()).rejects.toBe(failure);
      expect(replacementCalls).toBe(0);
      expect(await inventory(f.root)).toEqual(before);
    });

    it.each(["missing", "mode", "symlink", "hardlink", "oversize"] as const)(
      "requires an existing safe pending fence: %s",
      async (kind) => {
        const f = await fixture();
        const pin = await select(f);
        if (kind === "missing")
          await displace(f, f.pending, "pending-original");
        else if (kind === "mode") await fs.chmod(f.pending, 0o644);
        else if (kind === "symlink") {
          const original = await displace(f, f.pending, "pending-original");
          await fs.symlink(original, f.pending);
        } else if (kind === "hardlink") {
          const alias = path.join(f.retained, "pending-hardlink");
          await fs.link(f.pending, alias);
          console.info("Retained controlled pending hardlink:", alias);
        } else {
          await preserveBytes(f, f.pending, "pending-before-oversize");
          await fs.appendFile(f.pending, Buffer.alloc(65537, 0x20));
        }
        await refusesUnchanged(f, () => pin.retireInto(f.archive));
        expect(await evidence(f.file)).toMatchObject({ bytes: f.bytes });
      },
    );

    it.each([
      "wrong-name",
      "outside-core",
      "missing",
      "mode",
      "symlink",
    ] as const)(
      "refuses an archive outside the exact existing private scope: %s",
      async (kind) => {
        const f = await fixture();
        const pin = await select(f);
        let archive = f.archive;
        if (kind === "wrong-name" || kind === "outside-core") {
          archive =
            kind === "wrong-name"
              ? path.join(f.core, "not-a-chat-archive")
              : path.join(f.state, path.basename(f.archive));
          await privateDirectory(archive);
        } else if (kind === "missing")
          await displace(f, archive, "archive-original");
        else if (kind === "mode") await fs.chmod(archive, 0o755);
        else {
          const original = await displace(f, archive, "archive-original");
          await fs.symlink(original, archive);
        }
        await refusesUnchanged(f, () => pin.retireInto(archive));
      },
    );

    it("preserves an existing archive target and memoizes the original failure", async () => {
      const f = await fixture();
      const pin = await select(f);
      await privateFile(f.target, Buffer.from("previous retained evidence\n"));
      const before = await inventory(f.root);
      const first = pin.retireInto(f.archive);
      expect(pin.retireInto(f.archive)).toBe(first);
      await expect(first).rejects.toThrow();
      expect(pin.retireInto(f.archive)).toBe(first);
      await expect(pin.retireInto(f.archive + "-changed")).rejects.toThrow(
        "STARTUP_LEGACY_PREPARATION_SELECTION_CHANGED",
      );
      await expect(pin.verify()).rejects.toThrow(
        "STARTUP_LEGACY_PREPARATION_CONSUMED",
      );
      expect(await inventory(f.root)).toEqual(before);
    });

    it.each(["before-move", "after-move"] as const)(
      "retains the pending fence and memoizes a callback failure %s",
      async (where) => {
        const f = await fixture();
        const original = await evidence(f.file);
        const pending = await evidence(f.pending);
        const before = await inventory(f.root);
        const failure = new Error("Controlled owner failure " + where);
        let armed = false;
        let failures = 0;
        const pin = await select(f, async () => {
          if (!armed) return;
          const moved = await absent(f.file);
          if (moved === (where === "after-move")) {
            failures++;
            throw failure;
          }
        });
        armed = true;
        const first = pin.retireInto(f.archive);
        expect(pin.retireInto(f.archive)).toBe(first);
        await expect(first).rejects.toBe(failure);
        const after = await inventory(f.root);
        expect(pin.retireInto(f.archive)).toBe(first);
        await expect(first).rejects.toBe(failure);
        await expect(pin.retireInto(f.archive + "-changed")).rejects.toThrow(
          "STARTUP_LEGACY_PREPARATION_SELECTION_CHANGED",
        );
        await expect(pin.verify()).rejects.toThrow(
          "STARTUP_LEGACY_PREPARATION_CONSUMED",
        );
        expect(failures).toBe(1);
        expect(await inventory(f.root)).toEqual(after);
        expect(await evidence(f.pending)).toEqual(pending);
        if (where === "before-move")
          expect(await inventory(f.root)).toEqual(before);
        else {
          expect(await absent(f.file)).toBe(true);
          expect(await evidence(f.target)).toEqual(original);
          console.info("Retained original after failed retirement:", f.target);
        }
      },
    );

    it.each(["bytes", "inode"] as const)(
      "refuses a pending fence changed during the pre-move owner gate: %s",
      async (kind) => {
        const f = await fixture();
        const original = await evidence(f.file);
        const pending = await evidence(f.pending);
        let armed = false;
        let gates = 0;
        let retained = "";
        const pin = await select(f, async () => {
          if (!armed) return;
          // The contract has two verify gates, then the pre-rename owner gate.
          if (++gates !== 3) return;
          if (kind === "bytes") {
            retained = await preserveBytes(
              f,
              f.pending,
              "pending-before-change",
            );
            await fs.writeFile(
              f.pending,
              Buffer.from("changed opaque fence\n"),
            );
          } else {
            retained = await displace(f, f.pending, "pending-original");
            await privateFile(f.pending, pending.bytes);
          }
        });
        armed = true;
        await expect(pin.retireInto(f.archive)).rejects.toThrow();
        expect(gates).toBe(3);
        expect(retained).not.toBe("");
        expect((await evidence(retained)).bytes).toEqual(pending.bytes);
        if (kind === "inode") expect(await evidence(retained)).toEqual(pending);
        expect(await evidence(f.file)).toEqual(original);
        expect(await fs.readdir(f.archive)).toEqual([]);
        // The changed pending and its original remain; never repair this fixture.
        expect(await absent(f.pending)).toBe(false);
      },
    );

    it("refuses a pending fence changed by the final owner callback after relocation", async () => {
      const f = await fixture();
      const original = await evidence(f.file);
      const pending = await evidence(f.pending);
      let armed = false;
      let changed = false;
      let retained = "";
      const pin = await select(f, async () => {
        if (!armed || changed || !(await absent(f.file))) return;
        retained = await displace(f, f.pending, "pending-at-final-owner-gate");
        await privateFile(f.pending, pending.bytes);
        changed = true;
      });
      armed = true;
      const first = pin.retireInto(f.archive);
      const outcome = await first.then(
        () => "fulfilled",
        () => "rejected",
      );
      expect(changed).toBe(true);
      expect(await evidence(retained)).toEqual(pending);
      expect(await evidence(f.target)).toEqual(original);
      expect(await absent(f.file)).toBe(true);
      expect(await absent(f.pending)).toBe(false);
      console.info(
        "Retained original at final pending-fence refusal:",
        f.target,
      );
      expect(pin.retireInto(f.archive)).toBe(first);
      // Required regression: the supplied contract checks pending before this
      // callback, so static inspection predicts it currently fulfills here.
      // Root owns the source decision; do not weaken this regression.
      expect(outcome).toBe("rejected");
    });
  },
);
