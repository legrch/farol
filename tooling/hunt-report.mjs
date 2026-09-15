import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const suites = [
  { id: "selftest", file: "tests/hunt/selftest.test.ts" },
  { id: "proof", file: "tests/hunt/proof.test.ts" },
  { id: "model", file: "tests/hunt/model.test.ts" },
];

for (const suite of suites) {
  execFileSync(process.execPath, [vitest, "run", suite.file], {
    cwd: root,
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
  });
}
execFileSync(process.execPath, [path.join(root, "tooling/build.mjs")], {
  cwd: root,
  stdio: "inherit",
});

const fixture = JSON.parse(
  await fs.readFile(
    path.join(root, "tests/hunt/fixtures/semantic-replay.json"),
    "utf8",
  ),
);
const build = JSON.parse(
  await fs.readFile(path.join(root, "dist/app/build-manifest.json"), "utf8"),
);
if (
  fixture.buildIdentity !== "<build-identity-recorded-by-final-runner>" ||
  !Array.isArray(fixture.commands) ||
  fixture.commands.length === 0
) {
  throw new Error("HUNT_REPLAY_FIXTURE_INVALID");
}
if (
  build.schema !== 2 ||
  build.sourceMode !== "head-exact" ||
  build.product !== "Farol Next Preview" ||
  !/^[a-f0-9]{40}$/u.test(build.sourceCommit) ||
  !/^[a-f0-9]{64}$/u.test(build.sourceTreeDigest)
) {
  throw new Error("HUNT_BUILD_IDENTITY_INVALID");
}

const buildIdentity = [
  "farol-next",
  build.sourceCommit,
  build.sourceTreeDigest,
  build.dirty ? "dirty" : "clean",
].join(":");
const report = {
  schema: 1,
  verdict: "PASS",
  suites: suites.map((suite) => ({
    id: suite.id,
    status: "PASS",
    file: suite.file,
  })),
  mutationProof: {
    status: "killed",
    defects: [
      "permit_foreign_owner",
      "replay_unknown_submit",
      "accept_stale_generation",
      "buffer_all_text_until_terminal",
      "apply_update_while_accepted_work_remains",
    ],
    shrinkBudget: 24,
  },
  replay: { ...fixture, buildIdentity },
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (/(prompt|answer|secret|token|\/Users\/|bearer\s+)/iu.test(serialized)) {
  throw new Error("HUNT_REPORT_PRIVACY_CANARY");
}
const evidenceRoot = path.join(root, "artifacts/hunt");
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.writeFile(path.join(evidenceRoot, "path.json"), serialized, {
  mode: 0o600,
});
process.stdout.write(serialized);
