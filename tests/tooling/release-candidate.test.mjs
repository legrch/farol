import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateIdentity,
  validateCandidate,
  publishCandidate,
} from "../../tooling/release-candidate.mjs";

const head = "a".repeat(40);
const version = "0.2.8-owner.beta.10";
const document = {
  version,
  farolRelease: { updateChannel: "github-owner-beta", buildVersion: "46" },
};
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "farol-candidate-"));
  roots.push(directory);
  // Temporary synthetic bytes exercise the REAL public verifier, not native ZIP
  // extraction, package attestation, hosted Actions or owner qualification.
  const bytes = Buffer.from("synthetic archive");
  const archiveName = `Farol-${version}-darwin-arm64.zip`;
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(directory, archiveName), bytes);
  fs.writeFileSync(
    path.join(directory, "SHA256SUMS"),
    `${archiveSha256}  ${archiveName}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "farol-release.json"),
    JSON.stringify({
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
      archiveSha256,
      archiveSize: bytes.length,
    }),
  );
  const expectedDigest = createHash("sha256")
    .update(fs.readFileSync(path.join(directory, "farol-release.json")))
    .digest("hex");
  const repo = { id: 10, full_name: "legrch/farol" };
  const run = {
    id: 100,
    run_attempt: 1,
    run_number: 5,
    repository: repo,
    head_repository: repo,
    workflow_id: 20,
    path: ".github/workflows/release.yml",
    head_sha: head,
    head_branch: `v${version}`,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    updated_at: "2026-10-22T10:00:00Z",
  };
  const current = {
    ...run,
    id: 101,
    run_number: 6,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-23T10:00:00Z",
  };
  const identity = candidateIdentity(document, head, run.id, run.run_attempt);
  const metadata = {
    current,
    run,
    identity,
    expectedDigest,
    jobs: {
      total_count: 2,
      jobs: [
        ["build", "success"],
        ["publish", "skipped"],
      ].map(([name, conclusion]) => ({
        name,
        conclusion,
        run_id: run.id,
        run_attempt: 1,
        head_sha: head,
        status: "completed",
      })),
    },
    artifacts: {
      total_count: 1,
      artifacts: [
        {
          id: 200,
          name: identity.artifactName,
          size_in_bytes: 100,
          expired: false,
          expires_at: "2099-01-01T00:00:00Z",
          workflow_run: {
            id: run.id,
            head_sha: head,
            repository_id: 10,
            head_repository_id: 10,
          },
        },
      ],
    },
  };
  const effects = [],
    reads = [],
    gitCalls = [];
  const base = "/repos/legrch/farol";
  const responses = new Map([
    [`${base}/releases/tags/${identity.tag}`, null],
    [`${base}/releases?per_page=100`, []],
    [`${base}/git/ref/tags/${identity.tag}`, null],
  ]);
  const options = {
    metadata,
    directory,
    dispatchSha: head,
    git: (...args) => {
      gitCalls.push(args);
      return args[0] === "rev-parse" ? head : "";
    },
    api: async (endpoint, { body } = {}) => {
      if (body) {
        effects.push({ endpoint, body });
        return { sha: "b".repeat(40) };
      }
      reads.push(endpoint);
      if (!responses.has(endpoint)) throw Error("unexpected read");
      const value = responses.get(endpoint);
      if (value instanceof Error) throw value;
      return value;
    },
    release: (tag, files) => {
      effects.push({ tag, files });
    },
  };
  return {
    options,
    metadata,
    directory,
    effects,
    reads,
    responses,
    gitCalls,
    base,
  };
}

describe("qualified publication handoff (mocked remote, synthetic assets)", () => {
  it.each(["workflow_dispatch", "push"])(
    "publishes exact prior %s bytes after ancestry checks",
    async (event) => {
      const f = fixture();
      f.metadata.run.event = event;
      expect(validateCandidate(f.metadata)).toBe(200);
      await publishCandidate(f.options);
      expect(f.gitCalls).toContainEqual([
        "merge-base",
        "--is-ancestor",
        head,
        "refs/remotes/origin/main",
      ]);
      expect(f.effects).toEqual([
        {
          endpoint: `${f.base}/git/tags`,
          body: {
            tag: `v${version}`,
            message: `Farol v${version}`,
            object: head,
            type: "commit",
          },
        },
        {
          endpoint: `${f.base}/git/refs`,
          body: { ref: `refs/tags/v${version}`, sha: "b".repeat(40) },
        },
        {
          tag: `v${version}`,
          files: [
            `Farol-${version}-darwin-arm64.zip`,
            "farol-release.json",
            "SHA256SUMS",
          ].map((file) => path.join(f.directory, file)),
        },
      ]);
    },
  );
  it.each([
    [
      "failed",
      (m) => {
        m.run.conclusion = "failure";
      },
    ],
    [
      "in progress",
      (m) => {
        m.run.status = "in_progress";
      },
    ],
    [
      "unknown",
      (m) => {
        m.run.conclusion = null;
      },
    ],
    [
      "foreign repo",
      (m) => {
        m.run.repository = { id: 11, full_name: "other/farol" };
      },
    ],
    [
      "foreign repository ID",
      (m) => {
        m.run.repository = { ...m.run.repository, id: 11 };
        m.run.head_repository = m.run.repository;
      },
    ],
    [
      "fork",
      (m) => {
        m.run.head_repository = { id: 11, full_name: "other/farol" };
      },
    ],
    [
      "foreign workflow",
      (m) => {
        m.run.workflow_id++;
      },
    ],
    [
      "foreign path",
      (m) => {
        m.run.path = ".github/workflows/pr.yml";
      },
    ],
    [
      "wrong event",
      (m) => {
        m.run.event = "pull_request";
      },
    ],
    [
      "publisher is tag event",
      (m) => {
        m.current.event = "push";
      },
    ],
    [
      "same run",
      (m) => {
        m.run.id = m.current.id;
      },
    ],
    [
      "future run",
      (m) => {
        m.run.run_number = m.current.run_number + 1;
      },
    ],
    [
      "not prior completed",
      (m) => {
        m.run.updated_at = m.current.created_at;
      },
    ],
    [
      "unknown completion time",
      (m) => {
        delete m.run.updated_at;
      },
    ],
    [
      "wrong tag",
      (m) => {
        m.run.event = "push";
        m.run.head_branch = "main";
      },
    ],
    [
      "candidate source mismatch",
      (m) => {
        m.run.head_sha = "c".repeat(40);
      },
    ],
    [
      "publish source mismatch",
      (m) => {
        m.current.head_sha = "c".repeat(40);
      },
    ],
    [
      "non-prepare dispatch",
      (m) => {
        m.jobs.jobs[0].conclusion = "skipped";
        m.jobs.jobs[1].conclusion = "success";
      },
    ],
    [
      "missing build",
      (m) => {
        m.jobs.jobs.pop();
      },
    ],
    [
      "wrong build attempt",
      (m) => {
        m.jobs.jobs[0].run_attempt++;
      },
    ],
    [
      "wrong build source",
      (m) => {
        m.jobs.jobs[0].head_sha = "c".repeat(40);
      },
    ],
    [
      "extra jobs",
      (m) => {
        m.jobs.total_count++;
      },
    ],
    [
      "expired",
      (m) => {
        m.artifacts.artifacts[0].expired = true;
      },
    ],
    [
      "past expiry",
      (m) => {
        m.artifacts.artifacts[0].expires_at = "2020-01-01T00:00:00Z";
      },
    ],
    [
      "unknown expiry",
      (m) => {
        delete m.artifacts.artifacts[0].expires_at;
      },
    ],
    [
      "missing artifact",
      (m) => {
        m.artifacts.artifacts = [];
        m.artifacts.total_count = 0;
      },
    ],
    [
      "extra artifact",
      (m) => {
        m.artifacts.total_count++;
      },
    ],
    [
      "artifact name mismatch",
      (m) => {
        m.artifacts.artifacts[0].name = "public-release-assets";
      },
    ],
    [
      "artifact run mismatch",
      (m) => {
        m.artifacts.artifacts[0].workflow_run.id++;
      },
    ],
    [
      "artifact source mismatch",
      (m) => {
        m.artifacts.artifacts[0].workflow_run.head_sha = "c".repeat(40);
      },
    ],
    [
      "artifact repository mismatch",
      (m) => {
        m.artifacts.artifacts[0].workflow_run.repository_id++;
      },
    ],
    [
      "wrong attempt",
      (m) => {
        m.run.run_attempt++;
      },
    ],
    [
      "missing digest",
      (m) => {
        m.expectedDigest = "";
      },
    ],
    [
      "wrong digest",
      (m) => {
        m.expectedDigest = "f".repeat(64);
      },
    ],
  ])("rejects %s before any publication effect", async (_name, mutate) => {
    const f = fixture();
    mutate(f.metadata);
    await expect(publishCandidate(f.options)).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
  it.each(["checkout", "dispatch", "ancestry"])(
    "rejects stale %s source before remote effects",
    async (fault) => {
      const f = fixture();
      if (fault === "dispatch") f.options.dispatchSha = "c".repeat(40);
      else
        f.options.git = (command) => {
          if (fault === "ancestry" && command === "merge-base")
            throw Error("not accepted main");
          return "c".repeat(40);
        };
      if (fault === "ancestry")
        f.options.git = (command) => {
          if (command === "merge-base") throw Error("not accepted main");
          return head;
        };
      await expect(publishCandidate(f.options)).rejects.toThrow();
      expect(f.effects).toEqual([]);
      expect(f.reads).toEqual([]);
    },
  );
  it.each([
    "extra",
    "private",
    "missing",
    "archive",
    "checksum",
    "manifest source",
  ])("rejects %s downloaded files before any effect", async (fault) => {
    const f = fixture();
    if (fault === "extra")
      fs.writeFileSync(path.join(f.directory, "extra.txt"), "x");
    if (fault === "private") fs.mkdirSync(path.join(f.directory, "private"));
    if (fault === "missing")
      fs.unlinkSync(path.join(f.directory, "SHA256SUMS"));
    if (fault === "archive")
      fs.writeFileSync(
        path.join(f.directory, `Farol-${version}-darwin-arm64.zip`),
        "different bytes",
      );
    if (fault === "checksum")
      fs.writeFileSync(path.join(f.directory, "SHA256SUMS"), "invalid");
    if (fault === "manifest source") {
      const file = path.join(f.directory, "farol-release.json");
      const m = JSON.parse(fs.readFileSync(file));
      m.sourceCommit = "c".repeat(40);
      fs.writeFileSync(file, JSON.stringify(m));
      f.metadata.expectedDigest = createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex");
    }
    await expect(publishCandidate(f.options)).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
  function existingTag(f, type = "tag", source = head) {
    const object = "b".repeat(40);
    f.responses.set(`${f.base}/git/ref/tags/v${version}`, {
      ref: `refs/tags/v${version}`,
      object: { type, sha: object },
    });
    f.responses.set(`${f.base}/git/tags/${object}`, {
      sha: object,
      tag: `v${version}`,
      object: { type: "commit", sha: source },
    });
  }
  it("uses an existing exact annotated tag without rewriting it", async () => {
    const f = fixture();
    existingTag(f);
    await publishCandidate(f.options);
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0].tag).toBe(`v${version}`);
  });
  it.each([
    "release exists",
    "draft exists",
    "incomplete releases",
    "lightweight tag",
    "wrong tag source",
    "unknown release",
    "unknown tag",
  ])("refuses %s without overwrite", async (fault) => {
    const f = fixture();
    if (fault === "release exists")
      f.responses.set(`${f.base}/releases/tags/v${version}`, {
        id: 1,
        assets: [],
      });
    if (fault === "draft exists")
      f.responses.set(`${f.base}/releases?per_page=100`, [
        { tag_name: `v${version}`, draft: true, assets: [] },
      ]);
    if (fault === "incomplete releases")
      f.responses.set(
        `${f.base}/releases?per_page=100`,
        Array.from({ length: 100 }, () => ({ tag_name: "v0.1.0" })),
      );
    if (fault === "lightweight tag") existingTag(f, "commit");
    if (fault === "wrong tag source") existingTag(f, "tag", "c".repeat(40));
    if (fault === "unknown release")
      f.responses.set(`${f.base}/releases/tags/v${version}`, Error("HTTP 403"));
    if (fault === "unknown tag")
      f.responses.set(`${f.base}/git/ref/tags/v${version}`, Error("HTTP 500"));
    await expect(publishCandidate(f.options)).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
  it("does not release or retry after an unknown tag write", async () => {
    const f = fixture(),
      api = f.options.api;
    f.options.api = async (endpoint, options = {}) => {
      if (options.body) {
        f.effects.push(endpoint);
        throw Error("timeout");
      }
      return api(endpoint, options);
    };
    await expect(publishCandidate(f.options)).rejects.toThrow("timeout");
    expect(f.effects).toEqual([`${f.base}/git/tags`]);
  });
  it.each([
    "0.2.8",
    "0.2.8-rc.1",
    "0.2.8-owner.beta.01",
    "v0.2.8-owner.beta.1",
  ])("requires an exact owner-beta version: %s", (bad) => {
    expect(() =>
      candidateIdentity({ ...document, version: bad }, head, 100, 1),
    ).toThrow();
  });
});
