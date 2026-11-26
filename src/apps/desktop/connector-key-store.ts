import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const FILE_NAME = "control-plane-api-key";
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

type StoreOptions = Readonly<{ root: string }>;
type StoreDependencies = Readonly<{
  beforeCommit?: () => Promise<void>;
}>;

// The failure provably happened before the rename that replaces the key file,
// so the previous key (or its absence) is intact. Anything thrown from the
// rename onward is NOT this class: whether the new key landed is then unknown.
export class ConnectorKeyNotReplacedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), {
      cause,
    });
    this.name = "ConnectorKeyNotReplacedError";
  }
}

// Identity of a key without keeping the key: used to prove that the stored
// file still holds the exact value a completed write put there.
export function connectorKeyDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function credentialError(code: string): never {
  throw new Error(code);
}

function validateCredential(value: string): void {
  if (
    value.length < 20 ||
    value.length > 512 ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 33 || code > 126;
    })
  ) {
    credentialError("CONNECTOR_CREDENTIAL_INVALID");
  }
}

export class PrivateConnectorKeyStore {
  constructor(
    private readonly options: StoreOptions,
    private readonly dependencies: StoreDependencies = {},
  ) {
    if (!path.isAbsolute(options.root) || options.root.includes("\0")) {
      throw new Error("CONNECTOR_CREDENTIAL_ROOT_NOT_ABSOLUTE");
    }
  }

  async status(): Promise<"stored" | "missing"> {
    await this.ensureRoot();
    try {
      this.assertPrivateFile(await fs.lstat(this.filePath()));
      return "stored";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  async store(value: string): Promise<void> {
    let renameStarted = false;
    const temporary = path.join(
      this.options.root,
      `.${FILE_NAME}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      validateCredential(value);
      await this.ensureRoot();
      const target = this.filePath();
      await this.assertReplaceableTarget(target);
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
      await handle.writeFile(value, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.dependencies.beforeCommit?.();
      // From here the target may have been replaced. A rename that throws is
      // still classified unknown rather than assumed to have changed nothing.
      renameStarted = true;
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await this.syncRoot();
    } catch (error) {
      throw renameStarted ? error : new ConnectorKeyNotReplacedError(error);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  // The digest of the stored key, or null when none is stored.
  async digest(): Promise<string | null> {
    await this.ensureRoot();
    try {
      this.assertPrivateFile(await fs.lstat(this.filePath()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return connectorKeyDigest(await fs.readFile(this.filePath(), "utf8"));
  }

  async reference(): Promise<string> {
    if ((await this.status()) !== "stored") {
      credentialError("CONNECTOR_CREDENTIAL_MISSING");
    }
    return `file:${this.filePath()}`;
  }

  async remove(): Promise<void> {
    await this.ensureRoot();
    const target = this.filePath();
    try {
      this.assertPrivateFile(await fs.lstat(target));
      await fs.unlink(target);
      await this.syncRoot();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private filePath(): string {
    return path.join(this.options.root, FILE_NAME);
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
      credentialError("CONNECTOR_CREDENTIAL_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(this.options.root, 0o700);
  }

  private assertPrivateFile(info: Stats): void {
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      credentialError("CONNECTOR_CREDENTIAL_UNSAFE");
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
