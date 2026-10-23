import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productName } from "../../tooling/harness-identity.ts";
import {
  candidateIdentity,
  validateCandidate,
  publishCandidate,
  downloadDraftAssets,
  githubApi,
} from "../../tooling/release-candidate.mjs";

const head = "a".repeat(40);
const version = "0.2.8-owner.beta.10";
const document = {
  version,
  farolRelease: { updateChannel: "github-owner-beta", buildVersion: "46" },
};
const roots = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "farol-candidate-")),
  );
  roots.push(root);
  const directory = path.join(root, "download");
  // Mock transports and synthetic archive bytes exercise the real handoff
  // verifier. These are not native, hosted Actions or qualification evidence.
  const bytes = Buffer.from("synthetic archive");
  const archiveName = `${productName}-${version}-darwin-arm64.zip`;
  const files = new Map([
    [archiveName, bytes],
    ["SHA256SUMS", Buffer.from(`${hash(bytes)}  ${archiveName}\n`)],
    [
      "farol-release.json",
      Buffer.from(
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
          archiveSha256: hash(bytes),
          archiveSize: bytes.length,
        }),
      ),
    ],
  ]);
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
    event: "push",
    status: "completed",
    conclusion: "success",
    updated_at: "2026-10-22T10:00:00Z",
  };
  const current = {
    ...run,
    id: 101,
    run_number: 6,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-23T10:00:00Z",
  };
  const identity = candidateIdentity(document, head, run.id, run.run_attempt);
  const metadata = {
    current,
    run,
    identity,
    expectedDigest: hash(files.get("farol-release.json")),
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
  };
  const assets = [...files].map(([name, bytes], index) => ({
    id: 200 + index,
    name,
    size: bytes.length,
    state: "uploaded",
    browser_download_url: "https://untrusted.invalid/ignored",
  }));
  const draft = {
    id: 300,
    tag_name: identity.tag,
    draft: true,
    prerelease: true,
    published_at: null,
    assets,
  };
  const effects = [],
    reads = [],
    requests = [],
    gitCalls = [];
  const base = "/repos/legrch/farol";
  const tagObject = "b".repeat(40);
  const responses = new Map([
    [`${base}/releases/tags/${identity.tag}`, null],
    [`${base}/releases?per_page=100`, [draft]],
    [`${base}/releases/300`, draft],
    [`${base}/releases/300/assets?per_page=100`, assets],
    [
      `${base}/git/ref/tags/${identity.tag}`,
      {
        ref: `refs/tags/${identity.tag}`,
        object: { type: "tag", sha: tagObject },
      },
    ],
    [
      `${base}/git/tags/${tagObject}`,
      {
        sha: tagObject,
        tag: identity.tag,
        object: { type: "commit", sha: head },
      },
    ],
  ]);
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const selected = assets.find(
      (asset) =>
        url === `https://api.github.com${base}/releases/assets/${asset.id}`,
    );
    if (!selected) throw Error("unexpected fetch");
    return new Response(files.get(selected.name));
  };
  const options = {
    readMetadata: async () => structuredClone(metadata),
    releaseId: draft.id,
    directory,
    dispatchSha: head,
    git: (...args) => {
      gitCalls.push(args);
      return args[0] === "rev-parse" ? head : "";
    },
    api: async (endpoint, { body, method } = {}) => {
      if (body) {
        effects.push({ endpoint, body, method });
        return { ...draft, draft: false, published_at: "2026-10-23T11:00:00Z" };
      }
      reads.push(endpoint);
      if (!responses.has(endpoint)) throw Error("unexpected read");
      const value = responses.get(endpoint);
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    download: (assets, directory, identity) =>
      downloadDraftAssets(
        assets,
        directory,
        identity,
        "synthetic-token",
        fetchImpl,
      ),
  };
  return {
    options,
    metadata,
    root,
    directory,
    files,
    assets,
    draft,
    effects,
    reads,
    requests,
    responses,
    gitCalls,
    base,
    tagObject,
    fetchImpl,
  };
}

describe("private qualified draft publication (mocked HTTP only)", () => {
  it("downloads only pinned IDs and PATCHes the same draft once after all checks", async () => {
    const f = fixture();
    await publishCandidate(f.options);
    expect(f.gitCalls).toContainEqual([
      "merge-base",
      "--is-ancestor",
      head,
      "refs/remotes/origin/main",
    ]);
    expect(f.effects).toEqual([
      {
        endpoint: `${f.base}/releases/300`,
        method: "PATCH",
        body: { draft: false, prerelease: true, make_latest: "false" },
      },
    ]);
    expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700);
    for (const name of f.files.keys())
      expect(fs.statSync(path.join(f.directory, name)).mode & 0o777).toBe(
        0o600,
      );
    expect(f.requests).toHaveLength(3);
    for (const { url, options } of f.requests) {
      expect(url).toMatch(
        /^https:\/\/api.github.com\/repos\/legrch\/farol\/releases\/assets\/20[0-2]$/u,
      );
      expect(options.redirect).toBe("manual");
      expect(options.headers.Authorization).toBe("Bearer synthetic-token");
      expect(options.signal.aborted).toBe(true);
    }
    expect(
      f.reads.filter((endpoint) => endpoint === `${f.base}/releases/300`),
    ).toHaveLength(2);
  });
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
      "prepare dispatch",
      (m) => {
        m.run.event = "workflow_dispatch";
      },
    ],
    [
      "publisher tag event",
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
      "publish-only run",
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
  ])("rejects %s before the publication effect", async (_name, mutate) => {
    const f = fixture();
    mutate(f.metadata);
    await expect(publishCandidate(f.options)).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
  it.each(["checkout", "dispatch", "ancestry"])(
    "refuses stale %s source",
    async (fault) => {
      const f = fixture();
      if (fault === "dispatch") f.options.dispatchSha = "c".repeat(40);
      else
        f.options.git = (command) => {
          if (fault === "ancestry" && command === "merge-base")
            throw Error("not accepted main");
          return fault === "ancestry" ? head : "c".repeat(40);
        };
      await expect(publishCandidate(f.options)).rejects.toThrow();
      expect(f.effects).toEqual([]);
      expect(f.reads).toEqual([]);
    },
  );
  it.each([
    "missing tag",
    "lightweight",
    "wrong source",
    "wrong draft ID",
    "published",
    "not prerelease",
    "wrong tag",
    "published timestamp",
    "extra draft",
    "public release",
    "incomplete listing",
    "extra asset",
    "duplicate name",
    "duplicate ID",
    "zero size",
    "pending upload",
    "oversized zip",
    "oversized manifest",
    "oversized sums",
    "listed assets mismatch",
    "denied",
    "unknown",
  ])("refuses %s without mutation", async (fault) => {
    const f = fixture();
    const ref = f.responses.get(`${f.base}/git/ref/tags/v${version}`);
    if (fault === "missing tag")
      f.responses.set(`${f.base}/git/ref/tags/v${version}`, Error("HTTP 404"));
    if (fault === "lightweight") ref.object.type = "commit";
    if (fault === "wrong source")
      f.responses.get(`${f.base}/git/tags/${f.tagObject}`).object.sha =
        "c".repeat(40);
    if (fault === "wrong draft ID") f.draft.id++;
    if (fault === "published") f.draft.draft = false;
    if (fault === "not prerelease") f.draft.prerelease = false;
    if (fault === "wrong tag") f.draft.tag_name = "v0.0.0";
    if (fault === "published timestamp")
      f.draft.published_at = "2026-10-22T00:00:00Z";
    if (fault === "extra draft")
      f.responses
        .get(`${f.base}/releases?per_page=100`)
        .push({ ...f.draft, id: 301 });
    if (fault === "public release")
      f.responses.set(`${f.base}/releases/tags/v${version}`, {
        ...f.draft,
        id: 301,
        draft: false,
      });
    if (fault === "incomplete listing")
      f.responses.set(
        `${f.base}/releases?per_page=100`,
        Array(100).fill(f.draft),
      );
    if (fault === "extra asset")
      f.assets.push({
        id: 204,
        name: "private.txt",
        size: 1,
        state: "uploaded",
      });
    if (fault === "duplicate name") f.assets[1].name = f.assets[0].name;
    if (fault === "duplicate ID") f.assets[1].id = f.assets[0].id;
    if (fault === "zero size") f.assets[0].size = 0;
    if (fault === "pending upload") f.assets[0].state = "starter";
    if (fault === "oversized zip") f.assets[0].size = 2147483649;
    if (fault === "oversized manifest") f.assets[2].size = 16385;
    if (fault === "oversized sums") f.assets[1].size = 1025;
    if (fault === "listed assets mismatch")
      f.responses.set(
        `${f.base}/releases/300/assets?per_page=100`,
        f.assets.map((a) => ({ ...a, id: a.id + 5 })),
      );
    if (fault === "denied" || fault === "unknown")
      f.responses.set(`${f.base}/releases/300`, Error(fault));
    await expect(publishCandidate(f.options)).rejects.toThrow();
    expect(f.effects).toEqual([]);
    expect(f.requests).toEqual([]);
  });
  it.each([
    "run attempt",
    "tag object",
    "draft",
    "asset ID",
    "asset size",
    "asset name",
    "asset removed",
    "published",
  ])("revalidates changed %s after downloading", async (fault) => {
    const f = fixture(),
      download = f.options.download;
    f.options.download = async (...args) => {
      await download(...args);
      if (fault === "run attempt") f.metadata.run.run_attempt++;
      if (fault === "tag object") {
        const object = "c".repeat(40);
        f.responses.get(`${f.base}/git/ref/tags/v${version}`).object.sha =
          object;
        f.responses.set(`${f.base}/git/tags/${object}`, {
          sha: object,
          tag: `v${version}`,
          object: { type: "commit", sha: head },
        });
      }
      if (fault === "draft") f.draft.id++;
      if (fault === "asset ID") f.assets[0].id++;
      if (fault === "asset size") f.assets[0].size++;
      if (fault === "asset name") f.assets[0].name = "private.txt";
      if (fault === "asset removed") f.assets.pop();
      if (fault === "published") f.draft.draft = false;
    };
    await expect(publishCandidate(f.options)).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
  it.each([
    "extra",
    "private",
    "missing",
    "archive",
    "checksum",
    "manifest source",
  ])("verifies actual downloaded %s bytes", async (fault) => {
    const f = fixture(),
      download = f.options.download;
    f.options.download = async (...args) => {
      await download(...args);
      if (fault === "extra")
        fs.writeFileSync(path.join(f.directory, "extra.txt"), "x");
      if (fault === "private") fs.mkdirSync(path.join(f.directory, "private"));
      if (fault === "missing")
        fs.unlinkSync(path.join(f.directory, "SHA256SUMS"));
      if (fault === "archive")
        fs.writeFileSync(
          path.join(f.directory, `${productName}-${version}-darwin-arm64.zip`),
          "changed",
        );
      if (fault === "checksum")
        fs.writeFileSync(path.join(f.directory, "SHA256SUMS"), "invalid");
      if (fault === "manifest source") {
        const file = path.join(f.directory, "farol-release.json"),
          manifest = JSON.parse(fs.readFileSync(file));
        manifest.sourceCommit = "c".repeat(40);
        fs.writeFileSync(file, JSON.stringify(manifest));
        f.metadata.expectedDigest = hash(fs.readFileSync(file));
      }
    };
    await expect(publishCandidate(f.options)).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
  it("never retries an unknown final PATCH or edits an already published release", async () => {
    const f = fixture(),
      api = f.options.api;
    f.options.api = async (endpoint, options = {}) => {
      if (options.body) {
        f.effects.push(endpoint);
        throw Error("RELEASE_CANDIDATE_GITHUB_TRANSPORT_UNKNOWN");
      }
      return api(endpoint, options);
    };
    await expect(publishCandidate(f.options)).rejects.toThrow(
      "TRANSPORT_UNKNOWN",
    );
    expect(f.effects).toEqual([`${f.base}/releases/300`]);
  });
  it("retains an unexpected PATCH response as unknown without retry", async () => {
    const f = fixture(),
      api = f.options.api;
    f.options.api = async (endpoint, options) => {
      const result = await api(endpoint, options);
      return options?.body ? { ...result, id: 301 } : result;
    };
    await expect(publishCandidate(f.options)).rejects.toThrow(
      "PUBLICATION_RESPONSE_UNKNOWN",
    );
    expect(f.effects).toHaveLength(1);
  });
  it.each([
    "0.2.8",
    "0.2.8-rc.1",
    "0.2.8-owner.beta.01",
    "v0.2.8-owner.beta.1",
  ])("requires strict owner-beta: %s", (version) => {
    expect(() =>
      candidateIdentity({ ...document, version }, head, 100, 1),
    ).toThrow();
  });
});

describe("bounded private asset transport (no network)", () => {
  it.each([
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
  ])("follows one HTTPS redirect to %s without authorization", async (host) => {
    const f = fixture(),
      calls = [];
    await downloadDraftAssets(
      f.assets,
      f.directory,
      f.metadata.identity,
      "synthetic-token",
      async (url, options) => {
        calls.push({ url, options });
        if (url.startsWith("https://api.github.com/"))
          return new Response(null, {
            status: 302,
            headers: {
              location: `https://${host}/asset?synthetic-signature=ignored`,
            },
          });
        return new Response(
          f.files.get(
            [...f.files.keys()].sort((a, b) => a.localeCompare(b))[
              Math.floor((calls.length - 1) / 2)
            ],
          ),
        );
      },
    );
    expect(calls).toHaveLength(6);
    for (const [index, call] of calls.entries())
      expect(call.options.headers).toEqual(
        index % 2
          ? {}
          : {
              Authorization: "Bearer synthetic-token",
              Accept: "application/octet-stream",
              "X-GitHub-Api-Version": "2022-11-28",
            },
      );
  });
  it.each([
    "http://release-assets.githubusercontent.com/a",
    "https://evil.invalid/a",
    "https://release-assets.githubusercontent.com.evil.invalid/a",
    "https://user:password@objects.githubusercontent.com/a",
    "https://objects.githubusercontent.com:8443/a",
    "https://objects.githubusercontent.com:443/a",
    " https://objects.githubusercontent.com:443/a",
    "https://objects.githubusercontent.com/a#secret",
    "/relative",
  ])("rejects unsafe redirects without forwarding: %s", async (location) => {
    const f = fixture(),
      request = vi.fn(
        async () => new Response(null, { status: 302, headers: { location } }),
      );
    await expect(
      downloadDraftAssets(
        f.assets,
        f.directory,
        f.metadata.identity,
        "synthetic-token",
        request,
      ),
    ).rejects.toThrow("REDIRECT_INVALID");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    "second redirect",
    "denied",
    "truncated",
    "oversized",
    "declared size",
    "compressed",
    "transport",
    "body failure",
  ])("refuses %s with bounded local output and no retry", async (fault) => {
    const f = fixture(),
      calls = [];
    const first = [...f.assets].sort((a, b) => a.name.localeCompare(b.name))[0];
    const request = async (url, options) => {
      calls.push({ url, options });
      if (fault === "transport")
        throw Error("private url and token must not escape");
      if (fault === "second redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://objects.githubusercontent.com/a" },
        });
      if (fault === "denied")
        return new Response("private error", { status: 403 });
      if (fault === "truncated")
        return new Response(new Uint8Array(first.size - 1));
      if (fault === "oversized")
        return new Response(new Uint8Array(first.size + 100000));
      if (fault === "declared size")
        return new Response(new Uint8Array(first.size), {
          headers: { "content-length": String(first.size + 1) },
        });
      if (fault === "compressed")
        return new Response(new Uint8Array(first.size), {
          headers: { "content-encoding": "gzip" },
        });
      return new Response(
        new ReadableStream({
          type: "bytes",
          pull(controller) {
            controller.error(Error("private body failure"));
          },
        }),
      );
    };
    await expect(
      downloadDraftAssets(
        f.assets,
        f.directory,
        f.metadata.identity,
        "synthetic-token",
        request,
      ),
    ).rejects.toThrow(/^RELEASE_CANDIDATE_[A-Z0-9_]+$/u);
    expect(calls).toHaveLength(fault === "second redirect" ? 2 : 1);
    expect(
      fs.statSync(path.join(f.directory, first.name)).size,
    ).toBeLessThanOrEqual(first.size);
  });
  it("reads at most the metadata size plus one sentinel byte from oversized streams", async () => {
    const f = fixture();
    const first = [...f.assets].sort((a, b) => a.name.localeCompare(b.name))[0];
    let supplied = 0;
    await expect(
      downloadDraftAssets(
        f.assets,
        f.directory,
        f.metadata.identity,
        "synthetic-token",
        async () =>
          new Response(
            new ReadableStream({
              type: "bytes",
              pull(controller) {
                const request = controller.byobRequest;
                supplied += request.view.byteLength;
                request.view.fill(1);
                request.respond(request.view.byteLength);
              },
            }),
          ),
      ),
    ).rejects.toThrow("ASSET_SIZE_MISMATCH");
    expect(supplied).toBe(first.size + 1);
    expect(fs.statSync(path.join(f.directory, first.name)).size).toBe(0);
  });
  it("rejects a substituted output directory before another asset can be opened", async () => {
    const f = fixture();
    const target = path.join(f.root, "foreign");
    fs.mkdirSync(target);
    const request = vi.fn(async (...args) => {
      fs.renameSync(f.directory, path.join(f.root, "retained"));
      fs.symlinkSync(target, f.directory);
      return f.fetchImpl(...args);
    });
    await expect(
      downloadDraftAssets(
        f.assets,
        f.directory,
        f.metadata.identity,
        "synthetic-token",
        request,
      ),
    ).rejects.toThrow("DIRECTORY_CHANGED");
    expect(request).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it("aborts a stalled byte stream on a finite deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = downloadDraftAssets(
      f.assets,
      f.directory,
      f.metadata.identity,
      "synthetic-token",
      async (_url, { signal }) =>
        new Response(
          new ReadableStream({
            type: "bytes",
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(Error("aborted")),
                { once: true },
              );
            },
          }),
        ),
    );
    const result = expect(pending).rejects.toThrow("ASSET_TRANSPORT_UNKNOWN");
    await vi.advanceTimersByTimeAsync(120001);
    await result;
  });
  it.each(["existing", "symlink directory", "symlink parent"])(
    "refuses %s without network or overwrite",
    async (fault) => {
      const f = fixture(),
        request = vi.fn();
      let directory = f.directory;
      if (fault === "existing") fs.mkdirSync(directory);
      if (fault === "symlink directory") fs.symlinkSync(f.root, directory);
      if (fault === "symlink parent") {
        const link = path.join(f.root, "link");
        fs.symlinkSync(f.root, link);
        directory = path.join(link, "new");
      }
      await expect(
        downloadDraftAssets(
          f.assets,
          directory,
          f.metadata.identity,
          "synthetic-token",
          request,
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("creates only ordinary exclusive private files and does not follow a substituted symlink", async () => {
    const f = fixture(),
      request = f.fetchImpl;
    const target = path.join(f.root, "preserve");
    fs.writeFileSync(target, "unchanged");
    const sorted = [...f.assets].sort((a, b) => a.name.localeCompare(b.name));
    let calls = 0;
    await expect(
      downloadDraftAssets(
        f.assets,
        f.directory,
        f.metadata.identity,
        "synthetic-token",
        async (...args) => {
          calls++;
          if (calls === 1)
            fs.symlinkSync(target, path.join(f.directory, sorted[1].name));
          return request(...args);
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
  });
});

describe("fixed GitHub API transport", () => {
  it("allows only exact draft publication PATCH and keeps auth on the API host", async () => {
    const request = vi.fn(async () => new Response("{}"));
    const api = githubApi("synthetic-token", request);
    await api("/repos/legrch/farol/releases/300", {
      method: "PATCH",
      body: { draft: false, prerelease: true, make_latest: "false" },
    });
    expect(request.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/legrch/farol/releases/300",
    );
    expect(request.mock.calls[0][1].redirect).toBe("error");
    await expect(api("https://evil.invalid")).rejects.toThrow(
      "ENDPOINT_INVALID",
    );
    await expect(
      api("/repos/legrch/farol/releases", { method: "POST", body: {} }),
    ).rejects.toThrow("METHOD_INVALID");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 500])(
    "treats HTTP %s as terminal except explicit absence",
    async (status) => {
      const request = vi.fn(
        async () => new Response("private body", { status }),
      );
      const api = githubApi("synthetic-token", request);
      await expect(api("/repos/legrch/farol/releases/300")).rejects.toThrow(
        `GITHUB_HTTP_${status}`,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("accepts only HTTP 404 as absence", async () => {
    const api = githubApi(
      "synthetic-token",
      async () => new Response(null, { status: 404 }),
    );
    expect(
      await api("/repos/legrch/farol/releases/tags/v1", { absent: true }),
    ).toBeNull();
  });
  it.each(["network", "json"])("redacts private %s failures", async (fault) => {
    const request = vi.fn(async () => {
      if (fault === "network") throw Error("private-token-and-url");
      return new Response("private-body");
    });
    await expect(
      githubApi("synthetic-token", request)("/repos/legrch/farol/releases/300"),
    ).rejects.toThrow(/^RELEASE_CANDIDATE_GITHUB_[A-Z_]+$/u);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
