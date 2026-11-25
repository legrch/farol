import { describe, expect, it } from "vitest";
import type { StartupStage } from "../../../src/apps/desktop/primary-startup";
import { runPrimaryStartup, type PrimaryStartupPorts } from "./primary";

// The primary-instance startup over recording owners. The lock answer is a
// value main requests at import time, so a case chooses it; the instance host,
// main's startup, the Go core, the splash, stderr, the dialog and the exit are
// recorders in one ordered log. The refusal predicate, the failure report and
// the notice gate are the real ones. No Electron, filesystem or process runs.

type Options = Readonly<{
  lock?: boolean;
  environment?: "preview" | "dev" | "owner-preview";
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  ready?: boolean;
  proofThrows?: boolean;
  abortThrows?: boolean;
  hasCore?: boolean;
}>;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

function build(options: Options = {}) {
  const log: string[] = [];
  const stderr: string[] = [];
  const startup = deferred();
  const state = { ready: options.ready ?? true };
  let readiness: Promise<void> | undefined;
  const ports: PrimaryStartupPorts = {
    primaryInstanceLock: options.lock ?? true,
    runtimeEnvironment: options.environment ?? "preview",
    process: {
      argv: options.argv ?? ["farol"],
      env: options.env ?? {},
      stderr: {
        write: (text: string) => {
          stderr.push(text);
          log.push(`stderr:${text.trimEnd().split("\n")[0]}`);
          return true;
        },
      } as NodeJS.Process["stderr"],
    },
    app: { exit: (code) => void log.push(`exit:${code}`) },
    dialog: {
      showErrorBox: (title) => void log.push(`dialog:${title}`),
    },
    startupStage: (stage: StartupStage) => void log.push(`stage:${stage}`),
    instance: () => ({
      refuseDevReopen: () => void log.push("refuse-dev-reopen"),
      settleSecondInstance: () => void log.push("settle-second"),
      isPrimaryReady: () => state.ready,
    }),
    initialize: () => {
      log.push("initialize");
      return startup.promise;
    },
    primaryStartup: {
      begin: (promise) => {
        log.push("begin");
        readiness = promise;
        // The real holder observes the rejection so it is never unhandled.
        void promise.catch(() => undefined);
      },
    },
    publishInstallProof: () => {
      log.push("proof");
      if (options.proofThrows) throw new Error("PROOF_FAILED");
    },
    closeStartupSplash: () => void log.push("splash"),
    desktopGoCore: () =>
      options.hasCore === false
        ? null
        : {
            abortStartup: async () => {
              log.push("abort-core");
              if (options.abortThrows) throw new Error("ABORT_FAILED");
            },
          },
  };
  return { ports, log, stderr, startup, state, readiness: () => readiness };
}

describe("primary startup", () => {
  it("records the primary lock first, then runs the startup once", () => {
    const { ports, log } = build();
    runPrimaryStartup(ports);
    expect(log).toEqual(["stage:lock-primary", "initialize", "begin"]);
  });

  it("records the secondary lock and only waits to be acknowledged", async () => {
    const { ports, log, startup } = build({ lock: false });
    runPrimaryStartup(ports);
    startup.resolve();
    await settle();
    expect(log).toEqual(["stage:lock-secondary", "settle-second"]);
  });

  it("refuses a Dev reopen that won the lock without starting anything", async () => {
    const { ports, log, startup } = build({
      environment: "dev",
      argv: ["farol", "--farol-dev-reopen-only"],
    });
    runPrimaryStartup(ports);
    startup.resolve();
    await settle();
    expect(log).toEqual(["stage:lock-primary", "refuse-dev-reopen"]);
  });

  it.each([
    ["a preview launch", { environment: "preview" as const }],
    ["a Dev launch without the reopen flag", { environment: "dev" as const }],
  ])("starts the primary for %s", (_n, extra) => {
    const { ports, log } = build({
      ...extra,
      argv:
        extra.environment === "preview"
          ? ["farol", "--farol-dev-reopen-only"]
          : ["farol"],
    });
    runPrimaryStartup(ports);
    expect(log).toEqual(["stage:lock-primary", "initialize", "begin"]);
  });

  it("lets a secondary Dev reopen wait instead of refusing", () => {
    const { ports, log } = build({
      lock: false,
      environment: "dev",
      argv: ["farol", "--farol-dev-reopen-only"],
    });
    runPrimaryStartup(ports);
    expect(log).toEqual(["stage:lock-secondary", "settle-second"]);
  });

  it("publishes readiness before startup resolves, and fails it when the primary is not ready", async () => {
    const { ports, startup, state, readiness } = build({ ready: false });
    runPrimaryStartup(ports);
    const pending = readiness()!;
    const outcome = pending.then(
      () => "ready",
      (error: Error) => error.message,
    );
    startup.resolve();
    expect(await outcome).toBe("PRIMARY_STARTUP_INCOMPLETE");
    expect(state.ready).toBe(false);
  });

  it("resolves readiness when the primary is ready", async () => {
    const { ports, startup, readiness } = build();
    runPrimaryStartup(ports);
    startup.resolve();
    await expect(readiness()).resolves.toBeUndefined();
  });

  it("proves the install, closes the splash, stages completion, then reports started", async () => {
    const { ports, log, startup } = build();
    runPrimaryStartup(ports);
    startup.resolve();
    await settle();
    expect(log.slice(3)).toEqual([
      "proof",
      "splash",
      "stage:startup-complete",
      "stderr:FAROL_SECOND_INSTANCE_RESULT:primary-started",
    ]);
  });

  it("reports reopen-failed without a proof when the primary is not ready", async () => {
    const { ports, log, startup } = build({ ready: false });
    runPrimaryStartup(ports);
    startup.resolve();
    await settle();
    expect(log.slice(3)).toEqual([
      "splash",
      "stage:startup-complete",
      "stderr:FAROL_SECOND_INSTANCE_RESULT:reopen-failed",
    ]);
  });

  it("reads readiness again when the result is written", async () => {
    const { ports, log, startup, state } = build();
    runPrimaryStartup({
      ...ports,
      publishInstallProof: () => {
        ports.publishInstallProof();
        state.ready = false;
      },
    });
    startup.resolve();
    await settle();
    expect(log.at(-1)).toBe(
      "stderr:FAROL_SECOND_INSTANCE_RESULT:reopen-failed",
    );
  });

  it("says the proof is unconfirmed and carries on when it cannot be written", async () => {
    const { ports, log, startup } = build({ proofThrows: true });
    runPrimaryStartup(ports);
    startup.resolve();
    await settle();
    expect(log.slice(3)).toEqual([
      "proof",
      "stderr:INSTALL_STARTUP_PROOF_UNCONFIRMED",
      "splash",
      "stage:startup-complete",
      "stderr:FAROL_SECOND_INSTANCE_RESULT:primary-started",
    ]);
  });

  it("closes the splash, aborts the core once, reports and exits 1 when startup fails", async () => {
    const { ports, log, stderr, startup } = build({
      env: { FAROL_E2E: "1" },
    });
    runPrimaryStartup(ports);
    startup.reject(new Error("PRIMARY_FAILED"));
    await settle();
    expect(log.slice(3, 4)).toEqual(["splash"]);
    expect(log.slice(4)).toEqual([
      "abort-core",
      "stderr:Farol main-process startup failed before the app became ready (PRIMARY_FAILED). Rebuild the exact candidate, then launch it again.",
      "exit:1",
    ]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("FAROL_STARTUP_FAILURE:PRIMARY_FAILED\n");
    expect(stderr[0]).toContain(
      "FAROL_SECOND_INSTANCE_RESULT:startup-failed\n",
    );
  });

  it("starts nothing on the primary path after a failure and never reports started", async () => {
    const { ports, log, startup } = build({ env: { FAROL_E2E: "1" } });
    runPrimaryStartup(ports);
    startup.reject(new Error("PRIMARY_FAILED"));
    await settle();
    expect(log).not.toContain("proof");
    expect(log).not.toContain("stage:startup-complete");
    expect(log.filter((entry) => entry === "initialize")).toHaveLength(1);
  });

  it("treats a throw after startup resolved as a failed startup", async () => {
    const { ports, log, startup } = build({ env: { FAROL_E2E: "1" } });
    const stage = ports.startupStage;
    runPrimaryStartup({
      ...ports,
      startupStage: (value) => {
        stage(value);
        if (value === "startup-complete") throw new Error("STAGE_FAILED");
      },
    });
    startup.resolve();
    await settle();
    expect(log.slice(-2)).toEqual([
      "stderr:Farol main-process startup failed before the app became ready (STAGE_FAILED). Rebuild the exact candidate, then launch it again.",
      "exit:1",
    ]);
    expect(log).toContain("abort-core");
  });

  it("replaces the error with the cleanup code when the core cannot be aborted", async () => {
    const { ports, stderr, startup } = build({
      abortThrows: true,
      env: { FAROL_E2E: "1" },
    });
    runPrimaryStartup(ports);
    startup.reject(new Error("PRIMARY_FAILED"));
    await settle();
    expect(stderr[0]).toContain(
      "FAROL_STARTUP_FAILURE:GO_CORE_STARTUP_CLEANUP_UNCONFIRMED\n",
    );
    expect(stderr[0]).not.toContain("PRIMARY_FAILED");
  });

  it("exits without a core to abort", async () => {
    const { ports, log, startup } = build({
      hasCore: false,
      env: { FAROL_E2E: "1" },
    });
    runPrimaryStartup(ports);
    startup.reject(new Error("PRIMARY_FAILED"));
    await settle();
    expect(log).not.toContain("abort-core");
    expect(log.at(-1)).toBe("exit:1");
  });

  it("shows a native notice for a recoverable code on an interactive launch only", async () => {
    const interactive = build({ env: {} });
    runPrimaryStartup(interactive.ports);
    interactive.startup.reject(new Error("UPDATE_ADOPTION_NETWORK_FAILURE"));
    await settle();
    expect(
      interactive.log.slice(-3).map((entry) => entry.split(":")[0]),
    ).toEqual(["stderr", "dialog", "exit"]);
    for (const env of [
      { FAROL_E2E: "1" },
      { FAROL_NONINTERACTIVE: "1" },
      { CI: "true" },
    ]) {
      const quiet = build({ env });
      runPrimaryStartup(quiet.ports);
      quiet.startup.reject(new Error("UPDATE_ADOPTION_NETWORK_FAILURE"));
      await settle();
      expect(quiet.log.some((entry) => entry.startsWith("dialog:"))).toBe(
        false,
      );
      expect(quiet.log.at(-1)).toBe("exit:1");
    }
  });

  it("reads the core when startup fails, not when startup began", async () => {
    const { ports, log, startup } = build({ env: { FAROL_E2E: "1" } });
    let core: PrimaryStartupPorts["desktopGoCore"] extends () => infer R
      ? R
      : never = null;
    runPrimaryStartup({ ...ports, desktopGoCore: () => core });
    core = {
      abortStartup: async () => {
        log.push("abort-late-core");
      },
    };
    startup.reject(new Error("PRIMARY_FAILED"));
    await settle();
    expect(log).toContain("abort-late-core");
  });
});
