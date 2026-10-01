import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { devLaunchEnvironment, launchPreview } from "../../tooling/dev.mjs";

// `task run` builds its child's environment from a fixed allowlist and
// inherits nothing. `task dev` used to spawn Electron with no `env` option
// at all, so the caller's whole environment reached the product — measured
// by spawning a child through each launcher's own shape and asking it what
// it could see. The development one saw `FAROL_NEXT_E2E`,
// `FAROL_NEXT_E2E_WORKSPACE_ROOT` and `FAROL_MODEL_E2E_SYNTHETIC_REPLY`;
// the packaged one saw nothing.
//
// Those variables are not diagnostics. Behind `FAROL_NEXT_E2E=1` they
// replace the file and directory pickers with paths from the environment,
// answer model turns with a fabricated reply, fail live-task commits, drop
// guarded-edit replies, and widen the ChatGPT egress allowlist to a
// loopback origin. An ordinary development launch must not be able to
// inherit any of them from a shell that once ran a lane.
//
// The sealed E2E lanes do not go through this entrypoint: every lane
// launches Electron with Playwright's `electron.launch({ env })` and its
// own explicit environment, so they still set exactly what they mean to.

const SENTINEL = "FAROL_NEXT_E2E_SENTINEL";

/** What a child process can see of the E2E seam family. */
const PROBE = `process.stdout.write(JSON.stringify(Object.keys(process.env).filter((key) => key.startsWith("FAROL_")).sort()))`;

const restore = [];

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

function poison(values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    restore.push(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

/** Spawn a probe child and report the `FAROL_*` keys it could read. */
function farolKeysVisibleTo(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", PROBE], {
      ...options,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(JSON.parse(out)));
  });
}

describe("development launcher environment", () => {
  it("passes a fixed allowlist and inherits no seam variable", () => {
    poison({ [SENTINEL]: "1" });

    const sealed = devLaunchEnvironment(
      {
        HOME: "/Users/owner",
        LANG: "pt_PT.UTF-8",
        LC_ALL: "C",
        TMPDIR: "/private/tmp/owner/",
        PATH: "/tmp/poisoned-bin",
        FAROL_NEXT_E2E: "1",
        FAROL_NEXT_PROFILE_MODE: "arbitrary-profile",
        FAROL_NEXT_ACCEPTANCE_PROFILE: "1",
        FAROL_NEXT_E2E_APP_DATA: "/private/tmp/inherited-app-data",
        FAROL_NEXT_E2E_WORKSPACE_ROOT: "/private/tmp/inherited-root",
        FAROL_NEXT_E2E_CHATGPT_URL: "http://127.0.0.1:43123/chatgpt",
        FAROL_MODEL_E2E_SYNTHETIC_REPLY: "a fabricated answer",
        [SENTINEL]: "1",
        DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
      },
      "/declared/node/bin",
    );

    expect(sealed).toEqual({
      HOME: "/Users/owner",
      LANG: "pt_PT.UTF-8",
      LC_ALL: "C",
      TMPDIR: "/private/tmp/owner/",
      // The declared toolchain first, because the Electron entry is a
      // `#!/usr/bin/env node` shim, then the system directories the
      // packaged launcher pins. Never the caller's own PATH.
      PATH: "/declared/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      FAROL_NEXT_ENVIRONMENT: "dev",
    });
  });

  it("allows an explicit real acceptance profile without E2E seams", () => {
    const environment = devLaunchEnvironment(
      {
        HOME: "/Users/owner",
        FAROL_NEXT_ACCEPTANCE_PROFILE: "1",
        FAROL_NEXT_PROFILE_MODE: "shared-new",
        FAROL_NEXT_E2E: "1",
      },
      "/declared/node/bin",
      true,
    );
    expect(environment.FAROL_NEXT_ACCEPTANCE_PROFILE).toBe("1");
    expect(environment.FAROL_NEXT_PROFILE_MODE).toBeUndefined();
    expect(environment.FAROL_NEXT_E2E).toBeUndefined();
  });

  it("hides a sentinel from a real child that the inherited shape reveals", async () => {
    poison({
      [SENTINEL]: "1",
      FAROL_NEXT_E2E: "1",
      FAROL_NEXT_E2E_APP_DATA: "/private/tmp/inherited-app-data",
      FAROL_MODEL_E2E_SYNTHETIC_REPLY: "a fabricated answer",
    });

    // The control proves the sentinel really is set in this process: the
    // old shape — spawn with no `env` — hands all of it to the child.
    const inherited = await farolKeysVisibleTo({});
    expect(inherited).toContain(SENTINEL);
    expect(inherited).toContain("FAROL_MODEL_E2E_SYNTHETIC_REPLY");

    expect(await farolKeysVisibleTo({ env: devLaunchEnvironment() })).toEqual([
      "FAROL_NEXT_ENVIRONMENT",
    ]);
  });

  it("is what the preview launch actually spawns Electron with", async () => {
    poison({ [SENTINEL]: "1", FAROL_NEXT_E2E: "1", LC_ALL: "C" });
    const root = "/tmp/farol-next-dev-root";
    let received;
    const stop = new Error("SPAWN_INTERCEPTED");

    await expect(
      launchPreview(root, (command, args, options) => {
        received = { command, args, options };
        // Stop before the launch protocol runs: this test is about the
        // environment the production call site builds, and nothing here
        // should reach `process.exit`.
        throw stop;
      }),
    ).rejects.toBe(stop);

    expect(received.command).toBe(
      path.join(root, "node_modules/.bin/electron"),
    );
    expect(received.args).toEqual(["_output/build/app/main.cjs"]);
    expect(received.options.cwd).toBe(root);
    // Named before the key set, so removing the option again fails with
    // this sentence rather than a TypeError from reading `undefined`.
    expect(
      received.options.env,
      "the dev launcher must spawn Electron with an explicit environment",
    ).toBeTypeOf("object");
    expect(Object.keys(received.options.env).sort()).toEqual([
      "FAROL_NEXT_ENVIRONMENT",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TMPDIR",
    ]);
    expect(received.options.env[SENTINEL]).toBeUndefined();
    expect(received.options.env.FAROL_NEXT_E2E).toBeUndefined();
    expect(received.options.env.FAROL_NEXT_E2E_APP_DATA).toBeUndefined();
    expect(
      received.options.env.PATH.startsWith(path.dirname(process.execPath)),
    ).toBe(true);
  });

  it("places the acceptance app on the secondary display before showing it", async () => {
    let received;
    const stop = new Error("SPAWN_INTERCEPTED");
    await expect(
      launchPreview(
        "/tmp/farol-next-dev-root",
        (command, args, options) => {
          received = { command, args, options };
          throw stop;
        },
        true,
      ),
    ).rejects.toBe(stop);
    expect(received.args).toEqual([
      "_output/build/app/main.cjs",
      "--preview-window-mode=secondary-visible",
    ]);
    expect(received.options.env.FAROL_NEXT_ACCEPTANCE_PROFILE).toBe("1");
    expect(received.options.env.FAROL_NEXT_PROFILE_MODE).toBeUndefined();
    expect(received.options.env.FAROL_NEXT_E2E).toBeUndefined();
  });

  it("places ordinary Farol Dev on a secondary display", async () => {
    let received;
    const stop = new Error("SPAWN_INTERCEPTED");
    await expect(
      launchPreview(
        "/tmp/farol-next-dev-root",
        (command, args, options) => {
          received = { command, args, options };
          throw stop;
        },
        false,
        true,
      ),
    ).rejects.toBe(stop);
    expect(received.args).toEqual([
      "_output/build/app/main.cjs",
      "--preview-window-mode=secondary-visible",
    ]);
    expect(received.options.env.FAROL_NEXT_ENVIRONMENT).toBe("dev");
    expect(received.options.env.FAROL_NEXT_PROFILE_MODE).toBeUndefined();
    expect(received.options.env.FAROL_NEXT_ACCEPTANCE_PROFILE).toBeUndefined();
  });
});
