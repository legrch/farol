import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  desktopEnvironment,
  desktopIdentity,
  ownerPreviewIdentity,
} from "../../src/apps/desktop/desktop-environment.ts";
import {
  assertOwnerPreviewSource,
  ownerPreviewArguments,
  ownerPreviewPlan,
} from "../../tooling/owner-preview-contract.mjs";

const { test } = await import(
  process.env.VITEST === "true" ? "vitest" : "node:test"
);

const commit = "a".repeat(40);
const source = { commit, dirty: false, treeDigest: "b".repeat(64) };
const observation = {
  expectedMain: commit,
  localMain: commit,
  trackedMain: commit,
  source,
};

// Pure contracts and Node-only refusal witnesses. No package, Electron,
// profile, provider, native helper or production filesystem is exercised.
test("fixed owner Preview identity remains distinct and inactive", () => {
  const appData = "/fixture/app-data";
  const owner = ownerPreviewIdentity(appData);
  assert.equal(owner.environment, "owner-preview");
  assert.equal(owner.applicationId, "local.farol.owner.preview");
  assert.equal(owner.displayName, "Farol Preview");
  assert.equal(owner.displayEdition, "");
  assert.equal(owner.userData, "/fixture/app-data/Farol Preview");
  assert.equal(owner.sessionData, owner.userData);
  assert.equal(owner.runtimePartition, "persist:farol-owner-preview-runtime");
  assert.equal(owner.chatGptPartition, "persist:farol-owner-preview-chatgpt");
  assert.equal(owner.runtimeIdentity, "farol-owner-preview-runtime");
  assert.equal(owner.runtimeServiceName, "Farol Preview Runtime");
  for (const environment of ["preview", "dev"]) {
    const existing = desktopIdentity(environment, appData);
    for (const key of [
      "applicationId",
      "userData",
      "sessionData",
      "runtimePartition",
      "chatGptPartition",
      "runtimeIdentity",
      "runtimeServiceName",
      "codexHome",
    ])
      assert.notEqual(owner[key], existing[key]);
  }
  assert.throws(
    () => desktopEnvironment("owner-preview"),
    /DESKTOP_ENVIRONMENT_INVALID/u,
  );
  for (const appData of ["relative", "\0/invalid"]) {
    assert.throws(
      () => ownerPreviewIdentity(appData),
      /DESKTOP_APP_DATA_INVALID/u,
    );
  }
});

test("commands require an explicit full accepted-main identity and reject profile flags", () => {
  for (const action of ["plan", "build", "run"]) {
    assert.deepEqual(
      ownerPreviewArguments([action, "--expected-main", commit]),
      {
        action,
        expectedMain: commit,
      },
    );
  }
  for (const args of [
    [],
    ["run"],
    ["run", "--expected-main", "main"],
    ["run", "--expected-main", commit, "--user-data-dir=/owner"],
    ["run", "--profile", commit],
    ["install", "--expected-main", commit],
    ["run", "--expected-main", "A".repeat(40)],
  ])
    assert.throws(() => ownerPreviewArguments(args), /Usage:/u);
});

test("source admission rejects dirty, stale, divergent and incomplete observations", () => {
  assert.doesNotThrow(() => assertOwnerPreviewSource(observation));
  for (const delta of [
    { expectedMain: undefined },
    { localMain: "c".repeat(40) },
    { trackedMain: "c".repeat(40) },
    { source: undefined },
    { source: { ...source, commit: "c".repeat(40) } },
    { source: { ...source, dirty: true } },
    { source: { ...source, dirty: undefined } },
    { source: { ...source, treeDigest: "invalid" } },
  ]) {
    assert.throws(
      () => assertOwnerPreviewSource({ ...observation, ...delta }),
      /OWNER_PREVIEW_CURRENT_MAIN_REQUIRED/u,
    );
  }
});

test("plan names the canonical base and stable output without claiming verification", () => {
  const plan = ownerPreviewPlan("/fixture/repository", observation);
  assert.equal(plan.base.command, "task package");
  assert.equal(
    plan.base.appPath,
    "/fixture/repository/_output/package/Farol.app",
  );
  assert.equal(
    plan.output.appPath,
    "/fixture/repository/_output/preview/Farol Preview.app",
  );
  assert.equal(plan.sourceCommit, commit);
  assert.equal(plan.sourceTreeDigest, source.treeDigest);
  assert.equal(plan.remoteFreshness, "not-checked-offline");
  assert.equal(plan.status, "blocked-runtime-integration");
  assert.equal(plan.packageVerified, false);
  assert.equal(plan.derivativeVerified, false);
  assert.equal(plan.launchAllowed, false);
});

test("build and run refuse before package, profile or Electron access", () => {
  for (const action of ["build", "run"]) {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../tooling/owner-preview.mjs", import.meta.url),
        ),
        action,
        "--expected-main",
        commit,
      ],
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 15000 },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, /OWNER_PREVIEW_RUNTIME_INTEGRATION_REQUIRED/u);
  }
});

test("task migration preserves the old development command explicitly", () => {
  const taskfile = fs.readFileSync(
    new URL("../../Taskfile.yml", import.meta.url),
    "utf8",
  );
  assert.match(taskfile, /preview:development:[\s\S]*?-- npm run preview/u);
  assert.match(taskfile, /preview:[\s\S]*?- task: preview:run/u);
  for (const action of ["plan", "build", "run"]) {
    assert.ok(
      taskfile.includes(`tooling/owner-preview.mjs ${action} {{.CLI_ARGS}}`),
    );
  }
});
