import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { treeDigest } from "./artifact-digest.mjs";
import { assertBuildIdentity } from "./build-identity-contract.mjs";

const [slot] = process.argv.slice(2);
if (!slot || !path.isAbsolute(slot) || process.argv.length !== 3)
  throw new Error("UPDATE_SLOT_INVALID");
const digest = await treeDigest(slot);
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
// Bind the measured plist to the validated embedded identity before either
// discovery or a helper handoff may use this installed build as its baseline.
const plist = path.join(slot, "Contents/Info.plist");
for (const [key, expected] of [
  ["CFBundleIdentifier", identity.bundleId],
  ["CFBundleShortVersionString", identity.version.split("-", 1)[0]],
  ["CFBundleVersion", identity.buildVersion],
]) {
  const measured = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plist],
    { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
  ).trim();
  if (!expected || measured !== expected)
    throw new Error("UPDATE_SLOT_IDENTITY_INVALID");
}
if ((await treeDigest(slot)) !== digest) throw new Error("UPDATE_SLOT_CHANGED");
process.stdout.write(
  JSON.stringify({
    digest,
    version: identity.version,
    buildId: identity.buildId,
  }),
);
