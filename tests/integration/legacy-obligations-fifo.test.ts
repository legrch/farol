// Real private FIFO and a bounded read-only Node child, not Electron or Go.
// A regression's exact child is reaped by spawnSync's timeout/SIGTERM; no app,
// profile, pending operation or provider is started or retried. Retain fixtures.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform === "win32")(
  "unsafe legacy record observation",
  () => {
    it.each([
      ["live-tasks/live-tasks.json", "live-tasks:UNSAFE"],
      [
        "chatgpt-task-journal/chatgpt-task-journal.json",
        "chatgpt-task-journal:UNSAFE",
      ],
      ["config.json", "product-settings:UNSAFE"],
      ["last-quit.json", "last-quit:UNSAFE"],
      ["running.json", "running:UNSAFE"],
    ])(
      "refuses %s without waiting for a FIFO writer",
      async (relative, refusal) => {
        const root = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), "farol-legacy-fifo-")),
        );
        console.info("Retained unsafe legacy record fixture:", root);
        const userData = path.join(root, "Farol Dev");
        const state = path.join(userData, "farol-next-state");
        const file = path.join(state, relative!);
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const created = spawnSync("/usr/bin/mkfifo", ["-m", "600", file], {
          encoding: "utf8",
          timeout: 3000,
          env: { PATH: "/usr/bin:/bin" },
        });
        expect(created.error).toBeUndefined();
        expect(created.status).toBe(0);
        const before = await fs.lstat(file, { bigint: true });
        expect(before.isFIFO()).toBe(true);
        const module = pathToFileURL(
          path.resolve("src/apps/desktop/legacy-activation-obligations.ts"),
        ).href;
        const code = `import { activationObligations } from ${JSON.stringify(module)};\nprocess.stdout.write(JSON.stringify(await activationObligations(${JSON.stringify(userData)})));`;
        const result = spawnSync(
          process.execPath,
          ["--input-type=module", "-e", code],
          {
            encoding: "utf8",
            timeout: 3000,
            maxBuffer: 4096,
            env: { PATH: "/usr/bin:/bin" },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.unreadable).toContain(refusal);
        expect(report.drained).toBe(false);
        const after = await fs.lstat(file, { bigint: true });
        expect([
          after.dev,
          after.ino,
          after.mode,
          after.uid,
          after.nlink,
        ]).toEqual([
          before.dev,
          before.ino,
          before.mode,
          before.uid,
          before.nlink,
        ]);
        expect(after.isFIFO()).toBe(true);
      },
    );
  },
);
