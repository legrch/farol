import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ProductSettingsSchema } from "../../../../pkg/product-settings/contract";
import type { ComputerApprovalRepository } from "../../app/port/computer-approval-repository";
import { ownerSettingsComputerApproval } from "./owner-settings-computer-approval";

// The path is sealed by the desktop in the launch contract, never supplied by
// a connector caller. This reads the one existing owner approval source; it
// does not persist a second approval or grant database.
export class CurrentOwnerComputerApprovals implements ComputerApprovalRepository {
  constructor(
    private readonly source: Readonly<{
      root: string;
      connectorGeneration: number;
    }>,
    private readonly now: () => number,
  ) {}

  async get(computerId: string) {
    const root = await fs.lstat(this.source.root);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      (root.mode & 0o077) !== 0 ||
      (await fs.realpath(this.source.root)) !== this.source.root
    ) {
      throw new Error("COMPUTER_APPROVAL_SOURCE_UNTRUSTED");
    }
    const file = path.join(this.source.root, "config.json");
    const handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.uid !== root.uid ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        before.size <= 0 ||
        before.size > 256 * 1024
      ) {
        throw new Error("COMPUTER_APPROVAL_SOURCE_UNTRUSTED");
      }
      const settings = ProductSettingsSchema.parse(
        JSON.parse(await handle.readFile("utf8")),
      );
      const after = await fs.lstat(file);
      const directory = await fs.lstat(this.source.root);
      if (
        after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.mode !== after.mode ||
        after.nlink !== 1 ||
        root.dev !== directory.dev ||
        root.ino !== directory.ino ||
        root.mode !== directory.mode
      ) {
        throw new Error("COMPUTER_APPROVAL_SOURCE_CHANGED");
      }
      if (
        settings.computer.computerId !== computerId ||
        settings.connectors.secureMcp.generation !==
          this.source.connectorGeneration
      )
        return null;
      return ownerSettingsComputerApproval(settings, this.now());
    } finally {
      await handle.close();
    }
  }
}
