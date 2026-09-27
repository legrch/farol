import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  SavedChatJournal,
  SavedChatRecord,
} from "../../app/service/persistent-chatgpt-handoff";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_FILE = 4096;

/** Write-once records make a lost send acknowledgement impossible to replay. */
export class PrivateSavedChatJournal implements SavedChatJournal {
  constructor(
    private readonly root: string,
    private readonly canonicalUrl: (url: string) => string | null,
  ) {}

  async reserve(
    key: string,
    record: SavedChatRecord,
  ): Promise<"new" | "existing"> {
    this.checkKey(key);
    if (
      record.phase !== "reserved" ||
      !SHA256.test(record.requestDigest) ||
      !SHA256.test(record.firstMessageDigest) ||
      !SHA256.test(record.requestedTitleDigest)
    )
      throw new Error("SAVED_CHAT_RECORD_INVALID");
    await this.checkRoot();
    try {
      await this.writeOnce(key, "reserve", record);
      return "new";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return "existing";
    }
  }

  async read(key: string): Promise<SavedChatRecord | null> {
    this.checkKey(key);
    await this.checkRoot();
    const reserve = await this.readPart(key, "reserve");
    if (reserve === null) return null;
    if (
      reserve.phase !== "reserved" ||
      typeof reserve.requestDigest !== "string" ||
      typeof reserve.firstMessageDigest !== "string" ||
      typeof reserve.requestedTitleDigest !== "string" ||
      !SHA256.test(reserve.requestDigest) ||
      !SHA256.test(reserve.firstMessageDigest) ||
      !SHA256.test(reserve.requestedTitleDigest) ||
      Object.keys(reserve).sort().join(",") !==
        "firstMessageDigest,phase,requestDigest,requestedTitleDigest"
    )
      throw new Error("SAVED_CHAT_RECORD_INVALID");
    const base: SavedChatRecord = {
      requestDigest: reserve.requestDigest,
      firstMessageDigest: reserve.firstMessageDigest,
      requestedTitleDigest: reserve.requestedTitleDigest,
      phase: "reserved",
    };
    const [send, candidate, verified, refused] = await Promise.all([
      this.readPart(key, "send"),
      this.readPart(key, "candidate"),
      this.readPart(key, "verified"),
      this.readPart(key, "refused"),
    ]);
    if (refused !== null) {
      if (send || candidate || verified || typeof refused.code !== "string")
        throw new Error("SAVED_CHAT_RECORD_CONFLICT");
      return { ...base, phase: "refused", refusalCode: refused.code };
    }
    if (verified !== null && candidate === null)
      throw new Error("SAVED_CHAT_RECORD_CONFLICT");
    if (candidate !== null && send === null)
      throw new Error("SAVED_CHAT_RECORD_CONFLICT");
    if (candidate !== null) {
      if (
        typeof candidate.url !== "string" ||
        this.canonicalUrl(candidate.url) !== candidate.url ||
        (verified !== null && typeof verified.titleVerified !== "boolean")
      )
        throw new Error("SAVED_CHAT_RECORD_INVALID");
      return {
        ...base,
        phase: verified === null ? "candidate" : "verified",
        conversationUrl: candidate.url,
        ...(verified === null
          ? {}
          : { titleVerified: verified.titleVerified as boolean }),
      };
    }
    return { ...base, phase: send === null ? "reserved" : "send_intent" };
  }

  async markSendIntent(key: string, requestDigest: string): Promise<boolean> {
    const record = await this.read(key);
    if (record?.requestDigest !== requestDigest || record.phase !== "reserved")
      return false;
    try {
      await this.writeOnce(key, "send", { intent: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async recordCandidate(
    key: string,
    requestDigest: string,
    url: string,
  ): Promise<boolean> {
    const record = await this.read(key);
    if (
      record?.requestDigest !== requestDigest ||
      record.phase !== "send_intent" ||
      this.canonicalUrl(url) !== url
    )
      return false;
    try {
      await this.writeOnce(key, "candidate", { url });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async recordVerified(
    key: string,
    requestDigest: string,
    titleVerified: boolean,
  ): Promise<boolean> {
    const record = await this.read(key);
    if (
      record?.requestDigest !== requestDigest ||
      record.phase !== "candidate" ||
      typeof titleVerified !== "boolean"
    )
      return false;
    try {
      await this.writeOnce(key, "verified", { titleVerified });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async recordRefused(
    key: string,
    requestDigest: string,
    code: string,
  ): Promise<boolean> {
    const record = await this.read(key);
    if (
      record?.requestDigest !== requestDigest ||
      record.phase !== "reserved" ||
      !/^SAVED_CHAT_[A-Z_]{1,80}$/u.test(code)
    )
      return false;
    try {
      await this.writeOnce(key, "refused", { code });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  private checkKey(key: string): void {
    if (!UUID.test(key)) throw new Error("SAVED_CHAT_KEY_INVALID");
  }

  private async checkRoot(): Promise<void> {
    const stat = await fs.lstat(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      (await fs.realpath(this.root)) !== path.resolve(this.root)
    )
      throw new Error("SAVED_CHAT_ROOT_UNTRUSTED");
  }

  private file(key: string, part: string): string {
    return path.join(this.root, `${key}.${part}.json`);
  }

  private async readPart(
    key: string,
    part: string,
  ): Promise<Record<string, unknown> | null> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        this.file(key, part),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_FILE ||
        stat.size === 0
      )
        throw new Error("SAVED_CHAT_FILE_UNTRUSTED");
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("SAVED_CHAT_RECORD_INVALID");
      return value as Record<string, unknown>;
    } finally {
      await handle.close();
    }
  }

  private async writeOnce(
    key: string,
    part: string,
    value: unknown,
  ): Promise<void> {
    await this.checkRoot();
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_FILE)
      throw new Error("SAVED_CHAT_RECORD_TOO_LARGE");
    const handle = await fs.open(
      this.file(key, part),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await fs.open(
      this.root,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
