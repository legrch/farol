// The promotion CLI as a child process, for promote-preview-cli.test.mjs.
//
// Runs `runPromotionCli` exactly as the script entry in
// `tooling/promote-preview.mjs` does — same option parsing, same lease,
// same drain check, same placement, same receipt, same exit status and
// refusal line — with the four seams a test needs: a throwaway candidate
// root, a throwaway home, a source identity read from the fixture manifest,
// and a verifier that checks the candidate's tree digest instead of
// running `verify-package.mjs`. The real entry's own checks (exact clean
// HEAD bytes, a sealed Electron package, the owner's real home and profile)
// cannot be satisfied from a test, so what this proves is the composition,
// not those checks; the test spawns the real entry separately for what it
// can prove there. Not a vitest file: its name does not match `*.test.*`.
import fs from "node:fs/promises";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { runPromotionCli } from "../../tooling/promote-preview.mjs";

const fixtureIndex = process.argv.indexOf("--fixture");
if (fixtureIndex === -1) {
  process.stderr.write(
    "promote-preview fixture entry needs --fixture <file>\n",
  );
  process.exit(2);
}
const fixture = JSON.parse(
  await fs.readFile(process.argv[fixtureIndex + 1], "utf8"),
);
const cliArguments = [
  ...process.argv.slice(2, fixtureIndex),
  ...process.argv.slice(fixtureIndex + 2),
];

process.exitCode = await runPromotionCli(cliArguments, {
  home: fixture.home,
  candidateRoot: fixture.candidateRoot,
  sourceIdentity: () => fixture.sourceIdentity,
  verify: async (artifactFile, appPath) => {
    const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
    const digest = await treeDigest(appPath);
    return digest === artifact.artifactSha256
      ? { status: 0, output: "" }
      : { status: 1, output: `FIXTURE_DIGEST_MISMATCH:${digest}` };
  },
  // The run marker's boot probe: the fixture's markers are written with
  // this same instant, so "same boot" is decided by the test, not by a
  // machine whose uptime a sandbox may refuse to report.
  activation: { bootTime: fixture.bootTime },
});
