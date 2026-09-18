import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// The same identity with the same intent is a replay, with another intent a
// conflict. "unknown" is a record that exists but cannot be read back, for
// example after a crash inside admission: nothing proves it was not submitted.
export type ProviderTurnAdmission =
  "admitted" | "replayed" | "conflict" | "unknown";

export type ProviderTurnJournal = Readonly<{
  admit(key: string, intentSha256: string): Promise<ProviderTurnAdmission>;
  // Forgets a request this process admitted and that provably never reached
  // ChatGPT, so a repeat of it is admitted again instead of being refused as
  // already submitted. Never called once a submission may have happened.
  release(key: string): Promise<void>;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const RECORD_SCHEMA = 1;
const MAXIMUM_RECORD_BYTES = 256;
// Codex turn identities are unique per user turn, so a record only has to
// outlive any plausible host retry of that turn.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Durable record of every logical initial request the provider admitted.
 * A Codex host that repeats an initial request after a terminal answer, a
 * lost stream or a restart must not start a second ChatGPT conversation run,
 * so the record is created exclusively and made durable before anything is
 * submitted. Records hold digests only, never request text.
 */
export class PrivateProviderTurnJournal implements ProviderTurnJournal {
  private pruned = false;

  constructor(
    private readonly options: Readonly<{ root: string; now?: () => number }>,
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("PROVIDER_TURN_JOURNAL_ROOT_NOT_ABSOLUTE");
    }
  }

  async admit(
    key: string,
    intentSha256: string,
  ): Promise<ProviderTurnAdmission> {
    if (key.length === 0 || !SHA256.test(intentSha256)) {
      throw new Error("PROVIDER_TURN_JOURNAL_INPUT_INVALID");
    }
    await this.ensureRoot();
    await this.pruneOnce();
    const file = path.join(this.options.root, `${sha256(key)}.json`);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        file,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.existing(file, intentSha256);
    }
    try {
      await handle.writeFile(
        JSON.stringify({ schema: RECORD_SCHEMA, intentSha256 }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncRoot();
    return "admitted";
  }

  async release(key: string): Promise<void> {
    if (key.length === 0) {
      throw new Error("PROVIDER_TURN_JOURNAL_INPUT_INVALID");
    }
    try {
      await fs.unlink(path.join(this.options.root, `${sha256(key)}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    await this.syncRoot();
  }

  private async syncRoot(): Promise<void> {
    const directory = await fs.open(this.options.root, fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async existing(
    file: string,
    intentSha256: string,
  ): Promise<ProviderTurnAdmission> {
    try {
      const handle = await fs.open(file, fsConstants.O_RDONLY | NO_FOLLOW);
      let text: string;
      try {
        const { size } = await handle.stat();
        if (size > MAXIMUM_RECORD_BYTES) return "unknown";
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const record = JSON.parse(text) as unknown;
      if (
        typeof record !== "object" ||
        record === null ||
        (record as { schema?: unknown }).schema !== RECORD_SCHEMA ||
        typeof (record as { intentSha256?: unknown }).intentSha256 !== "string"
      ) {
        return "unknown";
      }
      return (record as { intentSha256: string }).intentSha256 === intentSha256
        ? "replayed"
        : "conflict";
    } catch {
      return "unknown";
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const listed = await fs.lstat(this.options.root);
    if (
      !listed.isDirectory() ||
      listed.isSymbolicLink() ||
      listed.uid !== process.getuid?.()
    ) {
      throw new Error("PROVIDER_TURN_JOURNAL_ROOT_UNTRUSTED");
    }
    if ((listed.mode & 0o777) !== 0o700) {
      await fs.chmod(this.options.root, 0o700);
    }
  }

  // Bounded retention: once per journal instance, records older than the
  // retention window are removed.
  private async pruneOnce(): Promise<void> {
    if (this.pruned) return;
    this.pruned = true;
    const cutoff = (this.options.now ?? Date.now)() - RETENTION_MS;
    for (const entry of await fs.readdir(this.options.root)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(entry)) continue;
      const file = path.join(this.options.root, entry);
      try {
        const listed = await fs.lstat(file);
        if (listed.isFile() && listed.mtimeMs < cutoff) await fs.unlink(file);
      } catch {
        // A record that disappears or cannot be measured is left to the next
        // start; pruning never blocks admission.
      }
    }
  }
}
