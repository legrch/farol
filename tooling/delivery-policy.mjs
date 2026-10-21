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
    prerelease: true,
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
  assert.deepEqual(release.on, { push: { tags: [policy.tagPattern] } });
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
        assert.deepEqual(job.permissions, { contents: "write" });
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
  assert.equal(release.jobs.publish.needs, "build");
  const build = commands(release.jobs.build);
  assert.match(build, /tooling\/verify-release-tag\.mjs/u);
  assert.match(build, /tooling\/ci-go-inputs\.mjs/u);
  assert.match(build, /task ci\n/u);
  assert.match(build, /task package -- --go-inputs=/u);
  assert.match(build, /tooling\/prepare-release-archive\.py/u);
  const upload = release.jobs.build.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload);
  assert.deepEqual(upload.with.path.trim().split("\n"), [
    "_output/release/${{ github.ref_name }}/Farol-*-darwin-arm64.zip",
    "_output/release/${{ github.ref_name }}/farol-release.json",
    "_output/release/${{ github.ref_name }}/SHA256SUMS",
  ]);
  const publish = commands(release.jobs.publish);
  assert.match(publish, /tooling\/verify-release-tag\.mjs/u);
  assert.match(publish, /tooling\/verify-release-assets\.mjs/u);
  assert.match(publish, /gh release create/u);
  for (const flag of ["--verify-tag", "--prerelease", "--latest=false"])
    assert.ok(publish.includes(flag));
  assert.doesNotMatch(publish, /--clobber|gh release (?:upload|edit|delete)/u);
}
