import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DECLARED_NODE_VERSIONS,
  DECLARED_NPM_VERSION,
  DEFAULT_GO_INPUTS_FILE,
  ESCALATION_MESSAGES,
  OWNER_STOP_EXIT_CODE,
  applyDependencyPlan,
  createSignalEscalation,
  describeLaunchResult,
  devGoBuildArguments,
  evaluateDependencies,
  exitCodeForOwnerStop,
  isDeclaredToolchain,
  main,
  planDependencyActions,
  resolveToolchain,
  runDevBuild,
  runOwnerManagedChild,
} from "../../tooling/dev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const signalTrapChild = path.join(
  here,
  "../fixtures/dev-tooling/signal-trap-child.mjs",
);

describe("dev.mjs toolchain selection", () => {
  it("declares exactly the two supported Node versions with the one npm", () => {
    expect(
      isDeclaredToolchain(DECLARED_NODE_VERSIONS[0], DECLARED_NPM_VERSION),
    ).toBe(true);
    expect(
      isDeclaredToolchain(DECLARED_NODE_VERSIONS[1], DECLARED_NPM_VERSION),
    ).toBe(true);
    expect(isDeclaredToolchain("22.19.0", DECLARED_NPM_VERSION)).toBe(false);
    expect(isDeclaredToolchain(DECLARED_NODE_VERSIONS[0], "10.9.3")).toBe(
      false,
    );
  });

  it("keeps the running interpreter when it is already declared", () => {
    const decision = resolveToolchain({
      currentNode: "24.20.0",
      currentNpm: "11.19.0",
      candidates: ["/should/not/be/probed"],
      probe: () => {
        throw new Error("must not probe when already declared");
      },
    });
    expect(decision).toEqual({ status: "current" });
  });

  it("finds a declared pair at the first matching candidate directory", () => {
    const probed = [];
    const decision = resolveToolchain({
      currentNode: "22.19.0",
      currentNpm: "10.9.3",
      candidates: ["/nvm/v22", "/nvm/v24.20.0", "/homebrew/bin"],
      probe: (dir) => {
        probed.push(dir);
        if (dir === "/nvm/v24.20.0") {
          return {
            nodeBin: `${dir}/node`,
            npmBin: `${dir}/npm`,
            nodeVersion: "24.20.0",
            npmVersion: "11.19.0",
          };
        }
        return null;
      },
    });
    expect(decision).toEqual({
      status: "found",
      binDir: "/nvm/v24.20.0",
      nodeBin: "/nvm/v24.20.0/node",
      npmBin: "/nvm/v24.20.0/npm",
    });
    // Stops at the first match; the later candidate is never probed.
    expect(probed).toEqual(["/nvm/v22", "/nvm/v24.20.0"]);
  });

  it("reports missing when nothing declared exists anywhere", () => {
    const decision = resolveToolchain({
      currentNode: "22.19.0",
      currentNpm: "10.9.3",
      candidates: ["/nvm/v22", "/homebrew/bin"],
      probe: () => null,
    });
    expect(decision).toEqual({ status: "missing" });
  });
});

describe("dev.mjs dependency evaluation", () => {
  it("passes when every installed entry matches the lock and nothing required is absent", () => {
    const committedPackages = {
      "": { name: "farol" },
      "node_modules/zod": { version: "4.6.5", integrity: "sha512-abc" },
      "node_modules/@esbuild/aix-ppc64": {
        version: "0.28.2",
        integrity: "sha512-def",
        optional: true,
      },
    };
    const installedPackages = {
      "": {},
      "node_modules/zod": { version: "4.6.5", integrity: "sha512-abc" },
    };
    expect(
      evaluateDependencies({ committedPackages, installedPackages }),
    ).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("flags a version drift between the lock and what is actually installed", () => {
    const result = evaluateDependencies({
      committedPackages: {
        "node_modules/zod": { version: "4.6.5", integrity: "sha512-abc" },
      },
      installedPackages: {
        "node_modules/zod": { version: "4.5.0", integrity: "sha512-old" },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("node_modules/zod is 4.5.0");
  });

  it("flags a required package the lock names but nothing installed", () => {
    const result = evaluateDependencies({
      committedPackages: {
        "node_modules/zod": { version: "4.6.5" },
      },
      installedPackages: {},
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      "node_modules/zod is in package-lock.json but not installed",
    ]);
  });

  it("does not flag an optional package that this platform legitimately skipped", () => {
    const result = evaluateDependencies({
      committedPackages: {
        "node_modules/@esbuild/aix-ppc64": {
          version: "0.28.2",
          optional: true,
        },
      },
      installedPackages: {},
    });
    expect(result.ok).toBe(true);
  });

  it("flags something installed that the lock does not name at all", () => {
    const result = evaluateDependencies({
      committedPackages: {},
      installedPackages: {
        "node_modules/mystery": { version: "1.0.0" },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain(
      "mystery is installed but not in package-lock.json",
    );
  });
});

describe("dev.mjs dependency plan execution", () => {
  it("runs npm ci when dependencies drifted, and leaves electron alone when it is present", async () => {
    const calls = [];
    const plan = planDependencyActions({
      dependencyState: { ok: false, reasons: ["drift"] },
      electronPresent: true,
    });
    expect(plan.needsInstall).toBe(true);
    expect(plan.needsElectronInstall).toBe(false);
    const status = await applyDependencyPlan(plan, {
      runNpmCi: () => {
        calls.push("npm-ci");
        return 0;
      },
      runElectronInstall: () => {
        calls.push("electron-install");
        return 0;
      },
    });
    expect(status).toBe(0);
    expect(calls).toEqual(["npm-ci"]);
  });

  it("runs electron's own install when only the binary is missing", async () => {
    const calls = [];
    const plan = planDependencyActions({
      dependencyState: { ok: true, reasons: [] },
      electronPresent: false,
    });
    expect(plan.needsInstall).toBe(false);
    expect(plan.needsElectronInstall).toBe(true);
    const status = await applyDependencyPlan(plan, {
      runNpmCi: () => {
        calls.push("npm-ci");
        return 0;
      },
      runElectronInstall: () => {
        calls.push("electron-install");
        return 0;
      },
    });
    expect(status).toBe(0);
    expect(calls).toEqual(["electron-install"]);
  });

  it("runs neither when dependencies already match and electron is present", async () => {
    const calls = [];
    const plan = planDependencyActions({
      dependencyState: { ok: true, reasons: [] },
      electronPresent: true,
    });
    const status = await applyDependencyPlan(plan, {
      runNpmCi: () => {
        calls.push("npm-ci");
        return 0;
      },
      runElectronInstall: () => {
        calls.push("electron-install");
        return 0;
      },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([]);
  });

  it("stops at a failed npm ci and never attempts the electron install", async () => {
    const calls = [];
    const plan = planDependencyActions({
      dependencyState: { ok: false, reasons: ["drift"] },
      electronPresent: false,
    });
    const status = await applyDependencyPlan(plan, {
      runNpmCi: () => {
        calls.push("npm-ci");
        return 1;
      },
      runElectronInstall: () => {
        calls.push("electron-install");
        return 0;
      },
    });
    expect(status).toBe(1);
    expect(calls).toEqual(["npm-ci"]);
  });
});

describe("dev.mjs owner stop / second-instance mapping", () => {
  it("maps an owner stop label to exit code 130, and no stop to null", () => {
    expect(exitCodeForOwnerStop("Ctrl+C")).toBe(OWNER_STOP_EXIT_CODE);
    expect(exitCodeForOwnerStop("SIGTERM")).toBe(OWNER_STOP_EXIT_CODE);
    expect(exitCodeForOwnerStop(null)).toBeNull();
  });

  it("describes a reopened second launch as a success that touched nothing", () => {
    const description = describeLaunchResult("reopened");
    expect(description.exitCode).toBe(0);
    expect(description.message).toMatch(/already running/u);
  });

  it("describes a mismatched second launch as needing the owner to act, exit 1", () => {
    for (const outcome of [
      "identity-mismatch",
      "reopen-failed",
      "unverified",
    ]) {
      const description = describeLaunchResult(outcome);
      expect(description.exitCode).toBe(1);
      expect(description.message).toContain(outcome);
    }
  });

  it("says nothing extra for the ordinary primary-started case", () => {
    expect(describeLaunchResult("primary-started")).toEqual({
      exitCode: null,
      message: null,
    });
  });

  it("classifies a main-process startup failure without calling it another running build", () => {
    const description = describeLaunchResult("startup-failed");
    expect(description.exitCode).toBe(1);
    expect(description.message).toContain("main-process startup failed");
    expect(description.message).toContain("task dev");
    expect(description.message).not.toContain("different build");
  });
});

describe("createSignalEscalation", () => {
  it("steps SIGINT, then SIGTERM, then saturates at SIGKILL", () => {
    const escalation = createSignalEscalation();
    expect(escalation.next()).toBe("SIGINT");
    expect(escalation.next()).toBe("SIGTERM");
    expect(escalation.next()).toBe("SIGKILL");
    expect(escalation.next()).toBe("SIGKILL");
  });
});

async function spawnReadyChild() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [signalTrapChild], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    // The fixture registers its SIGINT/SIGTERM handlers before it writes
    // anything, so the first stdout chunk proves it is ready to be signalled.
    child.stdout.once("data", () => resolve(child));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runOwnerManagedChild signal escalation (real child, fake signal source)", () => {
  it("escalates SIGINT -> SIGTERM -> SIGKILL against a child that ignores the first two", async () => {
    const signals = new EventEmitter();
    const messages = [];
    const child = await spawnReadyChild();

    const resultPromise = runOwnerManagedChild({
      spawnChild: () => child,
      signals,
      log: (line) => messages.push(line),
      relayOutput: false,
    });

    // Three owner Ctrl+C presses, spaced out so the child's own reaction (or,
    // for the third, the lack of one — SIGKILL cannot be caught) has time to
    // land before the next one is sent.
    await wait(100);
    signals.emit("SIGINT");
    await wait(100);
    signals.emit("SIGINT");
    await wait(100);
    signals.emit("SIGINT");

    const result = await resultPromise;

    expect(messages).toEqual([
      ESCALATION_MESSAGES.SIGINT,
      ESCALATION_MESSAGES.SIGTERM,
      ESCALATION_MESSAGES.SIGKILL,
    ]);
    expect(result.stopLabel).toBe("Ctrl+C");
    expect(result.outcome.signal).toBe("SIGKILL");
    expect(exitCodeForOwnerStop(result.stopLabel)).toBe(OWNER_STOP_EXIT_CODE);
  }, 15000);

  it("labels the stop by whichever signal arrived first, SIGTERM included", async () => {
    const signals = new EventEmitter();
    const child = await spawnReadyChild();

    const resultPromise = runOwnerManagedChild({
      spawnChild: () => child,
      signals,
      log: () => {},
      relayOutput: false,
    });

    await wait(100);
    signals.emit("SIGTERM");
    await wait(100);
    signals.emit("SIGINT"); // escalation continues regardless of which signal
    await wait(100);
    signals.emit("SIGINT");

    const result = await resultPromise;
    expect(result.stopLabel).toBe("SIGTERM");
    expect(result.outcome.signal).toBe("SIGKILL");
  }, 15000);

  it("reports no stop label and the ordinary close outcome when nothing interrupted it", async () => {
    const signals = new EventEmitter();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const result = await runOwnerManagedChild({
      spawnChild: () => child,
      signals,
      log: () => {},
      relayOutput: false,
    });
    expect(result.stopLabel).toBeNull();
    expect(result.outcome).toEqual({ status: 0, signal: null });
    expect(exitCodeForOwnerStop(result.stopLabel)).toBeNull();
  }, 15000);
});

describe("dev.mjs main() orchestration with an already-declared toolchain", () => {
  function baseOverrides(extra = {}) {
    const calls = [];
    return {
      overrides: {
        prepareBuild: async () => {},
        currentNode: DECLARED_NODE_VERSIONS[0],
        getCurrentNpmVersion: () => DECLARED_NPM_VERSION,
        candidates: [],
        probe: () => null,
        pinned: true,
        ensureDependencies: async () => {
          calls.push("ensureDependencies");
          return 0;
        },
        runBuild: async () => {
          calls.push("runBuild");
          return 0;
        },
        launch: async () => {
          calls.push("launch");
        },
        log: () => {},
        logError: () => {},
        exit: (code) => {
          calls.push(`exit:${code}`);
        },
        ...extra,
      },
      calls,
    };
  }

  it("builds but does not launch when --check is passed", async () => {
    const { overrides, calls } = baseOverrides();
    await main(["--check"], overrides);
    expect(calls).toEqual(["ensureDependencies", "runBuild"]);
  });

  it("stops the exact prior Dev before dependencies or shared build outputs", async () => {
    const { overrides, calls } = baseOverrides({
      prepareBuild: async ({ replace }) => {
        calls.push(`prepare:${replace}`);
      },
    });
    await main([], overrides);
    expect(calls).toEqual([
      "prepare:true",
      "ensureDependencies",
      "runBuild",
      "launch",
    ]);
  });

  it("does not replace the daily profile for check/review/acceptance", async () => {
    for (const flag of [
      "--check",
      "--fresh-review-profile",
      "--acceptance-profile",
    ]) {
      const { overrides, calls } = baseOverrides({
        prepareBuild: async ({ replace }) => {
          calls.push(`prepare:${replace}`);
          throw Error("DEV_BUILD_LIVE_OUTPUTS_REFUSED");
        },
      });
      await main([flag], overrides);
      expect(calls).toEqual(["prepare:false", "exit:1"]);
    }
  });

  it("forwards ordinary secondary placement without enabling a fixed test viewport", async () => {
    let choice;
    const { overrides } = baseOverrides({
      launch: async (...args) => {
        choice = args;
      },
    });
    await main(["--display=secondary"], overrides);
    expect(choice).toEqual([
      false,
      false,
      undefined,
      {
        builtInDisplayOnly: false,
        allowPrimaryDisplay: false,
        devSecondaryDisplay: true,
      },
    ]);
  });

  it("rejects ambiguous display choices before process lookup or build", async () => {
    const { overrides, calls } = baseOverrides({
      prepareBuild: async () => {
        calls.push("prepare");
      },
    });
    await main(["--display=secondary", "--secondary-display"], overrides);
    expect(calls).toEqual(["exit:1"]);
  });

  it("builds and launches when --check is not passed", async () => {
    const { overrides, calls } = baseOverrides();
    await main([], overrides);
    expect(calls).toEqual(["ensureDependencies", "runBuild", "launch"]);
  });

  it("selects the isolated real profile only for the explicit acceptance launch", async () => {
    const selected = [];
    const { overrides } = baseOverrides({
      launch: async (acceptanceProfile) => {
        selected.push(acceptanceProfile);
      },
    });
    await main(["--acceptance-profile"], overrides);
    await main([], overrides);
    expect(selected).toEqual([true, false]);
  });

  it("keeps the owner Dev profile when placing its window on the secondary display", async () => {
    const selected = [];
    const { overrides } = baseOverrides({
      launch: async (...options) => selected.push(options),
    });
    await main(["--secondary-display"], overrides);
    expect(selected).toEqual([
      [
        false,
        true,
        undefined,
        {
          builtInDisplayOnly: false,
          allowPrimaryDisplay: false,
        },
      ],
    ]);
  });

  it("forwards only explicit owner display choices without changing the Dev profile", async () => {
    const selected = [];
    const { overrides } = baseOverrides({
      launch: async (...options) => selected.push(options),
    });
    await main(
      ["--built-in-display-only", "--allow-primary-display"],
      overrides,
    );
    expect(selected).toEqual([
      [
        false,
        false,
        undefined,
        {
          builtInDisplayOnly: true,
          allowPrimaryDisplay: true,
        },
      ],
    ]);
  });

  it("exits with the dependency status and never builds when dependencies fail", async () => {
    const { overrides, calls } = baseOverrides({
      ensureDependencies: async () => {
        calls.push("ensureDependencies");
        return 3;
      },
    });
    await main([], overrides);
    expect(calls).toEqual(["ensureDependencies", "exit:3"]);
  });

  it("exits with the build status and never launches when the build fails", async () => {
    const { overrides, calls } = baseOverrides({
      runBuild: async () => {
        calls.push("runBuild");
        return 2;
      },
    });
    await main([], overrides);
    expect(calls).toEqual(["ensureDependencies", "runBuild", "exit:2"]);
  });
});

describe("automatic stop of the retained launcher child (no processes)", () => {
  it("escalates on deadlines without another owner keypress and observes close", async () => {
    const signals = new EventEmitter();
    const child = new EventEmitter();
    const sent = [];
    child.kill = (signal) => {
      sent.push(signal);
      if (signal === "SIGKILL") child.emit("close", null, signal);
    };
    const timers = [];
    const cleared = [];
    const result = runOwnerManagedChild({
      spawnChild: () => child,
      signals,
      relayOutput: false,
      log: () => {},
      schedule: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearScheduled: (timer) => cleared.push(timer),
    });
    signals.emit("SIGINT");
    expect(sent).toEqual(["SIGINT"]);
    expect(timers[0].delay).toBe(30000);
    timers[0].callback();
    expect(sent).toEqual(["SIGINT", "SIGTERM"]);
    expect(timers[1].delay).toBe(2000);
    timers[1].callback();
    expect((await result).outcome.signal).toBe("SIGKILL");
    expect(sent).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(cleared).toContain(timers[1]);
  });
});

describe("dev.mjs main() toolchain re-exec / missing", () => {
  it("re-execs under a found declared toolchain instead of running the rest here", async () => {
    const calls = [];
    await main([], {
      currentNode: "22.19.0",
      getCurrentNpmVersion: () => "10.9.3",
      candidates: ["/nvm/v24.20.0"],
      probe: () => ({
        nodeBin: "/nvm/v24.20.0/node",
        npmBin: "/nvm/v24.20.0/npm",
        nodeVersion: "24.20.0",
        npmVersion: "11.19.0",
      }),
      pinned: false,
      reExec: async (target, argv) => {
        calls.push(["reExec", target.binDir, argv]);
      },
      ensureDependencies: async () => {
        calls.push("ensureDependencies");
        return 0;
      },
      runBuild: async () => {
        calls.push("runBuild");
        return 0;
      },
      launch: async () => calls.push("launch"),
      log: () => {},
      logError: () => {},
      exit: (code) => calls.push(`exit:${code}`),
    });
    expect(calls).toEqual([["reExec", "/nvm/v24.20.0", []]]);
  });

  it("exits 1 with one clear message when no declared toolchain exists anywhere", async () => {
    const calls = [];
    const errors = [];
    await main([], {
      currentNode: "22.19.0",
      getCurrentNpmVersion: () => "10.9.3",
      candidates: [],
      probe: () => null,
      pinned: false,
      ensureDependencies: async () => {
        calls.push("ensureDependencies");
        return 0;
      },
      runBuild: async () => {
        calls.push("runBuild");
        return 0;
      },
      launch: async () => calls.push("launch"),
      log: () => {},
      logError: (line) => errors.push(line),
      exit: (code) => calls.push(`exit:${code}`),
    });
    expect(calls).toEqual(["exit:1"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("24.20.0");
    expect(errors[0]).toContain("26.7.0");
    expect(errors[0]).toContain("11.19.0");
  });
});

// CPU-only orchestration: no builder, Electron, provider or real profile runs.
describe("dev opener bounded orchestration", () => {
  const argument = "--go-inputs=/private/tmp/approved-go-inputs.json";
  const marker = "review:8dc34907-9b18-4cbd-9486-9cfde2d05c75";
  function fixture(extra = {}) {
    const calls = [];
    const logs = [];
    const overrides = {
      prepareBuild: async () => {},
      pinned: true,
      currentNode: DECLARED_NODE_VERSIONS[0],
      getCurrentNpmVersion: () => DECLARED_NPM_VERSION,
      ensureDependencies: async () => {
        calls.push("dependencies");
        return 0;
      },
      runBuild: async (args) => {
        calls.push(["build", args]);
        return 0;
      },
      createReviewProfile: () => {
        calls.push("profile");
        return {
          marker,
          appData: "/fixture/review/root",
          userData: "/fixture/review/root/Farol Dev",
        };
      },
      launch: async (...args) => {
        calls.push(["launch", ...args]);
      },
      log: (line) => logs.push(line),
      logError: (line) => logs.push(line),
      exit: (status) => calls.push(["exit", status]),
      ...extra,
    };
    return { calls, logs, overrides };
  }

  it("forwards the one canonical Go input verbatim and provisions only after build", async () => {
    const { calls, logs, overrides } = fixture();
    await main(["--fresh-review-profile", argument], overrides);
    expect(calls).toEqual([
      "dependencies",
      ["build", [argument]],
      "profile",
      [
        "launch",
        false,
        true,
        marker,
        {
          builtInDisplayOnly: false,
          allowPrimaryDisplay: false,
        },
      ],
    ]);
    expect(logs.join("\n")).toContain(marker);
    expect(logs.join("\n")).toContain("/fixture/review/root/Farol Dev");
    expect(logs.join("\n")).toContain("cannot reopen");
  });

  it.each([
    ["--go-inputs"],
    ["--go-inputs="],
    ["--go-inputs=relative.json"],
    ["--go-inputs=/tmp/../tmp/input.json"],
    ["--go-inputs=/tmp/input.json/"],
    ["--go-inputs=/tmp/in\0put"],
    [argument, argument],
    ["--go-inputs-extra=/tmp/input"],
    ["--fresh-review-profile", "--fresh-review-profile"],
    ["--fresh-review-profile=existing"],
    ["--fresh-review-profile", "--acceptance-profile"],
  ])(
    "rejects malformed or conflicting selection before dependencies: %j",
    async (...args) => {
      const { calls, overrides } = fixture();
      await main(args, overrides);
      expect(calls).toEqual([["exit", 1]]);
    },
  );

  it("requires the fixed local Go inputs in ordinary Dev without an extra flag", () => {
    expect(devGoBuildArguments([])).toEqual([
      `--go-inputs=${DEFAULT_GO_INPUTS_FILE}`,
    ]);
    expect(DEFAULT_GO_INPUTS_FILE).toBe(
      path.resolve(here, "../../_output/go-build-inputs.json"),
    );
    expect(devGoBuildArguments(["--check", argument])).toEqual([argument]);
  });

  it("ordinary Dev builds Go and retains its ordinary profile selection", async () => {
    const { calls, overrides } = fixture();
    await main([], overrides);
    expect(calls).toEqual([
      "dependencies",
      ["build", [`--go-inputs=${DEFAULT_GO_INPUTS_FILE}`]],
      [
        "launch",
        false,
        false,
        undefined,
        { builtInDisplayOnly: false, allowPrimaryDisplay: false },
      ],
    ]);
  });

  it.each([null, new Error("ENOENT"), new Error("GO_INPUTS_INVALID")])(
    "refuses missing/invalid inputs before any builder and never falls back: %j",
    async (outcome) => {
      const builds = [];
      const messages = [];
      const status = await runDevBuild(devGoBuildArguments([]), {
        readInputs: async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
        run: async (args) => builds.push(args),
        report: (line) => messages.push(line),
      });
      expect(status).toBe(1);
      expect(builds).toEqual([]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("No desktop was launched");
    },
  );

  it("passes the declaration unchanged to the existing authenticated builder", async () => {
    const args = devGoBuildArguments([]);
    const seen = [];
    const status = await runDevBuild(args, {
      readInputs: async (selected) => {
        seen.push(selected);
        return { schema: "farol-go-build-inputs/1" };
      },
      run: async (selected) => {
        seen.push(selected);
        return 2;
      },
      report: () => {
        throw new Error("UNEXPECTED_REPORT");
      },
    });
    expect(status).toBe(2);
    expect(seen).toEqual([args, args]);
  });

  it("does not mint or launch a review profile for --check", async () => {
    const { calls, overrides } = fixture();
    await main(["--check", "--fresh-review-profile", argument], overrides);
    expect(calls).toEqual(["dependencies", ["build", [argument]]]);
  });

  it("does not provision or launch after the builder refuses dirty Go source", async () => {
    const { calls, overrides } = fixture({ runBuild: async () => 2 });
    await main(["--fresh-review-profile", argument], overrides);
    expect(calls).toEqual(["dependencies", ["exit", 2]]);
  });

  it("does not provision after an unknown builder outcome or try a fallback build", async () => {
    let attempts = 0;
    const unknown = new Error("OUTCOME_UNKNOWN");
    const { calls, overrides } = fixture({
      runBuild: async () => {
        attempts += 1;
        throw unknown;
      },
    });
    await expect(
      main(["--fresh-review-profile", argument], overrides),
    ).rejects.toBe(unknown);
    expect(attempts).toBe(1);
    expect(calls).toEqual(["dependencies"]);
  });

  it("does not provision a fresh profile when dependencies fail", async () => {
    const { calls, overrides } = fixture({ ensureDependencies: async () => 3 });
    await main(["--fresh-review-profile", argument], overrides);
    expect(calls).toEqual([["exit", 3]]);
  });

  it("does not recover or launch after profile collision/refusal", async () => {
    let attempts = 0;
    const { calls, overrides } = fixture({
      createReviewProfile: () => {
        attempts += 1;
        throw new Error("EEXIST");
      },
    });
    await main(["--fresh-review-profile", argument], overrides);
    expect(attempts).toBe(1);
    expect(calls).toEqual(["dependencies", ["build", [argument]], ["exit", 1]]);
  });

  it("does not retry a refused or unknown launch", async () => {
    let attempts = 0;
    const refusal = new Error("OUTCOME_UNKNOWN");
    const { overrides } = fixture({
      launch: async () => {
        attempts += 1;
        throw refusal;
      },
    });
    await expect(
      main(["--fresh-review-profile", argument], overrides),
    ).rejects.toBe(refusal);
    expect(attempts).toBe(1);
  });
});
