import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGitShellJourney } from "../e2e/go-git-shell-journey.ts";

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
