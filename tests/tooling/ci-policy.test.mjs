import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { docsOnly } from "../../tooling/ci-paths.mjs";
import {
  verifyVersion,
  verifyReleaseTag,
} from "../../tooling/verify-release-tag.mjs";
import { verifyReleaseAssets } from "../../tooling/verify-release-assets.mjs";
import {
  cloudDeferredFiles,
  cloudMixedFiles,
} from "../../tooling/cloud-test-prerequisites.mjs";
import { discoverTests } from "../../tooling/test-scopes.mjs";
import { planTests } from "../../tooling/test-scope-plan.mjs";

const owned = [];
afterEach(() => {
  for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true });
});
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const head = "a".repeat(40);

function assets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farol-ci-assets-"));
  owned.push(root);
  // Synthetic bytes only: this tests the public handoff, not a real app/package.
  const bytes = Buffer.from("offline fake archive\n");
  const archiveName = `Farol-${version}-darwin-arm64.zip`;
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schema: "farol.github-release/1",
    repository: "legrch/farol",
    version,
    sourceCommit: head,
    sourceDirty: false,
    platform: "darwin",
    arch: "arm64",
    signing: "unsigned",
    notarized: false,
    archiveName,
    archiveSize: bytes.length,
    archiveSha256,
  };
  fs.writeFileSync(path.join(root, archiveName), bytes);
  fs.writeFileSync(
    path.join(root, "farol-release.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(root, "SHA256SUMS"),
    `${archiveSha256}  ${archiveName}\n`,
  );
  return { root, manifest, archiveName };
}

describe("CI safety and selection", () => {
  it("skips heavy jobs only for the explicit documentation allowlist", () => {
    expect(docsOnly(["README.md", "docs/development/ci.md"])).toBe(true);
    for (const paths of [
      [],
      ["src/a.ts"],
      ["docs/tools/check.py"],
      ["docs/file.json"],
      ["docs/development/ci.md", ".github/workflows/release.yml"],
      ["AGENTS.md"],
      ["docs/AGENTS.md"],
    ])
      expect(docsOnly(paths)).toBe(false);
  });
  it("covers all Cloud-deferred files and whole mixed files on one native scope", () => {
    const plan = planTests("native", discoverTests());
    const selected = plan.suites.flatMap((suite) => suite.files);
    expect(selected.sort()).toEqual(
      [...cloudDeferredFiles, ...cloudMixedFiles]
        .map((entry) => entry.file)
        .sort(),
    );
    expect(new Set(selected).size).toBe(selected.length);
    for (const suite of plan.suites) {
      expect(suite.runner).toBe("vitest");
      expect(suite.testNamePattern).toBeUndefined();
      expect(suite.workers).toBe(2);
    }
  });
  it.each(["v1.2.3", "v0.2.7-rc.1"])(
    "matches an exact version source: %s",
    (tag) => {
      expect(() => verifyVersion(tag, tag.slice(1))).not.toThrow();
    },
  );
  it.each(["v9.0.0", "v0.2.7/evil", "--help", "0.2.7"])(
    "refuses an invalid or mismatched tag: %s",
    (tag) => {
      expect(() => verifyVersion(tag, version)).toThrow(
        "RELEASE_TAG_VERSION_MISMATCH",
      );
    },
  );
  const tagObject = "b".repeat(40);
  // A fake git for an annotated local tag; `remote` is the ls-remote output.
  const annotatedGit =
    (remote, calls = [], overrides = {}) =>
    (...args) => {
      calls.push(args);
      if (overrides[args[0]]) return overrides[args[0]](...args);
      if (args[0] === "rev-parse")
        return args[1] === `refs/tags/v${version}` ? tagObject : head;
      if (args[0] === "cat-file") return "tag";
      if (args[0] === "merge-base") return "";
      return remote;
    };
  const publishedAnnotated = `${tagObject}\trefs/tags/v${version}\n${head}\trefs/tags/v${version}^{}`;
  it("accepts an annotated tag on accepted main whose remote matches", () => {
    const calls = [];
    expect(
      verifyReleaseTag(`v${version}`, annotatedGit(publishedAnnotated, calls)),
    ).toBe(head);
    expect(calls).toContainEqual([
      "merge-base",
      "--is-ancestor",
      head,
      "refs/remotes/origin/main",
    ]);
  });
  it("refuses a lightweight tag locally or on the remote", () => {
    expect(() =>
      verifyReleaseTag(
        `v${version}`,
        annotatedGit(`${head}\trefs/tags/v${version}`, [], {
          "rev-parse": () => head,
          "cat-file": () => "commit",
        }),
      ),
    ).toThrow("RELEASE_TAG_NOT_ANNOTATED");
    expect(() =>
      verifyReleaseTag(
        `v${version}`,
        annotatedGit(publishedAnnotated, [], { "cat-file": () => "commit" }),
      ),
    ).toThrow("RELEASE_TAG_NOT_ANNOTATED");
    expect(() =>
      verifyReleaseTag(
        `v${version}`,
        annotatedGit(`${tagObject}\trefs/tags/v${version}`),
      ),
    ).toThrow("RELEASE_REMOTE_TAG_CHANGED");
  });
  it("refuses moved remote tags and non-main source", () => {
    expect(() =>
      verifyReleaseTag(
        `v${version}`,
        annotatedGit(
          `${"c".repeat(40)}\trefs/tags/v${version}\n${head}\trefs/tags/v${version}^{}`,
        ),
      ),
    ).toThrow("RELEASE_REMOTE_TAG_CHANGED");
    expect(() =>
      verifyReleaseTag(
        `v${version}`,
        annotatedGit(
          `${tagObject}\trefs/tags/v${version}\n${"c".repeat(40)}\trefs/tags/v${version}^{}`,
        ),
      ),
    ).toThrow("RELEASE_REMOTE_TAG_CHANGED");
    expect(() =>
      verifyReleaseTag(
        `v${version}`,
        annotatedGit(publishedAnnotated, [], {
          "merge-base": () => {
            throw Error("not on main");
          },
        }),
      ),
    ).toThrow("not on main");
  });
  it("dry-runs the asset handoff without packaging or exposing private evidence", async () => {
    const { root, archiveName } = assets();
    fs.mkdirSync(path.join(root, "private"));
    fs.writeFileSync(path.join(root, "private", "evidence.json"), "{}");
    expect(await verifyReleaseAssets(root, { version, head })).toEqual([
      archiveName,
      "farol-release.json",
      "SHA256SUMS",
    ]);
  });
  it.each([
    "wrong head",
    "wrong size",
    "changed bytes",
    "extra file",
    "symlink",
  ])("rejects broken asset handoffs: %s", async (fault) => {
    const { root, manifest, archiveName } = assets();
    if (fault === "wrong head") manifest.sourceCommit = "b".repeat(40);
    if (fault === "wrong size") manifest.archiveSize++;
    if (fault === "changed bytes")
      fs.writeFileSync(path.join(root, archiveName), "different fake bytes\n");
    if (fault === "extra file")
      fs.writeFileSync(path.join(root, "private-prompt.txt"), "synthetic");
    if (fault === "symlink") {
      fs.renameSync(path.join(root, archiveName), path.join(root, "other"));
      fs.symlinkSync("other", path.join(root, archiveName));
    }
    fs.writeFileSync(
      path.join(root, "farol-release.json"),
      JSON.stringify(manifest),
    );
    await expect(
      verifyReleaseAssets(root, { version, head }),
    ).rejects.toThrow();
  });
});
