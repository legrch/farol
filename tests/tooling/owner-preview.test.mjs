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
  requireOwnerPreviewRuntimeIntegration,
  PREVIEW_LAUNCHER,
  generationFromLink,
  previewLinkTarget,
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
  remoteMain: commit,
  source,
};

// Pure contracts and Node-only refusal witnesses; never package/Electron/native.
test("default commands need no SHA and optional assertions remain strict", () => {
  for (const action of ["plan", "build", "run", "build-run"]) {
    assert.deepEqual(ownerPreviewArguments([action]), {
      action,
      expectedMain: undefined,
    });
    assert.deepEqual(
      ownerPreviewArguments([action, "--expected-main", commit]),
      { action, expectedMain: commit },
    );
  }
  for (const args of [
    [],
    ["install"],
    ["run", "--expected-main", "main"],
    ["run", "--profile", commit],
    ["run", "--expected-main", commit, "--hidden"],
    ["run", "--expected-main", "A".repeat(40)],
    ["run", "--go-inputs=/tmp/inputs"],
  ])
    assert.throws(() => ownerPreviewArguments(args), /Usage:/u);
});

test("source admission requires clean HEAD and all three current main observations", () => {
  assert.doesNotThrow(() =>
    assertOwnerPreviewSource({ ...observation, expectedMain: undefined }),
  );
  for (const delta of [
    { expectedMain: "c".repeat(40) },
    { localMain: "c".repeat(40) },
    { trackedMain: "c".repeat(40) },
    { remoteMain: undefined },
    { remoteMain: "c".repeat(40) },
    { source: undefined },
    { source: { ...source, commit: "c".repeat(40) } },
    { source: { ...source, dirty: true } },
    { source: { ...source, dirty: undefined } },
    { source: { ...source, treeDigest: "invalid" } },
  ])
    assert.throws(
      () => assertOwnerPreviewSource({ ...observation, ...delta }),
      /OWNER_PREVIEW_CURRENT_MAIN_REQUIRED/u,
    );
});

test("fixed Preview identity stays distinct and rejects malformed app-data paths", () => {
  const appData = "/fixture/app-data";
  const owner = ownerPreviewIdentity(appData);
  assert.equal(owner.environment, "owner-preview");
  assert.equal(owner.applicationId, "local.farol.owner.preview");
  assert.equal(owner.displayName, "Farol Preview");
  assert.equal(owner.userData, "/fixture/app-data/Farol Preview");
  assert.equal(owner.sessionData, owner.userData);
  assert.equal(owner.runtimePartition, "persist:farol-owner-preview-runtime");
  assert.equal(owner.chatGptPartition, "persist:farol-owner-preview-chatgpt");
  assert.equal(owner.runtimeIdentity, "farol-owner-preview-runtime");
  assert.equal(owner.runtimeServiceName, "Farol Preview Runtime");
  for (const existing of ["preview", "dev"]) {
    const other = desktopIdentity(existing, appData);
    for (const key of [
      "applicationId",
      "userData",
      "sessionData",
      "codexHome",
      "runtimePartition",
      "chatGptPartition",
      "runtimeIdentity",
      "runtimeServiceName",
    ])
      assert.notEqual(owner[key], other[key]);
  }
  for (const invalid of ["relative", "\0/invalid"])
    assert.throws(
      () => ownerPreviewIdentity(invalid),
      /DESKTOP_APP_DATA_INVALID/u,
    );
});

test("runtime admission follows the actual parser and private-home contract", () => {
  let admitted;
  try {
    admitted = desktopEnvironment("owner-preview");
  } catch {
    admitted = null;
  }
  if (admitted === null)
    assert.throws(
      requireOwnerPreviewRuntimeIntegration,
      /OWNER_PREVIEW_RUNTIME_INTEGRATION_REQUIRED/u,
    );
  else {
    assert.equal(admitted, "owner-preview");
    assert.deepEqual(
      requireOwnerPreviewRuntimeIntegration(),
      ownerPreviewIdentity("/__farol_preview_contract__/app-data"),
    );
  }
});

test("plan states verification limits and names the untouched canonical input", () => {
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
  assert.equal(plan.remoteFreshness, "bounded-origin-main-read");
  assert.equal(plan.sourceCommit, commit);
  assert.equal(plan.packageVerified, false);
  assert.equal(plan.derivativeVerified, false);
  assert.equal(plan.launchAllowed, false);
});

test("unaccepted source or runtime refusal happens before package or profile effects", () => {
  for (const action of ["build", "run", "build-run"]) {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../tooling/owner-preview.mjs", import.meta.url),
        ),
        action,
        "--expected-main",
        "0".repeat(40),
      ],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 15000,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.match(
      child.stderr,
      /OWNER_PREVIEW_(RUNTIME_INTEGRATION_REQUIRED|CURRENT_MAIN_REQUIRED)/u,
    );
  }
});

test("fixed launcher strips inherited hooks, fixes marker, and rejects caller flags", () => {
  assert.match(PREVIEW_LAUNCHER, /exec \/usr\/bin\/env -i/u);
  assert.match(PREVIEW_LAUNCHER, /FAROL_NEXT_ENVIRONMENT=owner-preview/u);
  assert.match(PREVIEW_LAUNCHER, /\[ "\$#" -eq 0 \]/u);
  assert.ok(!PREVIEW_LAUNCHER.includes('"$@"'));
  for (const hook of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "ELECTRON_RUN_AS_NODE",
    "CODEX_HOME",
    "FAROL_NEXT_E2E",
  ])
    assert.ok(!PREVIEW_LAUNCHER.includes(hook));
});

test("current links admit exactly one relative immutable generation", () => {
  const generation = "a".repeat(64);
  assert.equal(generationFromLink(previewLinkTarget(generation)), generation);
  for (const target of [
    "/tmp/Farol Preview.app",
    `generations/../${generation}/Farol Preview.app`,
    `generations/${generation}/Farol.app`,
    `generations/${generation.toUpperCase()}/Farol Preview.app`,
    `generations/${generation}/.canonical/Farol.app`,
  ])
    assert.throws(
      () => generationFromLink(target),
      /OWNER_PREVIEW_CURRENT_LINK_INVALID/u,
    );
});

test("Task and npm migrations preserve an explicitly named development caller", () => {
  const tasks = fs.readFileSync(
    new URL("../../Taskfile.yml", import.meta.url),
    "utf8",
  );
  assert.match(tasks, /preview:development:[\s\S]*?-- npm run preview\n/u);
  for (const action of ["plan", "build", "run", "build-run"])
    assert.ok(
      tasks.includes(`tooling/owner-preview.mjs ${action} {{.CLI_ARGS}}`),
    );
  const { scripts } = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(scripts.preview, "electron _output/build/app/main.cjs");
  assert.equal(
    scripts["preview:owner"],
    "node tooling/owner-preview.mjs build-run",
  );
  assert.equal(
    scripts["preview:development"],
    "electron _output/build/app/main.cjs",
  );
});
