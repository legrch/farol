import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  InstalledGoUpdateHelper,
  InstalledUpdateHelperSelection,
} from "../../../src/modules/release/infra/native/installed-update-helper";

const execFileAsync = promisify(execFile);
export const FIXTURE_GO_BUILD_ID = "7".repeat(64);
export const FIXTURE_GO_EXECUTABLE = "/fixture/farol-backend";

export type FixtureGoHelper = InstalledGoUpdateHelper & {
  qualified: number;
};

/**
 * A Go capability whose qualification is observable and never touches disk.
 * `qualify` and `remeasure` share one counter and one result, in call order.
 */
export function fakeGoHelper(
  executable: string | (() => Promise<string>) = FIXTURE_GO_EXECUTABLE,
): FixtureGoHelper {
  const measure = async () => {
    helper.qualified += 1;
    return typeof executable === "string" ? executable : executable();
  };
  const helper: FixtureGoHelper = {
    buildId: FIXTURE_GO_BUILD_ID,
    qualified: 0,
    qualify: measure,
    remeasure: measure,
  };
  return helper;
}

export function goSelection(
  helper: InstalledGoUpdateHelper = fakeGoHelper(),
): InstalledUpdateHelperSelection {
  return { kind: "go", helper };
}

/**
 * Test-only reference executable. The retired Python program remains in the
 * tree as the protocol's behavioural reference, so these disposable fixtures
 * can drive the exact native fd1/fd3-fd6 contract through the Go launcher
 * without a build. It runs only inside a test root and is never selected by the
 * product, which spawns the attested `farol-backend` alone.
 */
export async function referenceGoHelper(
  root: string,
  script = path.join(process.cwd(), "resources/native/update_helper.py"),
): Promise<InstalledUpdateHelperSelection> {
  const executable = path.join(root, "farol-backend");
  await fs.writeFile(
    executable,
    `#!/bin/sh\nexec /usr/bin/python3 -I -S -B ${JSON.stringify(script)}\n`,
    { mode: 0o755 },
  );
  return goSelection(fakeGoHelper(executable));
}

let nativeBuild: Promise<string> | undefined;

/** The compiled Go entry as a launcher capability. */
export async function compiledGoHelper(): Promise<InstalledUpdateHelperSelection> {
  const executable = await nativeGoExecutable();
  return goSelection({
    buildId: FIXTURE_GO_BUILD_ID,
    qualify: async () => executable,
    remeasure: async () => executable,
  });
}

/**
 * The real compiled Go entry (`go build ./cmd/farol`). Gated by callers on
 * FAROL_DESKTOP_GO_HELPER_NATIVE=1 because it compiles the backend.
 */
export function nativeGoExecutable(): Promise<string> {
  // A prebuilt, absolute executable may be supplied instead of compiling one.
  const prebuilt = process.env["FAROL_DESKTOP_GO_HELPER_BIN"];
  if (prebuilt) return Promise.resolve(prebuilt);
  nativeBuild ??= (async () => {
    // One build per process, outside any per-test root a test removes.
    const directory = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "farol-go-helper-build-"),
    );
    process.once("exit", () =>
      rmSync(directory, { recursive: true, force: true }),
    );
    const output = path.join(directory, "farol-backend");
    await execFileAsync(
      "go",
      ["build", "-trimpath", "-o", output, "./cmd/farol"],
      {
        cwd: process.cwd(),
        env: { ...process.env, CGO_ENABLED: "0" },
        maxBuffer: 1024 * 1024,
      },
    );
    return output;
  })();
  return nativeBuild;
}
