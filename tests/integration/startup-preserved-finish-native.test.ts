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
import {
  selectStartupLegacyPreparation,
  LEGACY_PREPARATION_ARCHIVE_NAME,
} from "../../apps/desktop/recovery/legacy-preparation";

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
  const state = path.join(userData, "farol-state");
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
    it("records only selected legacy custody if connector reconciliation refuses before the move", async () => {
      const f = await fixture();
      await withStartupPromotionLease(
        f.userData,
        f.exact.buildId,
        async (verify, lease) => {
          const legacyRoot = path.join(f.state, "chatgpt-task-journal");
          const legacyFile = path.join(legacyRoot, "chatgpt-task-journal.json");
          await fs.mkdir(legacyRoot, { mode: 0o700 });
          const bytes = Buffer.from(
            JSON.stringify({
              schema: 1,
              operationId: randomUUID(),
              kind: "readonly",
              phase: "prepared",
              createdAt: "2026-10-17T00:00:00.000Z",
              updatedAt: "2026-10-17T00:00:00.000Z",
              result: null,
            }) + "\n",
          );
          await fs.writeFile(legacyFile, bytes, { mode: 0o600, flag: "wx" });
          const original = await host.snapshot(legacyFile, 4096);
          const selected = await selectStartupLegacyPreparation(
            f.userData,
            async () => {
              expect(await verify()).toBe(true);
            },
          );
          expect(selected).not.toBeNull();
          const failure = Error("controlled connector reconciliation refusal");
          await expect(
            host.finish({
              ...f,
              lease,
              verifyLease: verify,
              legacyPreparation: selected!,
              input: {
                executable: "/controlled/no-go-process-is-started",
                expectedRunSha256: sum(f.run.bytes),
                expectedConfigSha256: sum(f.config.bytes),
                processesAbsent: vi.fn(),
                attest: async () => {},
                selectionInput: {},
              },
              proof: async () => {
                expect(await verify()).toBe(true);
              },
              archivePin: await retainEmptyArchive(f.archive),
              reconcileConnector: async () => {
                throw failure;
              },
            }),
          ).rejects.toBe(failure);
          await host.unchanged(f.pending, f.intent);
          await host.unchanged(path.join(f.state, "running.json"), f.run);
          await host.unchanged(f.configuration, f.config);
          await host.unchanged(legacyFile, original);
          await expect(
            fs.lstat(path.join(f.archive, LEGACY_PREPARATION_ARCHIVE_NAME)),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const completion = JSON.parse(
            await fs.readFile(
              path.join(f.archive, "maintenance-completed.json"),
              "utf8",
            ),
          );
          expect(completion).not.toHaveProperty("retainedLegacyPreparation");
          expect(completion.selectedLegacyPreparation).toEqual({
            operationId: selected!.operationId,
            sha256: sum(bytes),
            originalPhase: "prepared",
            legacyDisposition: "selected_for_retirement",
            correspondingGoOutcome: "unobserved",
          });
          expect(await verifyPromotionLease(lease)).toBe(true);
        },
      );
    });
    it.each(
      (["healthy", "replacement", "current-host"] as const).flatMap((outcome) =>
        [false, true].map((legacy) => ({ outcome, legacy })),
      ),
    )(
      "checks full verification after archive verification: $outcome, legacy metadata: $legacy",
      async ({ outcome, legacy }) => {
        const f = await fixture();
        let borrowed: PromotionLeaseHandle | undefined;
        const result = await withStartupPromotionLease(
          f.userData,
          f.exact.buildId,
          async (verify, lease) => {
            borrowed = lease;
            const legacyRoot = path.join(f.state, "chatgpt-task-journal");
            const legacyFile = path.join(
              legacyRoot,
              "chatgpt-task-journal.json",
            );
            const legacyBytes = Buffer.from(
              JSON.stringify({
                schema: 1,
                operationId: randomUUID(),
                kind: "readonly",
                phase: "prepared",
                createdAt: "2026-10-17T00:00:00.000Z",
                updatedAt: "2026-10-17T00:00:00.000Z",
                result: null,
              }) + "\n",
            );
            if (legacy) {
              await fs.mkdir(legacyRoot, { mode: 0o700 });
              await fs.writeFile(legacyFile, legacyBytes, {
                mode: 0o600,
                flag: "wx",
              });
            }
            const originalLegacy = legacy
              ? await host.snapshot(legacyFile, 4096)
              : undefined;
            const legacyPreparation = legacy
              ? await selectStartupLegacyPreparation(f.userData, async () => {
                  expect(await verify()).toBe(true);
                })
              : null;
            if (legacy) expect(legacyPreparation).not.toBeNull();
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
              ...(legacyPreparation === null ? {} : { legacyPreparation }),
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
            if (originalLegacy) {
              await host.unchanged(
                path.join(f.archive, LEGACY_PREPARATION_ARCHIVE_NAME),
                originalLegacy,
              );
              expect(
                await fs.readFile(
                  path.join(f.archive, LEGACY_PREPARATION_ARCHIVE_NAME),
                ),
              ).toEqual(legacyBytes);
              await expect(fs.lstat(legacyFile)).rejects.toMatchObject({
                code: "ENOENT",
              });
              const completion = JSON.parse(
                await fs.readFile(
                  path.join(f.archive, "maintenance-completed.json"),
                  "utf8",
                ),
              );
              expect(completion.selectedLegacyPreparation).toEqual({
                operationId: legacyPreparation!.operationId,
                sha256: sum(legacyBytes),
                originalPhase: "prepared",
                legacyDisposition: "selected_for_retirement",
                correspondingGoOutcome: "unobserved",
              });
            }
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
