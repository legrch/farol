import fs from "node:fs/promises";
import path from "node:path";
import { treeDigest } from "./artifact-digest.mjs";
import { assertBuildIdentity } from "./build-identity-contract.mjs";

const [slot] = process.argv.slice(2);
if (!slot || !path.isAbsolute(slot) || process.argv.length !== 3)
  throw new Error("UPDATE_SLOT_INVALID");
const identity = assertBuildIdentity(
  JSON.parse(
    await fs.readFile(
      path.join(slot, "Contents/Resources/app/build-identity.json"),
      "utf8",
    ),
  ),
);
if (identity.sourceDirty || identity.bundleId !== "local.farol.next.preview")
  throw new Error("UPDATE_SLOT_IDENTITY_INVALID");
process.stdout.write(
  JSON.stringify({
    digest: await treeDigest(slot),
    version: identity.version,
    buildId: identity.buildId,
  }),
);
