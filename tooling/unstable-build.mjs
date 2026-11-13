// Dry unstable build helpers for .github/workflows/unstable.yml. They decide
// whether main changed since the last successful unstable run and render the
// job summary. Nothing here creates a tag, release, draft or publication.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const UNSTABLE_REPOSITORY = "legrch/farol";
export const UNSTABLE_WORKFLOW = ".github/workflows/unstable.yml";
const sha = /^[a-f0-9]{40}$/u;
const runId = (value) => Number.isSafeInteger(value) && value > 0;

function requireThat(condition, reason) {
  if (!condition) throw Error(`UNSTABLE_${reason}`);
}

// Every successful run either built its head or skipped because its head
// equalled an earlier built head, so the newest successful main run's head is
// the last built commit. Runs on other branches, other workflows, other
// repositories and the current run are never evidence.
export function decideUnstableBuild({ head, currentRunId, runs, force }) {
  requireThat(sha.test(head ?? ""), "HEAD_INVALID");
  requireThat(runId(currentRunId), "RUN_INVALID");
  requireThat(Array.isArray(runs), "RUNS_INVALID");
  const previous = runs.find(
    (run) =>
      run?.id !== currentRunId &&
      runId(run?.id) &&
      run.repository?.full_name === UNSTABLE_REPOSITORY &&
      run.path === UNSTABLE_WORKFLOW &&
      run.head_branch === "main" &&
      ["schedule", "workflow_dispatch"].includes(run.event) &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      sha.test(run.head_sha ?? ""),
  );
  const last = previous
    ? { previousSha: previous.head_sha, previousRunId: previous.id }
    : { previousSha: "", previousRunId: 0 };
  if (force === true) return { build: true, reason: "forced", ...last };
  if (!previous) return { build: true, reason: "no-previous-success", ...last };
  if (previous.head_sha === head)
    return { build: false, reason: "unchanged", ...last };
  return { build: true, reason: "changed", ...last };
}

export function renderDecision(decision, head) {
  const lines = [
    "## Unstable dry build: change check",
    "",
    `- main HEAD: \`${head}\``,
    `- Last successful unstable run: ${
      decision.previousRunId
        ? `${decision.previousRunId} at \`${decision.previousSha}\``
        : "none found"
    }`,
    `- Decision: **${decision.build ? "build" : "skip"}** (${decision.reason})`,
  ];
  if (!decision.build)
    lines.push(
      "",
      "main has not changed since the last successful unstable build; nothing to do.",
    );
  return `${lines.join("\n")}\n`;
}

// Public release metadata only: the three asset files and step timings.
export function renderBuildSummary({ manifest, checksums, durations }) {
  const lines = ["## Unstable dry build", ""];
  if (manifest) {
    lines.push(
      "| Field | Value |",
      "| --- | --- |",
      `| Source commit | \`${manifest.sourceCommit}\` |`,
      `| Version | \`${manifest.version}\` |`,
      `| Build version | \`${manifest.buildVersion}\` |`,
      `| Channel (baked into the bytes) | \`${manifest.channel}\` |`,
      `| Build ID | \`${manifest.buildId}\` |`,
      `| Source tree digest | \`${manifest.sourceTreeDigest}\` |`,
      `| App tree digest (artifactSha256) | \`${manifest.artifactSha256}\` |`,
      `| Archive | \`${manifest.archiveName}\`, ${manifest.archiveSize} bytes |`,
      `| Archive SHA-256 | \`${manifest.archiveSha256}\` |`,
      `| Signing | ${manifest.signing}, notarized: ${manifest.notarized} |`,
    );
    if (checksums) lines.push(`| SHA256SUMS | \`${checksums.trim()}\` |`);
    lines.push(
      "",
      "Dry mode: these bytes are unqualified, published nowhere and not uploaded; they stay on the runner. The version and build version are the committed ones, so they can collide with an already published release of the same version; never publish or install these bytes as that release.",
    );
  } else lines.push("No release assets were produced.");
  if (durations.length) {
    lines.push("", "| Step | Seconds |", "| --- | ---: |");
    for (const [name, seconds] of durations)
      lines.push(`| ${name} | ${seconds} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseDurations(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, seconds] = line.split("\t");
      requireThat(
        typeof name === "string" &&
          name.length > 0 &&
          /^[0-9]+$/u.test(seconds ?? ""),
        "DURATIONS_INVALID",
      );
      return [name, Number(seconds)];
    });
}

async function listRuns(token, fetchImpl = fetch) {
  requireThat(typeof token === "string" && token.length > 0, "TOKEN_REQUIRED");
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${UNSTABLE_REPOSITORY}/actions/workflows/unstable.yml/runs?branch=main&status=success&per_page=30`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      },
    );
  } catch {
    throw Error("UNSTABLE_GITHUB_TRANSPORT_UNKNOWN");
  }
  requireThat(response.ok, `GITHUB_HTTP_${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw Error("UNSTABLE_GITHUB_RESPONSE_INVALID");
  }
  requireThat(Array.isArray(body?.workflow_runs), "GITHUB_RESPONSE_INVALID");
  return body.workflow_runs;
}

function appendFile(file, text, reason) {
  requireThat(typeof file === "string" && file.length > 0, reason);
  fs.appendFileSync(file, text);
}

async function decide(env) {
  requireThat(
    env.GITHUB_REPOSITORY === UNSTABLE_REPOSITORY,
    "REPOSITORY_INVALID",
  );
  requireThat(env.GITHUB_REF === "refs/heads/main", "REF_NOT_MAIN");
  requireThat(
    ["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
    "EVENT_INVALID",
  );
  const head = env.GITHUB_SHA;
  const decision = decideUnstableBuild({
    head,
    currentRunId: Number(env.GITHUB_RUN_ID),
    runs: await listRuns(env.GH_TOKEN),
    force: env.UNSTABLE_FORCE === "true",
  });
  appendFile(
    env.GITHUB_OUTPUT,
    `build=${decision.build}\nreason=${decision.reason}\nsource_sha=${head}\n`,
    "OUTPUT_REQUIRED",
  );
  appendFile(
    env.GITHUB_STEP_SUMMARY,
    renderDecision(decision, head),
    "SUMMARY_REQUIRED",
  );
  console.log(
    decision.build
      ? `Unstable build required (${decision.reason}) for ${head}.`
      : `Skipping: main ${head} is unchanged since successful unstable run ${decision.previousRunId}.`,
  );
}

function readOptional(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function summary(env, [assetDirectory, durationsFile]) {
  requireThat(
    typeof assetDirectory === "string" && typeof durationsFile === "string",
    "SUMMARY_ARGUMENTS_REQUIRED",
  );
  const manifestText = readOptional(
    path.join(assetDirectory, "farol-release.json"),
  );
  const markdown = renderBuildSummary({
    manifest: manifestText === null ? null : JSON.parse(manifestText),
    checksums: readOptional(path.join(assetDirectory, "SHA256SUMS")),
    durations: parseDurations(readOptional(durationsFile) ?? ""),
  });
  appendFile(env.GITHUB_STEP_SUMMARY, markdown, "SUMMARY_REQUIRED");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === "decide") await decide(process.env);
    else if (mode === "summary") summary(process.env, rest);
    else throw Error("UNSTABLE_MODE_INVALID");
  } catch (error) {
    console.error(
      /^UNSTABLE_[A-Z0-9_]+$/u.test(error?.message ?? "")
        ? error.message
        : "UNSTABLE_FAILED_UNKNOWN",
    );
    process.exitCode = 1;
  }
}
