import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertReportIdentity,
  buildReportIdentity,
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
  it("S35-TA-5 derives this checkout's commit and vnext tree digest through the same helper the ordinary lanes use", () => {
    const built = buildReportIdentity({
      repositoryRoot,
      hostBinary: "/usr/local/bin/codex",
      hostVersion: "codex-cli 0.153.4",
      nodeVersion: SUPPORTED_NODE_VERSIONS[0],
    });
    expect(built.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(built.sourceTreeDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(typeof built.sourceDirty).toBe("boolean");
    // This journey bundles the TypeScript under test and never loads
    // `dist/app`, and says so rather than leaving a reader to assume.
    expect(built.build).toBe("source-level");
    expect(assertReportIdentity({ identity: built })).toBe(built);
  });

  // One row per way a report can fail to say what it exercised.
  const refusals = [
    {
      name: "no identity block at all",
      report: { status: "PASS", phases: [] },
      code: "FAROL_MODEL_E2E_REPORT_IDENTITY_MISSING",
    },
    {
      name: "an identity that is not an object",
      report: { identity: "a".repeat(40) },
      code: "FAROL_MODEL_E2E_REPORT_IDENTITY_MISSING",
    },
    {
      name: "no source commit",
      report: identity({ sourceCommit: undefined }),
      code: "FAROL_MODEL_E2E_REPORT_SOURCE_COMMIT_INVALID",
    },
    {
      name: "an abbreviated source commit",
      report: identity({ sourceCommit: "a".repeat(7) }),
      code: "FAROL_MODEL_E2E_REPORT_SOURCE_COMMIT_INVALID",
    },
    {
      name: "no source tree digest",
      report: identity({ sourceTreeDigest: undefined }),
      code: "FAROL_MODEL_E2E_REPORT_SOURCE_TREE_DIGEST_INVALID",
    },
    {
      name: "a dirty flag that was never determined",
      report: identity({ sourceDirty: undefined }),
      code: "FAROL_MODEL_E2E_REPORT_SOURCE_DIRTY_INVALID",
    },
    {
      name: "a build that is neither source-level nor a real build id",
      report: identity({ build: { buildId: "not-a-digest" } }),
      code: "FAROL_MODEL_E2E_REPORT_BUILD_INVALID",
    },
    {
      name: "no host version, so which codex answered is unknown",
      report: identity({ hostVersion: undefined }),
      code: "FAROL_MODEL_E2E_REPORT_HOST_VERSION_MISSING",
    },
    {
      name: "the Node the shell happened to have, not one this project builds with",
      report: identity({ nodeVersion: "22.19.0" }),
      code: "FAROL_MODEL_E2E_REPORT_NODE_UNSUPPORTED",
    },
  ];

  for (const refusal of refusals) {
    it(`S35-TA-5 refuses a report with ${refusal.name}`, () => {
      expect(() => assertReportIdentity(refusal.report)).toThrow(refusal.code);
    });
  }

  it("S35-TA-5 accepts a journey that ran built bytes, named by its build id", () => {
    expect(() =>
      assertReportIdentity(identity({ build: { buildId: "c".repeat(64) } })),
    ).not.toThrow();
  });

  it("S35-TA-5 accepts every Node version this project builds with", () => {
    for (const nodeVersion of SUPPORTED_NODE_VERSIONS) {
      expect(() =>
        assertReportIdentity(identity({ nodeVersion })),
      ).not.toThrow();
    }
  });
});
