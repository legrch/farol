import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDocument } from "yaml";

export function readWorkflow(file) {
  const document = parseDocument(fs.readFileSync(file, "utf8"), {
    uniqueKeys: true,
  });
  assert.equal(document.errors.length, 0, `${file}: invalid YAML`);
  return document.toJS();
}

export function assertDeliveryPolicy(policy, pr, release, setup) {
  assert.deepEqual(policy, {
    schema: 1,
    integration: "pr",
    defaultBranch: "main",
    mergeMethod: "merge",
    ci: "pull_request",
    release: "version-tag",
    deploy: "verified-tag",
    requiredChecks: ["changes", "checks", "portable", "native", "required"],
    releaseJobs: ["build", "publish"],
    tagPattern: "v*",
    versionSource: "package.json",
    prerelease: "version-channel",
  });
  assert.deepEqual(Object.keys(pr.on), [policy.ci]);
  assert.deepEqual(Object.keys(pr.on.pull_request), ["types"]);
  assert.deepEqual(pr.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
  ]);
  assert.deepEqual(Object.keys(pr.jobs), policy.requiredChecks);
  assert.deepEqual(Object.keys(release.on), ["push", "workflow_dispatch"]);
  assert.deepEqual(release.on.push, { tags: [policy.tagPattern] });
  const inputs = release.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), [
    "action",
    "candidate_run_id",
    "draft_release_id",
    "manifest_sha256",
  ]);
  assert.equal(inputs.action.required, true);
  assert.equal(inputs.action.type, "choice");
  assert.deepEqual(inputs.action.options, ["prepare", "publish"]);
  assert.equal(inputs.action.default, "prepare");
  for (const key of ["candidate_run_id", "draft_release_id", "manifest_sha256"])
    assert.equal(inputs[key].type, "string");
  assert.deepEqual(Object.keys(release.jobs), policy.releaseJobs);
  assert.equal(
    pr.concurrency.group,
    "pr-${{ github.event.pull_request.number }}",
  );
  assert.equal(pr.concurrency["cancel-in-progress"], true);
  assert.equal(release.concurrency.group, "tagged-prerelease");
  assert.equal(release.concurrency["cancel-in-progress"], false);
  for (const workflow of [pr, release]) {
    assert.deepEqual(workflow.permissions, { contents: "read" });
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (workflow === release && id === "publish")
        assert.deepEqual(job.permissions, {
          contents: "write",
          actions: "read",
        });
      else assert.equal(job.permissions, undefined);
      assert.ok(
        Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0,
      );
      assert.ok(["ubuntu-24.04", "macos-26"].includes(job["runs-on"]));
      for (const step of job.steps) {
        if (step.uses === "./.github/actions/setup-ci") continue;
        if (step.uses)
          assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/u);
        if (step.uses?.startsWith("actions/checkout@")) {
          assert.equal(step.with["fetch-depth"], 0);
          assert.equal(step.with["persist-credentials"], false);
        }
      }
    }
    assert.doesNotMatch(
      JSON.stringify(workflow),
      /secrets\.|pull_request_target|workflow_run/u,
    );
  }
  for (const step of setup.runs.steps)
    if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/u);
  const commands = (job) => job.steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands(pr.jobs.checks), /task scan:secrets/u);
  // Docs-only candidates skip only the heavy jobs, never the cheap checks.
  for (const check of [
    "typecheck",
    "lint",
    "format:check",
    "architecture",
    "runtime:check",
    "docs:check",
  ])
    assert.ok(commands(pr.jobs.checks).includes(`npm run ${check}\n`), check);
  // The skip decision comes from the base branch's classifier.
  const classify = commands(pr.jobs.changes);
  assert.ok(
    classify.includes('git show "$PR_BASE_SHA:tooling/ci-paths.mjs"'),
    "base classifier",
  );
  assert.doesNotMatch(classify, /node tooling\/ci-paths\.mjs/u);
  // Go comes from the verified official archive, never a toolcache SDK, and
  // caches hold downloads only, never the Go build cache.
  assert.ok(
    !setup.runs.steps.some((step) =>
      step.uses?.startsWith("actions/setup-go@"),
    ),
    "no setup-go",
  );
  const installGo = setup.runs.steps.find(
    (step) => step.name === "Install the official Go SDK",
  );
  assert.match(installGo?.run ?? "", /https:\/\/go\.dev\/dl\/\$archive/u);
  assert.match(installGo?.run ?? "", /shasum -a 256 -c -/u);
  for (const step of setup.runs.steps)
    if (step.uses?.startsWith("actions/cache@"))
      assert.doesNotMatch(String(step.with.path), /go-build|GOCACHE|_output/u);
  assert.match(commands(pr.jobs.checks), /delivery-policy\.test\.mjs/u);
  assert.match(commands(pr.jobs.portable), /task ci:cloud/u);
  assert.match(
    commands(pr.jobs.native),
    /scripts\/assert-owner-untouched\.py -- node tooling\/ci-native\.mjs/u,
  );
  assert.match(commands(pr.jobs.native), /task test:core/u);
  for (const name of ["portable", "native"]) {
    assert.equal(pr.jobs[name].needs, "changes");
    assert.equal(pr.jobs[name].if, "needs.changes.outputs.docs_only != 'true'");
  }
  assert.equal(pr.jobs.native["runs-on"], "macos-26");
  assert.equal(pr.jobs.required.if, "always()");
  assert.deepEqual(pr.jobs.required.needs, [
    "changes",
    "checks",
    "portable",
    "native",
  ]);
  assert.match(commands(pr.jobs.required), /test "\$PORTABLE" = success/u);
  assert.match(commands(pr.jobs.required), /test "\$NATIVE" = success/u);
  assert.equal(release.jobs.build["runs-on"], "macos-26");
  assert.equal(
    release.jobs.build.if,
    "github.event_name == 'push' || inputs.action == 'prepare'",
  );
  assert.equal(
    release.jobs.publish.if,
    "github.event_name == 'workflow_dispatch' && inputs.action == 'publish'",
  );
  assert.equal(release.jobs.publish.needs, undefined);
  const build = commands(release.jobs.build);
  assert.match(
    build,
    /refs\/tags\/\$RELEASE_TAG:refs\/farol\/published-release-tag/u,
  );
  assert.match(build, /node tooling\/release-candidate\.mjs prepare/u);
  assert.match(build, /tooling\/ci-go-inputs\.mjs/u);
  assert.match(build, /task ci\n/u);
  assert.match(build, /task package -- --go-inputs=/u);
  assert.match(build, /tooling\/prepare-release-archive\.py/u);
  assert.match(build, /tooling\/verify-release-assets\.mjs/u);
  // Release preparation must never transfer unqualified bytes through Actions
  // artifacts, caches, logs or a release fallback. Keep its exact step contract.
  assert.deepEqual(
    release.jobs.build.steps.map((step) => step.uses ?? step.name),
    [
      release.jobs.build.steps[0].uses,
      "Fetch the pushed tag object as published",
      "./.github/actions/setup-ci",
      "Verify exact release channel, source and accepted-main ancestry",
      "Provision approved backend build inputs",
      "Run the full unchanged source gate including secret scans",
      "Build the exact clean candidate",
      "D16 — Developer ID signing and notarization placeholder",
      "Prepare and verify the three public assets",
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(release),
    /actions\/(?:upload|download)-artifact|actions\/cache|gh release|curl|wget/u,
  );
  assert.doesNotMatch(build, /base64|cat |tee |git push/u);
  const publish = release.jobs.publish;
  assert.deepEqual(publish.steps.map((step) => step.run).filter(Boolean), [
    "node tooling/release-candidate.mjs publish",
  ]);
  assert.equal(publish.steps.length, 3);
  assert.ok(publish.steps[0].uses.startsWith("actions/checkout@"));
  assert.ok(publish.steps[1].uses.startsWith("actions/setup-node@"));
  assert.deepEqual(publish.steps[2].env, { GH_TOKEN: "${{ github.token }}" });
}

// The dry unstable build: read-only, unpublished, and limited to the three
// public release files in a short-lived workflow artifact.
export function assertUnstablePolicy(unstable) {
  assert.deepEqual(Object.keys(unstable.on), ["schedule", "workflow_dispatch"]);
  assert.equal(unstable.on.schedule.length, 1);
  assert.match(unstable.on.schedule[0].cron, /^\d+ \d+ \* \* \*$/u);
  assert.deepEqual(Object.keys(unstable.on.workflow_dispatch.inputs), [
    "force",
  ]);
  assert.equal(unstable.on.workflow_dispatch.inputs.force.type, "boolean");
  assert.equal(unstable.on.workflow_dispatch.inputs.force.default, false);
  assert.deepEqual(unstable.permissions, { contents: "read" });
  assert.equal(unstable.concurrency.group, "unstable-main");
  assert.equal(unstable.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(unstable.jobs), ["decide", "build"]);
  const { decide, build } = unstable.jobs;
  assert.equal(decide.if, "github.repository == 'legrch/farol'");
  assert.deepEqual(decide.permissions, { contents: "read", actions: "read" });
  assert.equal(build.permissions, undefined);
  assert.equal(build.needs, "decide");
  assert.equal(build.if, "needs.decide.outputs.build == 'true'");
  assert.equal(decide["runs-on"], "ubuntu-24.04");
  assert.equal(build["runs-on"], "macos-26");
  for (const job of [decide, build]) {
    assert.ok(
      Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0,
    );
    for (const step of job.steps) {
      if (step.uses === "./.github/actions/setup-ci") continue;
      if (step.uses)
        assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/u);
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with["fetch-depth"], 0);
        assert.equal(step.with["persist-credentials"], false);
      }
    }
  }
  assert.equal(decide.steps[0].with.ref, "${{ github.sha }}");
  assert.equal(
    build.steps[0].with.ref,
    "${{ needs.decide.outputs.source_sha }}",
  );
  const text = JSON.stringify(unstable);
  assert.doesNotMatch(
    text,
    /secrets\.|pull_request_target|workflow_run|"write"|id-token|attestations|gh release|releases|git push|git tag|actions\/cache|download-artifact|curl|wget|base64/u,
  );
  const decideStep = decide.steps.find((step) => step.id === "decide");
  assert.equal(decideStep.run, "node tooling/unstable-build.mjs decide");
  assert.deepEqual(decideStep.env, {
    GH_TOKEN: "${{ github.token }}",
    UNSTABLE_FORCE: "${{ inputs.force == true }}",
  });
  const commands = build.steps.map((step) => step.run ?? "").join("\n");
  for (const gate of [
    'merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main',
    "node tooling/release-preflight.mjs",
    "node tooling/ci-go-inputs.mjs",
    "task ci\n",
    "task package -- --go-inputs=",
    "tooling/prepare-release-archive.py",
    "tooling/verify-release-assets.mjs",
  ])
    assert.ok(commands.includes(gate), gate);
  assert.ok(
    commands.indexOf("task ci\n") < commands.indexOf("task package"),
    "source gate before package",
  );
  const uploads = build.steps.filter((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(uploads.length, 1);
  const upload = uploads[0].with;
  assert.deepEqual(upload.path.trim().split("\n"), [
    "_output/release/unstable/Farol-${{ steps.source.outputs.version }}-darwin-arm64.zip",
    "_output/release/unstable/farol-release.json",
    "_output/release/unstable/SHA256SUMS",
  ]);
  assert.equal(upload["if-no-files-found"], "error");
  assert.ok(upload["retention-days"] > 0 && upload["retention-days"] <= 7);
  assert.equal(upload.overwrite, false);
}
