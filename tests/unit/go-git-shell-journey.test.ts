import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runGitShellJourney,
  verifyGitWorkspaceScopes,
} from "../e2e/go-git-shell-journey.ts";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration.ts";
import { ownerSettingsComputerApproval } from "../../src/modules/computer/infra/repo/owner-settings-computer-approval.ts";

describe("package Git witness original admission evidence", () => {
  for (const [status, code, state] of [
    [
      "refused",
      "PROCESS_PREPARATION_SCOPE_REFUSED",
      "original-start-refused-never-retry",
    ],
    [
      "outcome_unknown",
      "PROCESS_OUTCOME_UNKNOWN",
      "original-start-unconfirmed-never-retry",
    ],
  ] as const) {
    it(`retains ${status} before throwing and never replays or observes an absent handle`, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-git-witness-contract-"),
      );
      const home = path.join(root, "home");
      const repository = path.join(home, "code", "fixture");
      const writer = path.join(home, "code", "linked");
      await fs.mkdir(path.join(home, ".config/git/hooks"), { recursive: true });
      await fs.mkdir(writer, { recursive: true });
      const report: Record<string, unknown> = {};
      const persisted: Record<string, unknown>[] = [];
      let calls = 0;
      try {
        await expect(
          runGitShellJourney({
            peer: {
              request: async (method, args) => {
                calls++;
                expect(method).toBe("tools/call");
                expect(args.name).toBe("computer_shell_start");
                expect(
                  await fs.readFile(
                    path.join(writer, ".gitattributes"),
                    "utf8",
                  ),
                ).toBe("*.swift diff=swift\n");
                return { isError: true, structuredContent: { status, code } };
              },
              call: async () => {
                throw new Error(
                  "Must not read or retry after admission failure",
                );
              },
            },
            fixture: {
              home,
              writer,
              repository,
              canary: path.join(root, "canary"),
              expected: {},
            },
            workspaceId: "fixture-workspace",
            report,
            checkpoint: async () => {
              persisted.push(structuredClone(report));
            },
          }),
        ).rejects.toThrow();
        expect(calls).toBe(1);
        expect(report.gitShell).toMatchObject({
          state,
          admission: { status, code, isError: true },
        });
        expect(persisted.at(-1)?.gitShell).toEqual(report.gitShell);
      } finally {
        // The injected peer cannot create any native effects; all files are test-owned.
        await fs.rm(root, { recursive: true });
      }
    });
  }
});

// Real disposable Settings persistence; injected listing/publishing, no native command or provider.
it("verifies both admitted scopes against fresh generations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-git-scopes-"));
  try {
    const configuration = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
    );
    await configuration.initialize();
    const ids: string[] = [];
    for (const [label, inode] of [
      ["First", "2"],
      ["Second", "3"],
    ] as const) {
      const added = await configuration.addReadonlyWorkspace({
        root: path.join(root, label),
        label,
        rootIdentity: { device: "1", inode },
      });
      expect(added.ok).toBe(true);
      if (added.snapshot.status !== "ready")
        throw Error("SETTINGS_UNAVAILABLE");
      const id =
        added.snapshot.settings.computer.workspaces.at(-1)!.workspaceId;
      ids.push(id);
      expect((await configuration.updateWorkspaceAccess(id, "write")).ok).toBe(
        true,
      );
    }
    expect(
      (await configuration.updateComputerFilePolicy("approved-roots-v1")).ok,
    ).toBe(true);
    expect((await configuration.updateComputerCommands("workspace")).ok).toBe(
      true,
    );
    const snapshot = () => {
      const value = configuration.snapshot();
      if (value.status !== "ready") throw Error("SETTINGS_UNAVAILABLE");
      return value.settings;
    };
    let published = 0;
    const listings: number[] = [];
    const observations: { ok: boolean; generation: number }[] = [];
    const buildId = "c".repeat(64);
    await verifyGitWorkspaceScopes({
      configuration,
      workspaceIds: ids,
      buildId,
      host: {
        publishCurrent: async () => {
          published = snapshot().computer.generation;
        },
        listSettingsWorkspace: async (generation, id) => {
          expect(generation).toBe(published);
          expect(generation).toBe(snapshot().computer.generation);
          expect(ids).toContain(id);
          listings.push(generation);
        },
      },
      observe: async (value) => {
        observations.push(value);
      },
    });
    expect(listings).toHaveLength(2);
    expect(listings[1]).toBe(listings[0]! + 1);
    expect(observations.every((value) => value.ok)).toBe(true);
    expect(published).toBe(snapshot().computer.generation);
    expect(
      ownerSettingsComputerApproval(snapshot(), 0).workspaces.map(
        (w) => w.shellVerified,
      ),
    ).toEqual([true, true]);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
