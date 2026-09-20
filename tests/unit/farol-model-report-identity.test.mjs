import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertReportIdentity,
  buildReportIdentity,
  identityFromRunRecords,
  SUPPORTED_NODE_VERSIONS,
} from "../e2e/farol-model-report-identity.mjs";

// S35-TA-5. The real-host journey's report carried the host binary and its
// version and nothing about Farol, so a passing run could not be attributed
// to a candidate: two reports from different commits looked the same. These
// cases are the refusals that keep an unattributable report from being
// written at all.

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

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

describe("real-host report identity", () => {
  const LOCATED = "/Users/ac/.nvm/versions/node/v22.19.0/bin/codex";
  const DISCOVERED = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const LOADER = Object.freeze({
    kind: "source-level",
    bundlePath: "/tmp/farol-model-e2e-bundle-x/bundle.mjs",
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
      repositoryRoot: path.resolve(import.meta.dirname, "../.."),
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
      repositoryRoot: path.resolve(import.meta.dirname, "../.."),
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
describe("identity built from the journey's own run records", () => {
  const LOADER = Object.freeze({
    kind: "source-level",
    bundlePath: "/tmp/bundle/bundle.mjs",
  });
  const SHIM = "/Users/ac/.nvm/versions/node/v22.19.0/bin/codex";
  const DISCOVERED = "/Applications/ChatGPT.app/Contents/Resources/codex";

  function records(overrides = {}) {
    return {
      repositoryRoot: path.resolve(import.meta.dirname, "../.."),
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
