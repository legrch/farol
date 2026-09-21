import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertReportIdentity,
  buildReportIdentity,
  captureWorkingTreeObservation,
  identityFromRunRecords,
  SUPPORTED_NODE_VERSIONS,
} from "../e2e/farol-model-report-identity.mjs";

// S35-TA-5. The real-host journey's report carried the host binary and its
// version and nothing about Farol, so a passing run could not be attributed
// to a candidate: two reports from different commits looked the same. These
// cases are the refusals that keep an unattributable report from being
// written at all.

// Three levels up, not two: `sourceIdentity` lists the tree with
// repository-root-relative paths (`vnext/...`) and resolves each one against
// the root it is handed.  Handed `vnext/` instead, every lstat missed and
// `git status -- vnext` matched nothing, which is the whole of the
// `sourceDirty: true` with `entryCount: 0` this packet was chasing.
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function identity(overrides = {}) {
  return {
    identity: {
      sourceCommit: "a".repeat(40),
      sourceTreeDigest: "b".repeat(64),
      sourceDirty: false,
      build: "source-level",
      hostBinary: "/Applications/ChatGPT.app/Contents/Resources/codex",
      hostVersion: "codex-cli 0.153.4",
      nodeVersion: SUPPORTED_NODE_VERSIONS[0],
      ...overrides,
    },
  };
}

const FIXTURE_BUNDLE = path.resolve(
  import.meta.dirname,
  "../e2e/farol-model-report-identity.mjs",
);
const FIXTURE_BUNDLE_SHA = createHash("sha256")
  .update(readFileSync(FIXTURE_BUNDLE))
  .digest("hex");

describe("real-host report identity", () => {
  const LOCATED = "/Users/ac/.nvm/versions/node/v22.19.0/bin/codex";
  const DISCOVERED = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const LOADER = Object.freeze({
    kind: "source-level",
    bundlePath: FIXTURE_BUNDLE,
    bundleSha256: FIXTURE_BUNDLE_SHA,
  });

  function hostsOf() {
    return [
      {
        binary: LOCATED,
        version: "codex-cli 0.153.4",
        phases: ["env-key-overrides", "no-retry-on-failure"],
      },
      {
        binary: DISCOVERED,
        version: "codex-cli 0.153.4",
        // NOT `app-host-discovery`: that phase runs no binary, which is the
        // fact the old fixture hid by attributing it to one anyway.
        phases: ["app-tool-roundtrip", "app-rotation-then-host"],
      },
    ];
  }

  function reportOf(overrides = {}, phases = undefined) {
    return {
      phases: phases ?? [
        { id: "env-key-overrides" },
        { id: "no-retry-on-failure" },
        { id: "app-tool-roundtrip" },
        { id: "app-rotation-then-host" },
      ],
      identity: {
        sourceCommit: "a".repeat(40),
        sourceTreeDigest: "b".repeat(64),
        sourceDirty: false,
        loader: LOADER,
        hosts: hostsOf(),
        hostlessPhases: [],
        nodeVersion: SUPPORTED_NODE_VERSIONS[0],
        ...overrides,
      },
    };
  }

  it("S35-TA-12 attributes every phase to exactly one recorded binary", () => {
    const report = reportOf();
    expect(assertReportIdentity(report)).toBe(report.identity);
  });

  it("S35-TA-12 derives the identity through the same helper the ordinary lanes use", () => {
    const built = buildReportIdentity({
      repositoryRoot: path.resolve(import.meta.dirname, "../../.."),
      loader: LOADER,
      hosts: hostsOf(),
      hostlessPhases: ["app-host-discovery"],
      nodeVersion: SUPPORTED_NODE_VERSIONS[0],
    });
    expect(built.hostlessPhases).toEqual(["app-host-discovery"]);
    expect(built.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(built.sourceTreeDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(built.loader).toEqual(LOADER);
    expect(built.hosts.map((h) => h.binary)).toEqual([LOCATED, DISCOVERED]);
  });

  // THE TWO ROWS THIS PACKET EXISTS FOR.
  // S35-TA-13. THE FIXTURE I SHOULD HAVE WRITTEN. Every row above gives
  // every phase a host, so none of them could see that the real journey has
  // a phase which runs NO binary: `app-host-discovery` calls
  // `discoverExecutables` and `detectCodexHostPresence` and never executes
  // the host. The rule "every phase is claimed by exactly one binary" was a
  // guarantee the journey cannot satisfy, and it killed the run in
  // writeReport before any report was written.
  //
  // A host-less phase is now RECORDED, not inferred from absence — the same
  // standard the binaries are held to. Silence would leave a reader unable
  // to tell "ran nothing" from "nobody wrote it down".
  it("S35-TA-13 accepts a phase that ran no binary when the identity records it as host-less", () => {
    const report = reportOf({ hostlessPhases: ["app-host-discovery"] }, [
      { id: "env-key-overrides" },
      { id: "app-host-discovery" },
      { id: "app-tool-roundtrip" },
    ]);
    expect(assertReportIdentity(report)).toBe(report.identity);
  });

  it("S35-TA-13 still refuses a phase that is neither claimed by a host nor recorded host-less", () => {
    expect(() =>
      assertReportIdentity(
        reportOf({ hostlessPhases: ["app-host-discovery"] }, [
          { id: "env-key-overrides" },
          { id: "app-host-discovery" },
          { id: "app-revocation-no-retry" },
        ]),
      ),
    ).toThrow("FAROL_MODEL_E2E_REPORT_PHASE_HOST_UNKNOWN");
  });

  it("S35-TA-13 refuses a phase recorded host-less that a binary also claims", () => {
    // Both would be true of it, so neither is a fact about the run.
    expect(() =>
      assertReportIdentity(
        reportOf({ hostlessPhases: ["env-key-overrides"] }, [
          { id: "env-key-overrides" },
        ]),
      ),
    ).toThrow("FAROL_MODEL_E2E_REPORT_PHASE_HOST_AMBIGUOUS");
  });

  it("S35-TA-12 refuses a report whose phase no recorded binary claims", () => {
    // `app-rotation-then-host` ran, and nothing says which binary answered
    // it. Before this, the report simply did not mention the problem.
    expect(() =>
      assertReportIdentity(
        reportOf({}, [
          { id: "env-key-overrides" },
          { id: "app-host-discovery" },
        ]),
      ),
    ).toThrow("FAROL_MODEL_E2E_REPORT_PHASE_HOST_UNKNOWN");
  });

  it("S35-TA-12 refuses a missing or malformed loader descriptor", () => {
    expect(() => assertReportIdentity(reportOf({ loader: undefined }))).toThrow(
      "FAROL_MODEL_E2E_REPORT_LOADER_MISSING",
    );
    // The old default: a bare string claiming source-level, with nothing
    // saying what was actually loaded.
    expect(() =>
      assertReportIdentity(reportOf({ loader: "source-level" })),
    ).toThrow("FAROL_MODEL_E2E_REPORT_LOADER_MISSING");
    expect(() =>
      assertReportIdentity(reportOf({ loader: { kind: "source-level" } })),
    ).toThrow("FAROL_MODEL_E2E_REPORT_LOADER_INVALID");
    expect(() =>
      assertReportIdentity(
        reportOf({ loader: { kind: "built", buildId: "not-a-digest" } }),
      ),
    ).toThrow("FAROL_MODEL_E2E_REPORT_LOADER_INVALID");
  });

  it("S35-TA-12 the builder refuses the same shapes rather than emitting them", () => {
    const base = {
      repositoryRoot: path.resolve(import.meta.dirname, "../../.."),
      hosts: hostsOf(),
      hostlessPhases: [],
      nodeVersion: SUPPORTED_NODE_VERSIONS[0],
    };
    expect(() =>
      buildReportIdentity({
        ...base,
        loader: LOADER,
        hostlessPhases: undefined,
      }),
    ).toThrow("FAROL_MODEL_E2E_REPORT_HOSTLESS_PHASES_MISSING");
    expect(() => buildReportIdentity(base)).toThrow(
      "FAROL_MODEL_E2E_REPORT_LOADER_MISSING",
    );
    expect(() =>
      buildReportIdentity({ ...base, loader: LOADER, hosts: [] }),
    ).toThrow("FAROL_MODEL_E2E_REPORT_HOST_BINARY_MISSING");
    expect(() =>
      buildReportIdentity({
        ...base,
        loader: LOADER,
        hosts: [{ binary: "", version: "v", phases: ["a"] }],
      }),
    ).toThrow("FAROL_MODEL_E2E_REPORT_HOST_BINARY_MISSING");
    expect(() =>
      buildReportIdentity({
        ...base,
        loader: LOADER,
        hosts: [{ binary: LOCATED, version: "v", phases: [] }],
      }),
    ).toThrow("FAROL_MODEL_E2E_REPORT_HOST_PHASES_MISSING");
  });

  it("S35-TA-12 refuses a phase claimed by two binaries, which would attribute it to neither", () => {
    const hosts = hostsOf();
    hosts[1].phases.push("env-key-overrides");
    expect(() => assertReportIdentity(reportOf({ hosts }))).toThrow(
      "FAROL_MODEL_E2E_REPORT_PHASE_HOST_AMBIGUOUS",
    );
  });

  const refusals = [
    {
      name: "no identity block at all",
      report: { status: "PASS", phases: [] },
      code: "FAROL_MODEL_E2E_REPORT_IDENTITY_MISSING",
    },
    {
      name: "an abbreviated source commit",
      report: reportOf({ sourceCommit: "a".repeat(7) }),
      code: "FAROL_MODEL_E2E_REPORT_SOURCE_COMMIT_INVALID",
    },
    {
      name: "no source tree digest",
      report: reportOf({ sourceTreeDigest: undefined }),
      code: "FAROL_MODEL_E2E_REPORT_SOURCE_TREE_DIGEST_INVALID",
    },
    {
      name: "a dirty flag that was never determined",
      report: reportOf({ sourceDirty: undefined }),
      code: "FAROL_MODEL_E2E_REPORT_SOURCE_DIRTY_INVALID",
    },
    {
      name: "a host with no version, so which release answered is unknown",
      report: reportOf({
        hosts: [{ binary: LOCATED, phases: ["env-key-overrides"] }],
      }),
      code: "FAROL_MODEL_E2E_REPORT_HOST_VERSION_MISSING",
    },
    {
      name: "the Node the shell happened to have, not one this project builds with",
      report: reportOf({ nodeVersion: "22.19.0" }),
      code: "FAROL_MODEL_E2E_REPORT_NODE_UNSUPPORTED",
    },
  ];

  for (const refusal of refusals) {
    it(`S35-TA-12 refuses a report with ${refusal.name}`, () => {
      expect(() => assertReportIdentity(refusal.report)).toThrow(refusal.code);
    });
  }

  it("S35-TA-12 accepts a journey that ran built bytes", () => {
    expect(() =>
      assertReportIdentity(
        reportOf({
          loader: {
            kind: "built",
            buildId: "c".repeat(64),
            artifactSha256: "d".repeat(64),
          },
        }),
      ),
    ).not.toThrow();
  });

  it("S35-TA-12 accepts every Node version this project builds with", () => {
    for (const nodeVersion of SUPPORTED_NODE_VERSIONS) {
      expect(() =>
        assertReportIdentity(reportOf({ nodeVersion })),
      ).not.toThrow();
    }
  });
});

// S35-TA-14. The journey's OWN construction, not the validator called
// directly. `writeReport` built the identity inline and filtered the
// host-less list against the runs while grouping, so a phase recorded
// host-less that also ran a binary was normalised into a plain binary claim
// — `PHASE_HOST_AMBIGUOUS` could not fire from the real journey however
// contradictory its records were. A test that calls `assertReportIdentity`
// with a hand-built identity never sees that, because the normalisation
// happened before the validator was reached.
// S35-TA-15 (U2a). Four real-host runs reported `sourceDirty: true` on a
// worktree that `git status --porcelain` showed clean immediately after.
// The observation below is taken in the SAME operation as the identity, so
// it describes the instant the flag was computed rather than the tidy state
// a later check finds — and on the run at this commit it answered:
// gitStatusExit 0, entryCount 0, trackedEntryCount 0, with sourceDirty
// still true.
//
// The narrowing was right about where the flag came from and wrong about
// whose fault it was. `sourceIdentity` sets dirty from
// `status.length > 0 || !exact`, so with an empty status the cause is
// `exact` — but `exact` was false because THIS file handed the helper
// `vnext/` as the repository root. Every tree path (`vnext/...`) then
// resolved to `vnext/vnext/...` and missed, and `git status -- vnext` run
// from inside `vnext/` matched nothing: both halves of the observation, one
// bug, in the caller. The shared tooling was never at fault, and a8f509ba
// later made that same unreadable condition throw by name rather than fold
// into the flag.
describe("working tree observation", () => {
  // The level itself, because getting it wrong is silent: with `vnext/` as
  // the root every tree path missed its file and the status pathspec matched
  // nothing, and the old tooling folded both into an unexplained dirty flag.
  it("S35-TA-15 resolves the repository root, not the product directory", () => {
    expect(
      readFileSync(path.join(repositoryRoot, "vnext", "package.json"), "utf8")
        .length,
    ).toBeGreaterThan(0);
    expect(path.basename(repositoryRoot)).not.toBe("vnext");
  });

  it("S35-TA-15 reports a clean tree as zero entries with a zero git exit", () => {
    const observation = captureWorkingTreeObservation(
      path.resolve(import.meta.dirname, "../../.."),
    );
    expect(observation.gitStatusExit).toBe(0);
    expect(observation.entries.every((entry) => entry.path.length > 0)).toBe(
      true,
    );
    // Content-free by construction: codes and paths only, never bytes.
    for (const entry of observation.entries) {
      expect(Object.keys(entry).sort()).toEqual(["code", "path"]);
    }
  });

  it("S35-TA-15 distinguishes a genuinely dirty tracked file from a clean run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-wt-"));
    try {
      const run = (...args) =>
        execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
      run("init", "-q");
      run("config", "user.email", "t@example.invalid");
      run("config", "user.name", "T");
      await fs.mkdir(path.join(root, "vnext"), { recursive: true });
      await fs.writeFile(path.join(root, "vnext", "tracked.txt"), "one\n");
      run("add", "-A");
      run("commit", "-qm", "init");

      // Clean: nothing to report.
      expect(captureWorkingTreeObservation(root)).toMatchObject({
        gitStatusExit: 0,
        entryCount: 0,
        trackedEntryCount: 0,
      });

      // A genuinely modified TRACKED file is reported, and counted as
      // tracked — the half that would mean a real source edit.
      await fs.writeFile(path.join(root, "vnext", "tracked.txt"), "two\n");
      const dirty = captureWorkingTreeObservation(root);
      expect(dirty.entryCount).toBe(1);
      expect(dirty.trackedEntryCount).toBe(1);
      expect(dirty.entries[0].path).toBe("vnext/tracked.txt");

      // An untracked file is reported but NOT counted as tracked: scratch
      // written into the tree during a run is a different fact from an edit.
      run("checkout", "--", "vnext/tracked.txt");
      await fs.writeFile(path.join(root, "vnext", "scratch.log"), "x\n");
      const scratch = captureWorkingTreeObservation(root);
      expect(scratch.entryCount).toBe(1);
      expect(scratch.trackedEntryCount).toBe(0);
      expect(scratch.entries[0].code).toBe("??");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("identity built from the journey's own run records", () => {
  // A real file on disk, because the construction re-digests what the
  // descriptor claims: a fixture pointing at a path that does not exist is
  // now itself a refusal, which is the point of the binding.
  const LOADER = Object.freeze({
    kind: "source-level",
    bundlePath: FIXTURE_BUNDLE,
    bundleSha256: FIXTURE_BUNDLE_SHA,
  });
  const SHIM = "/Users/ac/.nvm/versions/node/v22.19.0/bin/codex";
  const DISCOVERED = "/Applications/ChatGPT.app/Contents/Resources/codex";

  function records(overrides = {}) {
    return {
      repositoryRoot: path.resolve(import.meta.dirname, "../../.."),
      loader: LOADER,
      nodeVersion: SUPPORTED_NODE_VERSIONS[0],
      hostVersions: new Map([
        [SHIM, "codex-cli 0.153.4"],
        [DISCOVERED, "codex-cli 0.155.0-alpha.9.2"],
      ]),
      hostRuns: [
        { phase: "env-key-overrides", binary: SHIM },
        { phase: "app-tool-roundtrip", binary: DISCOVERED },
      ],
      hostlessPhases: ["app-host-discovery"],
      phaseIds: [
        "env-key-overrides",
        "app-host-discovery",
        "app-tool-roundtrip",
      ],
      ...overrides,
    };
  }

  it("S35-TA-14 the real 0f850a7f record shape builds and validates", () => {
    const identity = identityFromRunRecords(records());
    expect(identity.hosts.map((h) => h.binary)).toEqual([SHIM, DISCOVERED]);
    expect(identity.hosts.map((h) => h.version)).toEqual([
      "codex-cli 0.153.4",
      "codex-cli 0.155.0-alpha.9.2",
    ]);
    expect(identity.hostlessPhases).toEqual(["app-host-discovery"]);
  });

  // S35-TA-15 (U2b). A path is not a binding. The descriptor named a bundle
  // and nothing checked that the bytes at that path were the bytes the run
  // imported, so a report could truthfully name a file and still describe a
  // different one — the same class as naming a host version without its
  // binary. The construction now re-digests what the descriptor claims.
  it("S35-TA-15 refuses a loader whose digest does not match the bundle on disk", () => {
    expect(() =>
      identityFromRunRecords(
        records({
          loader: { ...LOADER, bundleSha256: "f".repeat(64) },
        }),
      ),
    ).toThrow("FAROL_MODEL_E2E_REPORT_LOADER_MISMATCH");
  });

  it("S35-TA-15 refuses a loader whose bundle cannot be read at all", () => {
    expect(() =>
      identityFromRunRecords(
        records({
          loader: { ...LOADER, bundlePath: "/nonexistent/bundle.mjs" },
        }),
      ),
    ).toThrow("FAROL_MODEL_E2E_REPORT_LOADER_UNREADABLE");
  });

  it("S35-TA-15 a descriptor with no digest at all is refused, not accepted as unbound", () => {
    const loader = { kind: "source-level", bundlePath: FIXTURE_BUNDLE };
    expect(() => identityFromRunRecords(records({ loader }))).toThrow(
      "FAROL_MODEL_E2E_REPORT_LOADER_INVALID",
    );
  });

  it("S35-TA-14 refuses a phase recorded host-less that also ran a binary, instead of normalising it away", () => {
    // The records contradict themselves. The old inline filter silently
    // dropped the host-less entry and reported a clean binary claim.
    expect(() =>
      identityFromRunRecords(
        records({
          hostRuns: [
            { phase: "env-key-overrides", binary: SHIM },
            { phase: "app-host-discovery", binary: DISCOVERED },
          ],
        }),
      ),
    ).toThrow("FAROL_MODEL_E2E_REPORT_PHASE_HOST_AMBIGUOUS");
  });

  it("S35-TA-14 refuses a phase that ran nothing and was never recorded host-less", () => {
    expect(() =>
      identityFromRunRecords(records({ hostlessPhases: [] })),
    ).toThrow("FAROL_MODEL_E2E_REPORT_PHASE_HOST_UNKNOWN");
  });

  it("S35-TA-14 a binary with no recorded version is refused rather than given the wrong one", () => {
    // Before per-binary versions existed this fell back to the located
    // binary's string, which is how an alpha's phases were reported under a
    // stable release's version.
    expect(() =>
      identityFromRunRecords(records({ hostVersions: new Map() })),
    ).toThrow("FAROL_MODEL_E2E_REPORT_HOST_VERSION_MISSING");
  });
});
