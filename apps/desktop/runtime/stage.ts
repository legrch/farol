import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  emitStartupStage,
  type StartupStage,
} from "../../../src/apps/desktop/primary-startup";

// The E2E startup stage marker. Every stage token goes to stderr when the E2E
// lane is on; Playwright can attach after early stderr tokens have passed, so
// the fixed token is also persisted in this run's private disposable E2E home.
// The home is trusted only when it is a 0700, current-user, non-symlink
// directory named for the lane directly under the real temp root. Missing
// diagnostic evidence must never change startup behavior, so every failure
// while persisting is swallowed. Main keeps every call site and order.

export type StartupStagePorts = Readonly<{
  // Read at call time, as the original read process.env inside the writer.
  env: Readonly<Record<string, string | undefined>>;
  writeStderr: (line: string) => unknown;
  pid: number;
  uid: () => number | undefined;
  tmpdir: () => string;
  hrtime: () => bigint;
  uuid: () => string;
}>;

export function createStartupStage(
  ports: StartupStagePorts,
): (stage: StartupStage) => void {
  return (stage) => {
    const enabled = ports.env.FAROL_E2E === "1";
    emitStartupStage(stage, enabled, (line) => ports.writeStderr(line));
    if (!enabled) return;
    try {
      const home = ports.env.HOME;
      if (
        !home ||
        !/^farol-e2e-home-[A-Za-z0-9]{6,}$/u.test(path.basename(home))
      )
        return;
      if (realpathSync(path.dirname(home)) !== realpathSync(ports.tmpdir()))
        return;
      const info = lstatSync(home);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        info.uid !== ports.uid()
      )
        return;
      const marker =
        stage === "lock-secondary"
          ? ".farol-secondary-lock-stage"
          : stage === "delay-complete"
            ? ".farol-delay-complete-stage"
            : stage.startsWith("connector-resume") ||
                stage === "connector-resumed"
              ? ".farol-connector-resume-stage"
              : ".farol-startup-stage";
      const target = path.join(home, marker);
      const temporary = `${target}.${ports.pid}.${ports.uuid()}.tmp`;
      const file = openSync(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW |
          fsConstants.O_NONBLOCK,
        0o600,
      );
      try {
        writeSync(
          file,
          stage === "lock-secondary" || stage === "delay-complete"
            ? `${stage}:${ports.hrtime()}\n`
            : `${stage}\n`,
        );
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      try {
        renameSync(temporary, target);
      } catch (error) {
        unlinkSync(temporary);
        throw error;
      }
    } catch {
      // Missing diagnostic evidence must not change startup behavior.
    }
  };
}
