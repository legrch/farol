import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DECLARED_NODE_VERSIONS,
  DECLARED_NPM_VERSION,
  ESCALATION_MESSAGES,
  OWNER_STOP_EXIT_CODE,
  applyDependencyPlan,
  createSignalEscalation,
  describeLaunchResult,
  evaluateDependencies,
  exitCodeForOwnerStop,
  isDeclaredToolchain,
  main,
  planDependencyActions,
  resolveToolchain,
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
      "": { name: "farol-next-preview" },
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
