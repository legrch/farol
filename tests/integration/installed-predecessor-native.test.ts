import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { captureInstalledPredecessor } from "../../src/apps/desktop/installed-predecessor";
import {
  currentBootTimeMs,
  readProcessStart,
  writeRunMarker,
} from "../../src/apps/desktop/run-marker";

it.each(["graceful", "unclean"])(
  "observes an actual %s disposable predecessor without fabricating its exit",
  async (kind) => {
    const home = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "farol-predecessor-child-"),
    );
    const profile = path.join(
      home,
      "Library/Application Support/Farol Next Preview",
    );
    const state = path.join(profile, "farol-next-state");
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    await fs.chmod(profile, 0o700);
    const selectedHome = vi
      .spyOn(os, "userInfo")
      .mockReturnValue({ ...os.userInfo(), homedir: home });
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      const path = require('node:path');
      const root = process.argv[1];
      process.on('SIGTERM', () => {
        fs.writeFileSync(path.join(root, 'last-quit.json'), JSON.stringify({schema:1,at:new Date().toISOString(),drained:true,unconfirmed:[]}), {mode:0o600});
        fs.unlinkSync(path.join(root, 'running.json'));
        process.exit(0);
      });
      setInterval(() => {}, 1000);
      process.stdout.write('ready\\n');
    `,
        state,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const completion = new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", (data) =>
          data.toString().trim() === "ready"
            ? resolve()
            : reject(new Error("bad fixture readiness")),
        );
        child.once("error", reject);
      });
      const processStart = readProcessStart(child.pid!);
      expect(processStart).not.toBeNull();
      await writeRunMarker(state, {
        pid: child.pid!,
        now: Date.now() - 100,
        bootTime: currentBootTimeMs(),
        processStart,
      });
      const control = await captureInstalledPredecessor();
      expect(control.original.pid).toBe(child.pid);
      await expect(control.observeClosed()).rejects.toThrow("STILL_PRESENT");
      if (kind === "graceful") {
        await control.requestQuit();
        expect(await completion).toEqual({ code: 0, signal: null });
        const proof = await control.observeClosed();
        expect(proof.quitDigest).toMatch(/^[0-9a-f]{64}$/u);
        expect(proof.processStart).toBe(processStart);
        expect(proof).not.toHaveProperty("exitCode");
        await expect(control.requestQuit()).rejects.toThrow(
          "ALREADY_ATTEMPTED",
        );
      } else {
        child.kill("SIGKILL");
        expect(await completion).toEqual({ code: null, signal: "SIGKILL" });
        await expect(control.observeClosed()).rejects.toThrow(
          "RUN_MARKER_PRESENT",
        );
        await expect(control.observeClosed()).rejects.toThrow(
          "CLOSURE_UNCONFIRMED",
        );
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await completion;
      selectedHome.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  },
  10000,
);
