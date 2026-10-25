import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { BUILD_ENTRIES } from "../../tooling/build-contract.mjs";
import { GO_CORE_ENTRIES } from "../../tooling/go-core-artifact.mjs";
import {
  DEFAULT_GO_INPUTS_FILE,
  devLaunchProfile,
  main,
} from "../../tooling/dev.mjs";
import { qualifyGoBuild } from "../e2e/qualified-go-build.mjs";

function fixture() {
  const source = {
    dirty: false,
    commit: "a".repeat(40),
    treeDigest: "b".repeat(64),
  };
  const identity = createBuildIdentity({
    version: "0.2.0",
    builtAt: "2026-10-07T17:00:00.000Z",
    sourceCommit: source.commit,
    sourceTreeDigest: source.treeDigest,
    sourceDirty: false,
  });
  const manifest = {
    schema: 4,
    sourceMode: "head-exact",
    dirty: false,
    inputExact: true,
    sourceCommit: source.commit,
    sourceTreeDigest: source.treeDigest,
    buildId: identity.buildId,
    entries: [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort(),
    entrySha256: { retained: "digest" },
    core: { independentlyVerified: true },
  };
  const calls = [];
  const ports = {
    readFile: async (file) =>
      Buffer.from(
        JSON.stringify(
          file.endsWith("build-manifest.json") ? manifest : identity,
        ),
      ),
    verifyInputManifest: async (...args) => calls.push(["inputs", ...args]),
    verifyBuildEntries: async (...args) => calls.push(["entries", ...args]),
    verifyGoCoreArtifact: async (...args) => calls.push(["core", ...args]),
  };
  return { source, identity, manifest, ports, calls };
}

describe("current Go E2E build admission (controlled verifier ports)", () => {
  it("passes the exact input ledger, all Go entries and outer identity to production verifiers", async () => {
    const f = fixture();
    const result = await qualifyGoBuild("/controlled/build", f.source, f.ports);
    expect(result.identity).toEqual(f.identity);
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.calls).toEqual([
      ["inputs", "/controlled/build", f.manifest],
      [
        "entries",
        "/controlled/build",
        f.manifest.entrySha256,
        f.manifest.entries,
      ],
      ["core", "/controlled/build", f.manifest.core, f.identity],
    ]);
  });
  it.each([
    [
      "legacy schema",
      (f) => {
        f.manifest.schema = 3;
      },
    ],
    [
      "dirty source",
      (f) => {
        f.source.dirty = true;
      },
    ],
    [
      "dirty build",
      (f) => {
        f.manifest.dirty = true;
      },
    ],
    [
      "unqualified inputs",
      (f) => {
        f.manifest.inputExact = false;
      },
    ],
    [
      "stale commit",
      (f) => {
        f.manifest.sourceCommit = "c".repeat(40);
      },
    ],
    [
      "stale tree",
      (f) => {
        f.manifest.sourceTreeDigest = "c".repeat(64);
      },
    ],
    [
      "other build",
      (f) => {
        f.manifest.buildId = "c".repeat(64);
      },
    ],
    [
      "missing backend",
      (f) => {
        f.manifest.entries = [...BUILD_ENTRIES];
      },
    ],
    [
      "duplicate backend",
      (f) => {
        f.manifest.entries.push("farol-backend");
        f.manifest.entries.sort();
      },
    ],
    [
      "extra entry",
      (f) => {
        f.manifest.entries.push("unattested.cjs");
        f.manifest.entries.sort();
      },
    ],
  ])("refuses %s before artifact observation", async (_name, change) => {
    const f = fixture();
    change(f);
    await expect(
      qualifyGoBuild("/controlled/build", f.source, f.ports),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it.each([
    "verifyInputManifest",
    "verifyBuildEntries",
    "verifyGoCoreArtifact",
  ])("propagates %s refusal", async (name) => {
    const f = fixture();
    f.ports[name] = async () => {
      throw new Error(`REFUSED:${name}`);
    };
    await expect(
      qualifyGoBuild("/controlled/build", f.source, f.ports),
    ).rejects.toThrow(`REFUSED:${name}`);
  });
});

const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts;
it.each([
  "test:e2e:dev",
  "test:e2e:dev-onboarding-startup",
  "test:e2e:soak",
  "test:e2e:persistence-fault",
])(
  "%s selects the real Go Dev producer without opening a profile",
  async (name) => {
    const stages = scripts[name].split(" && ");
    expect(stages).toHaveLength(2);
    const producer = /^node tooling\/dev\.mjs (.+)$/u.exec(stages[0]);
    expect(producer).not.toBeNull();
    const calls = [];
    await main(producer[1].split(" "), {
      pinned: true,
      getCurrentNpmVersion: () => "11.19.0",
      // Observe lifecycle admission without inspecting or stopping a real Dev.
      prepareBuild: async (options) => calls.push(["prepare", options]),
      ensureDependencies: async () => {
        calls.push(["dependencies"]);
        return 0;
      },
      runBuild: async (args) => {
        calls.push(["build", args]);
        return 0;
      },
      createReviewProfile: () => {
        throw new Error("MUST_NOT_OPEN_PROFILE");
      },
      launch: () => {
        throw new Error("MUST_NOT_LAUNCH");
      },
      exit: (code) => {
        throw new Error(`UNEXPECTED_EXIT:${code}`);
      },
      log: () => {},
      logError: () => {},
    });
    expect(calls).toEqual([
      [
        "prepare",
        {
          buildArguments: [`--go-inputs=${DEFAULT_GO_INPUTS_FILE}`],
          replace: false,
          reuse: false,
          profilePath: devLaunchProfile(false),
        },
      ],
      ["dependencies"],
      ["build", [`--go-inputs=${DEFAULT_GO_INPUTS_FILE}`]],
    ]);
    expect(stages[1]).toMatch(/^node tests\/e2e\//u);
  },
);

it("refuses check-only dependency replacement and Go build when lifecycle admission refuses", async () => {
  const prepareBuild = vi.fn(async () => {
    throw new Error("DEV_BUILD_LIVE_OUTPUTS_REFUSED");
  });
  const mustNotRun = vi.fn(() => {
    throw new Error("MUST_NOT_RUN_AFTER_LIFECYCLE_REFUSAL");
  });
  const exit = vi.fn();
  const logError = vi.fn();
  await main(["--check"], {
    pinned: true,
    getCurrentNpmVersion: () => "11.19.0",
    prepareBuild,
    ensureDependencies: mustNotRun,
    runBuild: mustNotRun,
    createReviewProfile: mustNotRun,
    launch: mustNotRun,
    exit,
    log: () => {},
    logError,
  });
  expect(prepareBuild.mock.calls).toEqual([
    [
      {
        buildArguments: [`--go-inputs=${DEFAULT_GO_INPUTS_FILE}`],
        replace: false,
        reuse: false,
        profilePath: devLaunchProfile(false),
      },
    ],
  ]);
  expect(logError.mock.calls).toEqual([["DEV_BUILD_LIVE_OUTPUTS_REFUSED"]]);
  expect(exit.mock.calls).toEqual([[1]]);
  expect(mustNotRun).not.toHaveBeenCalled();
});
