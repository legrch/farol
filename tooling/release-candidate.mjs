// Two-phase handoff only. This is not a native/owner qualification authority.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { releaseBuildFields } from "./release-identity.mjs";
import { verifyReleaseAssets } from "./verify-release-assets.mjs";
import { verifyReleaseTag } from "./verify-release-tag.mjs";

const repository = "legrch/farol";
const workflow = ".github/workflows/release.yml";
const sha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const isDigest = (value) => typeof value === "string" && digest.test(value);
const id = (value) => Number.isSafeInteger(value) && value > 0;
function requireThat(condition, reason) {
  if (!condition) throw Error(`RELEASE_CANDIDATE_${reason}`);
}
export function candidateIdentity(document, head, runId, attempt) {
  requireThat(
    releaseBuildFields(document).updateChannel === "github-owner-beta",
    "OWNER_BETA_REQUIRED",
  );
  requireThat(sha.test(head) && id(runId) && id(attempt), "IDENTITY_INVALID");
  return {
    version: document.version,
    tag: `v${document.version}`,
    head,
    artifactName: `farol-public-${runId}-${attempt}-${head}`,
  };
}

// Only GitHub's run/job/artifact metadata is accepted here, never a manifest's
// claim about its producer. A successful build + skipped publisher distinguishes
// a prepare dispatch from a publish dispatch in this exact workflow/source.
export function validateCandidate({
  current,
  run,
  jobs,
  artifacts,
  identity,
  expectedDigest,
  now = Date.now(),
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
      ["push", "workflow_dispatch"].includes(run.event) &&
      (run.event !== "push" || run.head_branch === identity.tag),
    "PRIOR_SUCCESSFUL_PREPARATION_REQUIRED",
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
  requireThat(
    artifacts?.total_count === 1 && artifacts.artifacts?.length === 1,
    "ARTIFACT_SET_INVALID",
  );
  const artifact = artifacts.artifacts[0];
  requireThat(
    id(artifact.id) &&
      artifact.name === identity.artifactName &&
      artifact.expired === false &&
      id(artifact.size_in_bytes) &&
      Number.isFinite(Date.parse(artifact.expires_at)) &&
      Date.parse(artifact.expires_at) > now &&
      artifact.workflow_run?.id === run.id &&
      artifact.workflow_run?.head_sha === identity.head &&
      artifact.workflow_run?.repository_id === current.repository.id &&
      artifact.workflow_run?.head_repository_id === current.repository.id,
    "ARTIFACT_IDENTITY_INVALID",
  );
  return artifact.id;
}

export async function verifyCandidateAssets(
  directory,
  identity,
  expectedDigest,
) {
  requireThat(isDigest(expectedDigest), "MANIFEST_DIGEST_REQUIRED");
  const manifestPath = path.join(directory, "farol-release.json");
  const stat = fs.lstatSync(manifestPath);
  requireThat(
    stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= 16384,
    "MANIFEST_INVALID",
  );
  requireThat(
    createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex") ===
      expectedDigest,
    "MANIFEST_DIGEST_MISMATCH",
  );
  // Unlike offline producer output, a downloaded artifact has no private folder.
  requireThat(
    fs.readdirSync(directory).sort().join("\n") ===
      [
        `Farol-${identity.version}-darwin-arm64.zip`,
        "SHA256SUMS",
        "farol-release.json",
      ]
        .sort()
        .join("\n"),
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

// GET absence must be an actual HTTP 404. Authentication, transport and all
// other errors remain terminal. Existing tags must be annotated and exact.
export async function publicationPreconditions(api, identity) {
  const base = `/repos/${repository}`;
  requireThat(
    (await api(`${base}/releases/tags/${identity.tag}`, { absent: true })) ===
      null,
    "RELEASE_EXISTS",
  );
  // Tag lookup alone does not establish draft absence. Authenticated listing
  // includes drafts. Refuse incomplete pagination instead of assuming absence.
  const releases = await api(`${base}/releases?per_page=100`);
  requireThat(
    Array.isArray(releases) && releases.length < 100,
    "RELEASE_LIST_INCOMPLETE",
  );
  requireThat(
    releases.every(
      (item) =>
        typeof item.tag_name === "string" && item.tag_name !== identity.tag,
    ),
    "RELEASE_EXISTS",
  );
  const ref = await api(`${base}/git/ref/tags/${identity.tag}`, {
    absent: true,
  });
  if (ref === null) return false;
  requireThat(
    ref.ref === `refs/tags/${identity.tag}` &&
      ref.object?.type === "tag" &&
      sha.test(ref.object.sha),
    "TAG_NOT_ANNOTATED",
  );
  const tag = await api(`${base}/git/tags/${ref.object.sha}`);
  requireThat(
    tag.sha === ref.object.sha &&
      tag.tag === identity.tag &&
      tag.object?.type === "commit" &&
      tag.object.sha === identity.head,
    "TAG_SOURCE_MISMATCH",
  );
  return true;
}

export async function publishCandidate({
  metadata,
  directory,
  dispatchSha,
  git,
  api,
  release,
}) {
  validateCandidate(metadata);
  verifySource(metadata.identity, dispatchSha, git);
  const files = await verifyCandidateAssets(
    directory,
    metadata.identity,
    metadata.expectedDigest,
  );
  const tagged = await publicationPreconditions(api, metadata.identity);
  // No effect is reachable until every metadata/source/asset/precondition gate passes.
  const { tag, head } = metadata.identity;
  if (!tagged) {
    const object = await api(`/repos/${repository}/git/tags`, {
      body: { tag, message: `Farol ${tag}`, object: head, type: "commit" },
    });
    requireThat(sha.test(object.sha), "TAG_RESPONSE_INVALID");
    await api(`/repos/${repository}/git/refs`, {
      body: { ref: `refs/tags/${tag}`, sha: object.sha },
    });
  }
  await release(
    tag,
    files.map((file) => path.join(directory, file)),
  );
}

function githubApi(token) {
  return async (endpoint, { absent = false, body } = {}) => {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method: body ? "POST" : "GET",
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
    if (absent && response.status === 404) return null;
    requireThat(response.ok, `GITHUB_HTTP_${response.status}`);
    return response.json();
  };
}

async function main() {
  const mode = process.argv[2];
  requireThat(
    ["prepare", "metadata", "publish"].includes(mode),
    "MODE_INVALID",
  );
  requireThat(
    process.env.GITHUB_REPOSITORY === repository,
    "REPOSITORY_INVALID",
  );
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", timeout: 30000 }).trim();
  const document = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const head = git("rev-parse", "HEAD");
  const output = (key, value) =>
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  if (mode === "prepare") {
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
    for (const key of ["version", "tag", "artifactName"])
      output(key, identity[key]);
    return;
  }
  requireThat(
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "PUBLISH_EVENT_INVALID",
  );
  const event = JSON.parse(
    fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  requireThat(
    event.inputs?.action === "publish" &&
      /^[1-9][0-9]*$/u.test(event.inputs.candidate_run_id ?? ""),
    "PUBLISH_INPUT_INVALID",
  );
  requireThat(
    isDigest(event.inputs.manifest_sha256),
    "MANIFEST_DIGEST_REQUIRED",
  );
  const api = githubApi(process.env.GH_TOKEN);
  const base = `/repos/${repository}/actions/runs`;
  const current = await api(`${base}/${process.env.GITHUB_RUN_ID}`);
  const run = await api(`${base}/${event.inputs.candidate_run_id}`);
  requireThat(
    String(current.id) === process.env.GITHUB_RUN_ID &&
      String(current.run_attempt) === process.env.GITHUB_RUN_ATTEMPT &&
      String(run.id) === event.inputs.candidate_run_id,
    "RUN_REQUEST_MISMATCH",
  );
  const identity = candidateIdentity(document, head, run.id, run.run_attempt);
  const jobs = await api(
    `${base}/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  const artifacts = await api(`${base}/${run.id}/artifacts?per_page=100`);
  const metadata = {
    current,
    run,
    jobs,
    artifacts,
    identity,
    expectedDigest: event.inputs.manifest_sha256,
  };
  const artifactId = validateCandidate(metadata);
  verifySource(identity, process.env.GITHUB_SHA, git);
  if (mode === "metadata") {
    output("artifactId", artifactId);
    return;
  }
  requireThat(
    String(artifactId) === process.env.CANDIDATE_ARTIFACT_ID,
    "ARTIFACT_CHANGED",
  );
  await publishCandidate({
    metadata,
    directory: "_output/public-release",
    dispatchSha: process.env.GITHUB_SHA,
    git,
    api,
    release: (tag, files) =>
      execFileSync(
        "gh",
        [
          "release",
          "create",
          tag,
          "--repo",
          repository,
          "--verify-tag",
          "--prerelease",
          "--latest=false",
          "--title",
          `Farol ${tag} (unsigned prerelease)`,
          "--notes",
          "Unsigned and not notarized (D16). Published exact prepared assets after Lead qualification; the manifest digest binds bytes and does not prove native or owner acceptance.",
          ...files,
        ],
        { stdio: "inherit", timeout: 120000 },
      ),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
