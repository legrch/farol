// Explicit built-core discovery only. Synthetic retained profiles; no Electron,
// provider, original child/host closure, preparation or writable restart.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import { buildSync } from "esbuild";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { qualifyGoBuild } from "./qualified-go-build.mjs";

async function run() {
  assert.equal(process.platform, "darwin");
  assert.equal(process.argv.length, 3);
  const root = process.cwd();
  const artifactRoot = path.join(root, "_output/build/app");
  const build = await qualifyGoBuild(artifactRoot, sourceIdentity(root));
  const fixture = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  assert.equal(fixture.schema, "farol.preserved-discovery-native/1");
  const output = path.join(root, "_output/tests/preserved-discovery-child.cjs");
  await fs.mkdir(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [
      path.join(root, "apps/desktop/bridge/preserved-inspection-child.ts"),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const { discoverPreservedRecoveryChild } = createRequire(import.meta.url)(
    output,
  );
  const selected = fixture.input.Selection;
  const profile = {
    profileId: fixture.profile.ProfileID,
    root: fixture.profile.Root,
    home: fixture.home,
    device: String(fixture.profile.Device),
    inode: String(fixture.profile.Inode),
  };
  const original = structuredClone(fixture.input);
  const result = await discoverPreservedRecoveryChild(
    path.join(artifactRoot, build.manifest.core.binary.path),
    profile,
    fixture.input,
    {
      buildId: build.identity.buildId,
      operationId: selected.OperationID,
      current: structuredClone(selected.Current),
      hostLifetimeId: selected.HostLifetimeID,
      childLaunchId: selected.ChildLaunchID,
      backendGeneration: selected.Next.BackendGeneration,
    },
  );
  assert.deepEqual(result.Selection, fixture.expected);
  assert.deepEqual(fixture.input, original);
  assert(Object.isFrozen(result.Selection.Current.Scope));
  const after = await qualifyGoBuild(artifactRoot, sourceIdentity(root));
  assert.equal(after.identity.buildId, build.identity.buildId);
  assert.equal(
    after.manifest.core.binary.sha256,
    build.manifest.core.binary.sha256,
  );
  process.stdout.write(
    `${JSON.stringify({
      schema: fixture.schema,
      phase: "observed",
      buildId: build.identity.buildId,
      sourceCommit: build.manifest.sourceCommit,
      selection: result.Selection,
    })}\n`,
  );
}

try {
  await run();
} catch (error) {
  const code =
    typeof error?.code === "string" && /^[A-Za-z0-9_]{1,100}$/u.test(error.code)
      ? error.code
      : "unclassified";
  process.stderr.write(`PRESERVED_DISCOVERY_NATIVE_UNCONFIRMED:${code}\n`);
  process.exitCode = 1;
}
