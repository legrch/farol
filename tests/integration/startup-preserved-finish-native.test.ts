// Real disposable macOS filesystem, archive pin and native admission lease.
// Terminal recording and child results are controlled doubles: this does not
// qualify Go recovery, child settlement, Electron, an installed app or authority.
// Each private fixture is retained, including refused final transitions.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EmptyRecoveryChildResult } from "../../apps/desktop/bridge/empty-recovery-child";
import type { ProfileLaunchBinding } from "../../apps/desktop/bridge/profile";
import { recordTerminal } from "../../apps/desktop/bridge/terminal-recorder";
import { closedRecoveryHostMechanics as host } from "../../src/apps/desktop/closed-empty-chat-recovery";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
  type PromotionLeaseHandle,
} from "../../src/apps/desktop/promotion-lease";
import { retainEmptyArchive } from "../../src/apps/desktop/retained-empty-archive";
import { withStartupPromotionLease } from "../../src/apps/desktop/startup-promotion-lease";

vi.mock("../../apps/desktop/bridge/terminal-recorder", () => ({
  recordTerminal: vi.fn(async () => undefined),
}));

const sum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-startup-finish-")),
  );
  console.info("Retained startup final-transition fixture:", root);
  const userData = path.join(root, "Farol Dev");
  const state = path.join(userData, "farol-next-state");
  const core = path.join(state, "go-core");
  const chat = path.join(core, "chat");
  const operationId = randomUUID();
  const archive = path.join(core, `chat-retired-${operationId}`);
  for (const directory of [userData, state, core, chat, archive])
    await fs.mkdir(directory, { mode: 0o700 });
  const running = path.join(state, "running.json");
  const configuration = path.join(state, "config.json");
  const pending = path.join(state, "go-core.empty-recovery.pending");
  for (const [file, bytes] of [
    [running, "unconfirmed original host\n"],
    [configuration, "unchanged fixture settings\n"],
    [pending, "controlled maintenance intent\n"],
  ])
    await fs.writeFile(file!, bytes!, { mode: 0o600, flag: "wx" });
  const run = await host.snapshot(running, 1024);
  const config = await host.snapshot(configuration, 1024);
  const intent = await host.snapshot(pending, 1024);
  const preparedRoots = {
    archive: await host.privateRoot(archive),
    chat: await host.privateRoot(chat),
  };
  const parent = await host.privateRoot(core);
  const profile: ProfileLaunchBinding = {
    profileId: "fixture-profile",
    root: core,
    home: root,
    device: String(parent.dev),
    inode: String(parent.ino),
  };
  const physical = (value: { dev: number; ino: number }) => ({
    Device: value.dev,
    Inode: value.ino,
    OwnerUID: process.geteuid!(),
  });
  const buildId = "b".repeat(64);
  const child: EmptyRecoveryChildResult = {
    publication: {
      Binding: {
        ProfileID: profile.profileId,
        BackendGeneration: "controlled-maintenance-generation",
        BuildID: buildId,
        HostLifetimeID: "controlled-maintenance-host",
        ChildLaunchID: "controlled-maintenance-child",
        ParentRoot: physical(parent),
        ChatRoot: physical(preparedRoots.chat),
      },
      HandoffID: operationId,
      ReceiptDigest: Array<number>(32).fill(17),
    },
    acknowledgement: {
      handoffId: operationId,
      receiptDigest: "11".repeat(32),
      ackDigest: "a".repeat(64),
    },
    terminal: {
      handoffId: operationId,
      receiptDigest: "11".repeat(32),
      ackDigest: "a".repeat(64),
      backendGeneration: "controlled-maintenance-generation",
      hostLifetimeId: "controlled-maintenance-host",
      childLaunchId: "controlled-maintenance-child",
      exitCode: "0",
      signal: "",
      forced: false,
    },
  };
  return {
    userData,
    state,
    archive,
    configuration,
    pending,
    run,
    config,
    intent,
    preparedRoots,
    profile,
    child,
    exact: { operationId, buildId },
  };
}

describe.skipIf(process.platform !== "darwin")(
  "startup final eligibility with the original native lease",
  () => {
    it.each(["healthy", "replacement", "current-host"] as const)(
      "checks the full verifier after archive verification: %s",
      async (outcome) => {
        const f = await fixture();
        let borrowed: PromotionLeaseHandle | undefined;
        const result = await withStartupPromotionLease(
          f.userData,
          f.exact.buildId,
          async (verify, lease) => {
            borrowed = lease;
            const pin = await retainEmptyArchive(f.archive);
            let currentHost = true;
            let injected = false;
            const fullVerifier = vi.fn(async () => {
              if (!(await verify())) return false;
              return currentHost;
            });
            const finish = host.finish({
              ...f,
              lease,
              input: {
                executable: "/controlled/no-go-process-is-started",
                expectedRunSha256: sum(f.run.bytes),
                expectedConfigSha256: sum(f.config.bytes),
                selectionInput: {},
                attest: async () => undefined,
                processesAbsent: () => undefined,
              },
              proof: async () => {
                expect(await verifyPromotionLease(lease)).toBe(true);
              },
              verifyLease: fullVerifier,
              archivePin: {
                include: pin.include,
                verify: async () => {
                  await pin.verify();
                  if (!injected) {
                    injected = true;
                    // This runs after finish's own native-only verification.
                    if (outcome === "replacement")
                      await fs.writeFile(
                        path.join(f.state, "installed-replacement.pending"),
                        "new replacement outcome unknown\n",
                        { mode: 0o600, flag: "wx" },
                      );
                    if (outcome === "current-host") currentHost = false;
                  }
                },
              },
            });
            if (outcome === "healthy") {
              await expect(finish).resolves.toEqual({
                phase: "prepared_for_cold_start",
                archive: f.archive,
                operationId: f.exact.operationId,
              });
              await expect(fs.lstat(f.pending)).rejects.toMatchObject({
                code: "ENOENT",
              });
              await host.unchanged(
                path.join(f.archive, "maintenance-intent.json"),
                f.intent,
              );
            } else {
              await expect(finish).rejects.toThrow(
                outcome === "replacement"
                  ? "STARTUP_INSTALLED_REPLACEMENT_PENDING"
                  : "PROMOTION_LEASE_LOST",
              );
              await host.unchanged(f.pending, f.intent);
              await expect(
                fs.lstat(path.join(f.archive, "maintenance-intent.json")),
              ).rejects.toMatchObject({ code: "ENOENT" });
            }
            expect(fullVerifier).toHaveBeenCalledExactlyOnceWith();
            expect(injected).toBe(true);
            await host.unchanged(f.configuration, f.config);
            await host.unchanged(
              path.join(f.archive, "failed-running.json"),
              f.run,
            );
            expect(await verifyPromotionLease(lease)).toBe(true);
            const competitor = await acquirePromotionLease(
              f.userData,
              "contender",
              "promotion",
            );
            try {
              expect(competitor).toBeNull();
            } finally {
              if (competitor) await releasePromotionLease(competitor);
            }
            expect(vi.mocked(recordTerminal)).toHaveBeenCalledWith(
              "/controlled/no-go-process-is-started",
              f.profile,
              f.child.terminal,
              f.child.acknowledgement,
            );
            return "original-owner-still-held";
          },
        );
        expect(result).toBe("original-owner-still-held");
        expect(borrowed).toBeDefined();
        expect(await verifyPromotionLease(borrowed!)).toBe(false);
        const successor = await acquirePromotionLease(
          f.userData,
          "successor",
          "promotion",
        );
        try {
          expect(successor).not.toBeNull();
        } finally {
          if (successor) await releasePromotionLease(successor);
        }
      },
    );
  },
);
