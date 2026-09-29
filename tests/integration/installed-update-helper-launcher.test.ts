import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startInstalledUpdateHelper,
  type InstalledUpdateRequest,
} from "../../src/modules/release/infra/native/installed-update-helper.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

const source = {
  digest: "1".repeat(64),
  version: "0.1.0",
  buildId: "2".repeat(64),
};
const target = {
  digest: "3".repeat(64),
  version: "0.1.1",
  buildId: "4".repeat(64),
};
const accepted: InstalledUpdateRequest = {
  action: "apply",
  operationId: "a".repeat(32),
  source,
  target,
  drain: {
    status: "reconciled",
    acceptedSource: source.buildId,
    acceptedTarget: target.buildId,
  },
  pid: 987654,
  processStart: "Tue Sep 29 23:00:00 2026",
  waitSeconds: 5,
  relaunch: false,
};

describe("installed update launcher", () => {
  it("rejects a changed helper before spawning it", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "farol-update-launcher-"),
    );
    roots.push(root);
    const helper = path.join(root, "update_helper.py");
    await fs.copyFile(
      path.join(process.cwd(), "resources/native/update_helper.py"),
      helper,
    );
    await fs.appendFile(helper, "\n# changed\n");
    await expect(startInstalledUpdateHelper(helper, accepted)).rejects.toThrow(
      "INSTALLED_UPDATE_HELPER_INVALID",
    );
  });

  it("requires matching accepted build identities and a bounded process wait", async () => {
    await expect(
      startInstalledUpdateHelper("/nonexistent", {
        ...accepted,
        drain: { ...accepted.drain, acceptedTarget: source.buildId },
      }),
    ).rejects.toThrow("INSTALLED_UPDATE_INPUT_INVALID");
    await expect(
      startInstalledUpdateHelper("/nonexistent", {
        ...accepted,
        waitSeconds: 999,
      }),
    ).rejects.toThrow("INSTALLED_UPDATE_INPUT_INVALID");
  });
});
