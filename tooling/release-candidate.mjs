// Private-draft handoff only. The supplied digest is not qualification evidence.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { productName } from "./harness-identity.ts";
import { releaseBuildFields } from "./release-identity.mjs";
import { verifyReleaseAssets } from "./verify-release-assets.mjs";
import { verifyReleaseTag } from "./verify-release-tag.mjs";

const repository = "legrch/farol";
const workflow = ".github/workflows/release.yml";
const base = `/repos/${repository}`;
const sha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const isDigest = (value) => typeof value === "string" && digest.test(value);
const id = (value) => Number.isSafeInteger(value) && value > 0;
function requireThat(condition, reason) {
  if (!condition) throw Error(`RELEASE_CANDIDATE_${reason}`);
}
function limits(identity) {
  return new Map([
    [`${productName}-${identity.version}-darwin-arm64.zip`, 2147483648],
    ["farol-release.json", 16384],
    ["SHA256SUMS", 1024],
  ]);
}
function candidatePrerelease(identity) {
  const version = identity?.version;
  requireThat(typeof version === "string", "IDENTITY_INVALID");
  if (/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version))
    return false;
  requireThat(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-owner\.beta\.(0|[1-9][0-9]*)$/u.test(
      version,
    ),
    "IDENTITY_INVALID",
  );
  return true;
}
function publicationBody(identity) {
  return {
    draft: false,
    prerelease: candidatePrerelease(identity),
    make_latest: "false",
  };
}
export function candidateIdentity(document, head, runId, attempt) {
  const channel = releaseBuildFields(document).updateChannel;
  requireThat(
    channel === "github-owner-beta" || channel === "github-stable",
    "CHANNEL_REQUIRED",
  );
  requireThat(sha.test(head) && id(runId) && id(attempt), "IDENTITY_INVALID");
  const identity = {
    version: document.version,
    tag: `v${document.version}`,
    head,
  };
  requireThat(
    candidatePrerelease(identity) === (channel === "github-owner-beta"),
    "CHANNEL_MISMATCH",
  );
  return identity;
}

// Preparation dispatches are useful source evidence, but only the exact prior
// successful TAG build may authorize the separate publication dispatch.
export function validateCandidate({
  current,
  run,
  jobs,
  identity,
  expectedDigest,
}) {
  requireThat(isDigest(expectedDigest), "MANIFEST_DIGEST_REQUIRED");
  for (const item of [current, run]) {
    requireThat(
      item?.repository?.full_name === repository &&
        id(item.repository.id) &&
        item.head_repository?.id === item.repository.id &&
        item.head_repository?.full_name === repository &&
        item.path === workflow &&
        id(item.workflow_id) &&
        id(item.id) &&
        id(item.run_attempt) &&
        id(item.run_number) &&
        item.head_sha === identity.head,
      "RUN_IDENTITY_INVALID",
    );
  }
  requireThat(
    current.event === "workflow_dispatch" &&
      run.repository.id === current.repository.id &&
      run.workflow_id === current.workflow_id &&
      run.id !== current.id &&
      run.run_number < current.run_number &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      Number.isFinite(Date.parse(run.updated_at)) &&
      Date.parse(run.updated_at) < Date.parse(current.created_at) &&
      run.event === "push" &&
      run.head_branch === identity.tag,
    "PRIOR_SUCCESSFUL_TAG_BUILD_REQUIRED",
  );
  requireThat(
    jobs?.total_count === 2 &&
      jobs.jobs?.length === 2 &&
      [
        ["build", "success"],
        ["publish", "skipped"],
      ].every(
        ([name, conclusion]) =>
          jobs.jobs.filter(
            (job) =>
              job.name === name &&
              job.run_id === run.id &&
              job.run_attempt === run.run_attempt &&
              job.head_sha === identity.head &&
              job.status === "completed" &&
              job.conclusion === conclusion,
          ).length === 1,
      ),
    "BUILD_ONLY_REQUIRED",
  );
}

export async function verifyCandidateAssets(
  directory,
  identity,
  expectedDigest,
) {
  requireThat(isDigest(expectedDigest), "MANIFEST_DIGEST_REQUIRED");
  const stat = fs.lstatSync(directory);
  requireThat(
    stat.isDirectory() && fs.realpathSync(directory) === directory,
    "DIRECTORY_INVALID",
  );
  const manifestPath = path.join(directory, "farol-release.json");
  const info = fs.lstatSync(manifestPath);
  requireThat(
    info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 16384,
    "MANIFEST_INVALID",
  );
  requireThat(
    createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex") ===
      expectedDigest,
    "MANIFEST_DIGEST_MISMATCH",
  );
  requireThat(
    JSON.stringify(fs.readdirSync(directory).sort()) ===
      JSON.stringify([...limits(identity).keys()].sort()),
    "PUBLIC_FILES_REQUIRED",
  );
  return verifyReleaseAssets(directory, identity);
}

export function verifySource(identity, dispatchSha, git) {
  requireThat(
    dispatchSha === identity.head && git("rev-parse", "HEAD") === dispatchSha,
    "SOURCE_MISMATCH",
  );
  git("merge-base", "--is-ancestor", dispatchSha, "refs/remotes/origin/main");
}

function assetIdentities(assets, identity) {
  const expected = limits(identity);
  requireThat(
    Array.isArray(assets) && assets.length === 3,
    "ASSET_SET_INVALID",
  );
  requireThat(
    new Set(assets.map((asset) => asset.id)).size === 3 &&
      new Set(assets.map((asset) => asset.name)).size === 3,
    "ASSET_SET_INVALID",
  );
  for (const asset of assets)
    requireThat(
      id(asset.id) &&
        expected.has(asset.name) &&
        id(asset.size) &&
        asset.size <= expected.get(asset.name) &&
        asset.state === "uploaded",
      "ASSET_IDENTITY_INVALID",
    );
  // Do not retain or follow browser_download_url, url or other API claims.
  return assets
    .map(({ id, name, size, state }) => ({ id, name, size, state }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function validateDraft(release, releaseId, identity) {
  requireThat(
    id(releaseId) &&
      release?.id === releaseId &&
      release.tag_name === identity.tag &&
      release.draft === true &&
      release.prerelease === candidatePrerelease(identity) &&
      release.published_at === null,
    "PRIVATE_DRAFT_REQUIRED",
  );
  return {
    id: releaseId,
    tag: identity.tag,
    assets: assetIdentities(release.assets, identity),
  };
}

export async function publicationPreconditions(api, identity, releaseId) {
  const ref = await api(`${base}/git/ref/tags/${identity.tag}`);
  requireThat(
    ref?.ref === `refs/tags/${identity.tag}` &&
      ref.object?.type === "tag" &&
      sha.test(ref.object.sha),
    "TAG_NOT_ANNOTATED",
  );
  const tag = await api(`${base}/git/tags/${ref.object.sha}`);
  requireThat(
    tag?.sha === ref.object.sha &&
      tag.tag === identity.tag &&
      tag.object?.type === "commit" &&
      tag.object.sha === identity.head,
    "TAG_SOURCE_MISMATCH",
  );
  const draft = validateDraft(
    await api(`${base}/releases/${releaseId}`),
    releaseId,
    identity,
  );
  const assets = assetIdentities(
    await api(`${base}/releases/${releaseId}/assets?per_page=100`),
    identity,
  );
  requireThat(
    JSON.stringify(assets) === JSON.stringify(draft.assets),
    "ASSETS_CHANGED",
  );
  const releases = await api(`${base}/releases?per_page=100`);
  requireThat(
    Array.isArray(releases) &&
      releases.length < 100 &&
      releases.every(
        (item) => id(item.id) && typeof item.tag_name === "string",
      ),
    "RELEASE_LIST_INCOMPLETE",
  );
  const matching = releases.filter((item) => item.tag_name === identity.tag);
  requireThat(
    matching.length === 1 &&
      JSON.stringify(validateDraft(matching[0], releaseId, identity)) ===
        JSON.stringify(draft),
    "RELEASE_CONFLICT",
  );
  const byTag = await api(`${base}/releases/tags/${identity.tag}`, {
    absent: true,
  });
  if (byTag !== null)
    requireThat(
      JSON.stringify(validateDraft(byTag, releaseId, identity)) ===
        JSON.stringify(draft),
      "RELEASE_CONFLICT",
    );
  return { ...draft, tagObject: ref.object.sha };
}

export async function publishCandidate({
  readMetadata,
  releaseId,
  directory,
  dispatchSha,
  git,
  api,
  download,
}) {
  const metadata = await readMetadata();
  validateCandidate(metadata);
  verifySource(metadata.identity, dispatchSha, git);
  const draft = await publicationPreconditions(
    api,
    metadata.identity,
    releaseId,
  );
  await download(draft.assets, directory, metadata.identity);
  await verifyCandidateAssets(
    directory,
    metadata.identity,
    metadata.expectedDigest,
  );
  // Refresh original run/attempt, remote annotated tag and private draft/asset
  // identities after download. Nothing creates tags, releases or assets here.
  const refreshed = await readMetadata();
  validateCandidate(refreshed);
  requireThat(
    JSON.stringify(refreshed) === JSON.stringify(metadata),
    "RUN_CHANGED",
  );
  verifySource(metadata.identity, dispatchSha, git);
  requireThat(
    JSON.stringify(
      await publicationPreconditions(api, metadata.identity, releaseId),
    ) === JSON.stringify(draft),
    "DRAFT_CHANGED",
  );
  const published = await api(`${base}/releases/${releaseId}`, {
    method: "PATCH",
    body: publicationBody(metadata.identity),
  });
  requireThat(
    published?.id === releaseId &&
      published.tag_name === draft.tag &&
      published.draft === false &&
      published.prerelease === candidatePrerelease(metadata.identity) &&
      Number.isFinite(Date.parse(published.published_at)) &&
      JSON.stringify(assetIdentities(published.assets, metadata.identity)) ===
        JSON.stringify(draft.assets),
    "PUBLICATION_RESPONSE_UNKNOWN",
  );
  return published;
}

// Errors from fetch/JSON/streams may contain private URLs or bodies. Expose only
// stable codes; there is no retry, alternate endpoint or credential fallback.
export function githubApi(token, fetchImpl = fetch) {
  requireThat(typeof token === "string" && token.length > 0, "TOKEN_REQUIRED");
  return async (endpoint, { absent = false, body, method = "GET" } = {}) => {
    requireThat(
      endpoint.startsWith(`${base}/`) &&
        !/[\\\s?#]/u.test(endpoint.split("?")[0]) &&
        !endpoint.includes(".."),
      "API_ENDPOINT_INVALID",
    );
    requireThat(
      (method === "GET" && body === undefined) ||
        (method === "PATCH" &&
          /^\/repos\/legrch\/farol\/releases\/[1-9][0-9]*$/u.test(endpoint) &&
          [true, false].some(
            (prerelease) =>
              JSON.stringify(body) ===
              JSON.stringify({
                draft: false,
                prerelease,
                make_latest: "false",
              }),
          )),
      "API_METHOD_INVALID",
    );
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
    } catch {
      throw Error("RELEASE_CANDIDATE_GITHUB_TRANSPORT_UNKNOWN");
    }
    if (absent && response.status === 404) return null;
    requireThat(response.ok, `GITHUB_HTTP_${response.status}`);
    try {
      return await response.json();
    } catch {
      throw Error("RELEASE_CANDIDATE_GITHUB_RESPONSE_INVALID");
    }
  };
}

export async function downloadDraftAssets(
  assets,
  directory,
  identity,
  token,
  fetchImpl = fetch,
) {
  try {
    return await downloadPrivateAssets(
      assets,
      directory,
      identity,
      token,
      fetchImpl,
    );
  } catch (error) {
    if (/^RELEASE_CANDIDATE_[A-Z0-9_]+$/u.test(error?.message ?? ""))
      throw error;
    throw Error("RELEASE_CANDIDATE_ASSET_OUTPUT_INVALID");
  }
}

async function downloadPrivateAssets(
  assets,
  directory,
  identity,
  token,
  fetchImpl,
) {
  const selected = assetIdentities(assets, identity);
  requireThat(typeof token === "string" && token.length > 0, "TOKEN_REQUIRED");
  requireThat(
    path.isAbsolute(directory) &&
      path.resolve(directory) === directory &&
      fs.realpathSync(path.dirname(directory)) === path.dirname(directory),
    "DIRECTORY_INVALID",
  );
  // mkdir is exclusive; output paths are never reused, followed or overwritten.
  fs.mkdirSync(directory, { mode: 0o700 });
  const directoryFd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const directoryInfo = fs.fstatSync(directoryFd);
    const checkDirectory = () => {
      const info = fs.lstatSync(directory);
      requireThat(
        info.isDirectory() &&
          info.dev === directoryInfo.dev &&
          info.ino === directoryInfo.ino &&
          fs.realpathSync(directory) === directory,
        "DIRECTORY_CHANGED",
      );
    };
    for (const asset of selected) {
      checkDirectory();
      const fd = fs.openSync(
        path.join(directory, asset.name),
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      let reader;
      try {
        const request = (url, headers) =>
          fetchImpl(url, {
            headers,
            signal: controller.signal,
            redirect: "manual",
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
        let response = await request(
          `https://api.github.com${base}/releases/assets/${asset.id}`,
          {
            Authorization: `Bearer ${token}`,
            Accept: "application/octet-stream",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        );
        if (response.status === 302) {
          let url;
          try {
            url = new URL(response.headers.get("location"));
          } catch {
            throw Error("RELEASE_CANDIDATE_ASSET_REDIRECT_INVALID");
          }
          requireThat(
            url.protocol === "https:" &&
              [
                "release-assets.githubusercontent.com",
                "objects.githubusercontent.com",
              ].includes(url.hostname) &&
              !url.username &&
              !url.password &&
              !url.port &&
              !url.hash &&
              /^https:\/\/(?:release-assets|objects)\.githubusercontent\.com\//u.test(
                response.headers.get("location"),
              ),
            "ASSET_REDIRECT_INVALID",
          );
          await response.body?.cancel();
          // Deliberately no Authorization, cookies or API headers on this request.
          response = await request(url.href, {});
        }
        requireThat(response.status === 200, `ASSET_HTTP_${response.status}`);
        const declared = response.headers.get("content-length");
        requireThat(
          declared === null || declared === String(asset.size),
          "ASSET_SIZE_MISMATCH",
        );
        requireThat(
          response.body &&
            (!response.headers.get("content-encoding") ||
              response.headers.get("content-encoding") === "identity"),
          "ASSET_RESPONSE_INVALID",
        );
        reader = response.body.getReader({ mode: "byob" });
        let count = 0;
        while (true) {
          // BYOB bounds each read to the metadata size plus one sentinel byte.
          const { done, value } = await reader.read(
            new Uint8Array(Math.min(65536, asset.size + 1 - count)),
          );
          if (done) break;
          count += value.byteLength;
          requireThat(
            count <= asset.size && count <= limits(identity).get(asset.name),
            "ASSET_SIZE_MISMATCH",
          );
          let offset = 0;
          while (offset < value.byteLength)
            offset += fs.writeSync(
              fd,
              value,
              offset,
              value.byteLength - offset,
            );
        }
        requireThat(count === asset.size, "ASSET_SIZE_MISMATCH");
        checkDirectory();
        const info = fs.fstatSync(fd),
          output = fs.lstatSync(path.join(directory, asset.name));
        requireThat(
          info.isFile() &&
            info.nlink === 1 &&
            info.size === asset.size &&
            output.isFile() &&
            output.dev === info.dev &&
            output.ino === info.ino,
          "ASSET_FILE_CHANGED",
        );
      } catch (error) {
        if (/^RELEASE_CANDIDATE_[A-Z0-9_]+$/u.test(error?.message ?? ""))
          throw error;
        throw Error("RELEASE_CANDIDATE_ASSET_TRANSPORT_UNKNOWN");
      } finally {
        controller.abort();
        clearTimeout(timer);
        // Cancellation cannot replace the original failure or trigger a retry.
        if (reader) await reader.cancel().catch(() => {});
        fs.closeSync(fd);
      }
    }
  } finally {
    fs.closeSync(directoryFd);
  }
}

async function main() {
  const mode = process.argv[2];
  requireThat(["prepare", "publish"].includes(mode), "MODE_INVALID");
  requireThat(
    process.env.GITHUB_REPOSITORY === repository,
    "REPOSITORY_INVALID",
  );
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const document = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const head = git("rev-parse", "HEAD");
  const identity = candidateIdentity(
    document,
    head,
    Number(process.env.GITHUB_RUN_ID),
    Number(process.env.GITHUB_RUN_ATTEMPT),
  );
  verifySource(identity, process.env.GITHUB_SHA, git);
  const event = JSON.parse(
    fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  if (mode === "prepare") {
    if (process.env.GITHUB_EVENT_NAME === "push") {
      requireThat(
        process.env.GITHUB_REF === `refs/tags/${identity.tag}`,
        "TAG_REF_INVALID",
      );
      verifyReleaseTag(identity.tag, git);
    } else
      requireThat(
        process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
          event.inputs?.action === "prepare",
        "PREPARE_EVENT_INVALID",
      );
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${identity.tag}\n`);
    return;
  }
  requireThat(
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      event.inputs?.action === "publish" &&
      [event.inputs.candidate_run_id, event.inputs.draft_release_id].every(
        (value) =>
          typeof value === "string" &&
          /^[1-9][0-9]*$/u.test(value) &&
          id(Number(value)),
      ),
    "PUBLISH_INPUT_INVALID",
  );
  requireThat(
    isDigest(event.inputs.manifest_sha256),
    "MANIFEST_DIGEST_REQUIRED",
  );
  const api = githubApi(process.env.GH_TOKEN);
  const readMetadata = async () => {
    const current = await api(
      `${base}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    );
    const run = await api(
      `${base}/actions/runs/${event.inputs.candidate_run_id}`,
    );
    requireThat(
      String(current.id) === process.env.GITHUB_RUN_ID &&
        String(current.run_attempt) === process.env.GITHUB_RUN_ATTEMPT &&
        String(run.id) === event.inputs.candidate_run_id,
      "RUN_REQUEST_MISMATCH",
    );
    const jobs = await api(
      `${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    );
    // Project only stable gate fields, never compare incidental API timing fields.
    const project = ({
      id,
      run_attempt,
      run_number,
      repository,
      head_repository,
      workflow_id,
      path,
      head_sha,
      head_branch,
      event,
      status,
      conclusion,
      updated_at,
      created_at,
    }) => ({
      id,
      run_attempt,
      run_number,
      repository: { id: repository?.id, full_name: repository?.full_name },
      head_repository: {
        id: head_repository?.id,
        full_name: head_repository?.full_name,
      },
      workflow_id,
      path,
      head_sha,
      head_branch,
      event,
      status,
      conclusion,
      updated_at,
      created_at,
    });
    const selected = project(current);
    // The active dispatch's timestamps/status can advance while it downloads.
    delete selected.updated_at;
    delete selected.status;
    delete selected.conclusion;
    return {
      current: selected,
      run: project(run),
      jobs: {
        total_count: jobs.total_count,
        jobs: jobs.jobs?.map(
          ({ name, run_id, run_attempt, head_sha, status, conclusion }) => ({
            name,
            run_id,
            run_attempt,
            head_sha,
            status,
            conclusion,
          }),
        ),
      },
      identity,
      expectedDigest: event.inputs.manifest_sha256,
    };
  };
  await publishCandidate({
    readMetadata,
    releaseId: Number(event.inputs.draft_release_id),
    directory: path.join(fs.realpathSync("."), "_qualified-release-assets"),
    dispatchSha: process.env.GITHUB_SHA,
    git,
    api,
    download: (assets, directory, identity) =>
      downloadDraftAssets(assets, directory, identity, process.env.GH_TOKEN),
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      /^RELEASE_(CANDIDATE|ASSET|ARCHIVE|CHECKSUMS|BUILD|TAG|REMOTE)_[A-Z0-9_]+$/u.test(
        error?.message ?? "",
      )
        ? error.message
        : "RELEASE_CANDIDATE_FAILED_UNKNOWN",
    );
    process.exitCode = 1;
  }
}
