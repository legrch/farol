import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import type {
  ConditionalSettingsWrite,
  ProductSettingsStoreOptions,
} from "./input";

// The durable `config.json` store: the single file the owner's product
// settings live in. It opens with O_NOFOLLOW and O_CLOEXEC, requires a private
// regular file, bounds every read and write by MAXIMUM_BYTES, writes a
// temporary sibling, fsyncs it, renames it over the target and fsyncs the
// directory, and refuses to run beside a legacy `product-settings.json`
// (CONFIG_RENAME_REQUIRED) rather than treating an older preview's settings
// as a fresh install. The conditional write compares the complete existing
// document and, once it has attempted publication, latches a fail-closed
// "outcome unknown" state: a failed rename or readback is never settled by
// re-reading, and every later write through the same store refuses. The store
// owns no policy; the service serializes every mutation around it.

const FILE_NAME = "config.json";
const LEGACY_FILE_NAME = "product-settings.json";
const MAXIMUM_BYTES = 256 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

export type StoreHooks = Readonly<{
  beforeCommit?: () => Promise<void>;
}>;

// A per-write fence, supplied by the caller of one mutation rather than
// installed on the store for its whole life. `beforeWrite` is the LAST
// thing `save` does before the rename that makes the new settings durable,
// so a check placed here is a check on the write itself and not on some
// earlier moment the write is merely expected to follow. Throwing from it
// abandons the write with the target untouched.
export type StoreWriteFence = Readonly<{
  beforeWrite?: () => Promise<void>;
  // Last synchronous check immediately before rename is submitted.
  assertBeforePublication?: () => void;
}>;

export class ProductSettingsStore {
  private conditionalPublicationUnknown = false;

  constructor(
    private readonly options: ProductSettingsStoreOptions,
    private readonly hooks: StoreHooks = {},
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("SETTINGS_STATE_ROOT_NOT_ABSOLUTE");
    }
  }

  fenceConditionalWrites(): void {
    this.conditionalPublicationUnknown = true;
  }

  async load(): Promise<ProductSettings | null> {
    await this.ensureRoot();
    const target = path.join(this.options.root, FILE_NAME);
    let handle;
    try {
      handle = await fs.open(
        target,
        fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("SETTINGS_UNSAFE");
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info);
      if (info.size > MAXIMUM_BYTES) throw new Error("SETTINGS_CORRUPT");
      const parsed = ProductSettingsSchema.safeParse(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
      if (!parsed.success) throw new Error("SETTINGS_CORRUPT");
      return parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("SETTINGS_CORRUPT");
      throw error;
    } finally {
      await handle.close();
    }
  }

  // Recovery consumes only an existing stable private document. It must not
  // create defaults, normalize permissions, migrate, save, or install writers.
  // Physical checks retain descriptor/name identity around one bounded read;
  // they do not establish predecessor retirement or current Go authority.
  async loadExisting(): Promise<ProductSettings | null> {
    const root = this.options.root;
    const uid = process.geteuid?.();
    const qualifyRoot = async () => {
      const info = await fs.lstat(root, { bigint: true });
      if (
        uid === undefined ||
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== BigInt(uid) ||
        (info.mode & 0o7777n) !== 0o700n ||
        (await fs.realpath(root)) !== root
      )
        throw new Error("SETTINGS_UNSAFE");
      return info;
    };
    const beforeRoot = await qualifyRoot();
    const sameRoot = async () => {
      const after = await qualifyRoot();
      if (after.dev !== beforeRoot.dev || after.ino !== beforeRoot.ino)
        throw new Error("SETTINGS_UNSAFE");
    };
    await this.assertConfigName();
    const target = path.join(root, FILE_NAME);
    let handle;
    try {
      handle = await fs.open(
        target,
        fsConstants.O_RDONLY |
          NO_FOLLOW |
          CLOSE_ON_EXEC |
          fsConstants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await sameRoot();
        return null;
      }
      if ((error as NodeJS.ErrnoException).code === "ELOOP")
        throw new Error("SETTINGS_UNSAFE");
      throw error;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.uid !== BigInt(uid!) ||
        before.nlink !== 1n ||
        (before.mode & 0o7777n) !== 0o600n
      )
        throw new Error("SETTINGS_UNSAFE");
      if (before.size > BigInt(MAXIMUM_BYTES))
        throw new Error("SETTINGS_CORRUPT");
      const bytes = Buffer.alloc(MAXIMUM_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat({ bigint: true });
      const named = await fs.lstat(target, { bigint: true });
      const fields = [
        "dev",
        "ino",
        "mode",
        "uid",
        "gid",
        "nlink",
        "size",
        "mtimeNs",
        "ctimeNs",
      ] as const;
      if (
        BigInt(bytesRead) !== before.size ||
        fields.some(
          (field) =>
            before[field] !== after[field] || before[field] !== named[field],
        )
      )
        throw new Error("SETTINGS_UNSAFE");
      await sameRoot();
      await this.assertConfigName();
      const parsed = ProductSettingsSchema.safeParse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, bytesRead),
          ),
        ) as unknown,
      );
      if (!parsed.success) throw new Error("SETTINGS_CORRUPT");
      return parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError)
        throw new Error("SETTINGS_CORRUPT");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async save(
    settings: ProductSettings,
    fence: StoreWriteFence = {},
  ): Promise<void> {
    if (this.conditionalPublicationUnknown)
      throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
    return this.saveOnce(settings, fence);
  }

  // The owning service must serialize this with every other Settings mutation.
  // Compare the complete existing document so unrelated values cannot be lost.
  // This is conditional replacement under that one writer, not a filesystem CAS
  // against arbitrary external writers. It does not decide a delivery transition.
  async saveConditional(
    expected: ProductSettings,
    next: ProductSettings,
    fence: StoreWriteFence = {},
  ): Promise<ConditionalSettingsWrite> {
    if (this.conditionalPublicationUnknown) return { status: "unknown" };
    let attempted = false;
    try {
      const before = ProductSettingsSchema.parse(structuredClone(expected));
      const candidate = ProductSettingsSchema.parse(structuredClone(next));
      if (candidate.revision !== before.revision + 1)
        return { status: "not_written" };
      const serializedBefore = JSON.stringify(before);
      const assertCurrent = async () => {
        if (JSON.stringify(await this.load()) !== serializedBefore)
          throw new Error("SETTINGS_CONDITIONAL_SOURCE_CHANGED");
      };
      await assertCurrent();
      await this.saveOnce(
        candidate,
        {
          beforeWrite: async () => {
            await assertCurrent();
            await fence.beforeWrite?.();
          },
          assertBeforePublication: () => fence.assertBeforePublication?.(),
        },
        () => {
          attempted = true;
        },
      );
      const readBack = await this.load();
      if (JSON.stringify(readBack) !== JSON.stringify(candidate))
        throw new Error("SETTINGS_CONDITIONAL_READ_BACK_FAILED");
      return { status: "committed", settings: readBack! };
    } catch {
      if (!attempted) return { status: "not_written" };
      // Never re-read after the failed publication/readback to infer success.
      // Visible bytes cannot settle an unknown acknowledgement. Even legacy
      // writes through this retained store must now refuse.
      this.conditionalPublicationUnknown = true;
      return { status: "unknown" };
    }
  }

  private async saveOnce(
    settings: ProductSettings,
    fence: StoreWriteFence,
    publicationAttempted?: () => void,
  ): Promise<void> {
    if (this.conditionalPublicationUnknown)
      throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
    const validated = ProductSettingsSchema.parse(settings);
    await this.ensureRoot();
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAXIMUM_BYTES) {
      throw new Error("SETTINGS_TOO_LARGE");
    }
    const target = path.join(this.options.root, FILE_NAME);
    await this.assertReplaceableTarget(target);
    const temporary = path.join(
      this.options.root,
      `.${FILE_NAME}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.hooks.beforeCommit?.();
      await this.assertConfigName();
      // Last before the bytes become durable: a fence that refuses here
      // leaves the target exactly as it was, and the temporary file is
      // removed by the `finally` below.
      await fence.beforeWrite?.();
      if (this.conditionalPublicationUnknown)
        throw new Error("SETTINGS_WRITE_OUTCOME_UNKNOWN");
      fence.assertBeforePublication?.();
      publicationAttempted?.();
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await this.syncRoot();
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.options.root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      throw new Error("SETTINGS_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(this.options.root, 0o700);
    await this.assertConfigName();
  }

  private async assertConfigName(): Promise<void> {
    // Never interpret an older preview's existing config as a fresh install.
    // No dual readers, automatic reset, overwrite or live profile migration.
    try {
      await fs.lstat(path.join(this.options.root, LEGACY_FILE_NAME));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("CONFIG_RENAME_REQUIRED");
  }

  private assertPrivateFile(info: Stats): void {
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("SETTINGS_UNSAFE");
    }
  }

  private async assertReplaceableTarget(target: string): Promise<void> {
    try {
      this.assertPrivateFile(await fs.lstat(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async syncRoot(): Promise<void> {
    const directory = await fs.open(
      this.options.root,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
