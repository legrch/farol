// Check only the public handoff. The existing archive producer owns package
// authentication, extraction and physical identity verification.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function regular(file, maximum) {
  const info = fs.lstatSync(file);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size <= 0 ||
    info.size > maximum
  )
    throw Error("RELEASE_ASSET_FILE_INVALID");
  return info;
}

export async function verifyReleaseAssets(directory, { version, head }) {
  const manifestPath = path.join(directory, "farol-release.json");
  regular(manifestPath, 16384);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const archive = `Farol-${version}-darwin-arm64.zip`;
  if (
    manifest.schema !== "farol.github-release/1" ||
    manifest.repository !== "legrch/farol" ||
    manifest.version !== version ||
    manifest.sourceCommit !== head ||
    manifest.sourceDirty !== false ||
    manifest.platform !== "darwin" ||
    manifest.arch !== "arm64" ||
    manifest.signing !== "unsigned" ||
    manifest.notarized !== false ||
    manifest.archiveName !== archive ||
    !/^[a-f0-9]{64}$/u.test(manifest.archiveSha256 ?? "")
  )
    throw Error("RELEASE_ASSET_IDENTITY_INVALID");
  const entries = fs
    .readdirSync(directory)
    .filter((name) => name !== "private")
    .sort();
  if (
    JSON.stringify(entries) !==
    JSON.stringify([archive, "SHA256SUMS", "farol-release.json"].sort())
  )
    throw Error("RELEASE_ASSET_SET_INVALID");
  regular(path.join(directory, "SHA256SUMS"), 1024);
  const sums = fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8");
  if (sums !== `${manifest.archiveSha256}  ${archive}\n`)
    throw Error("RELEASE_CHECKSUMS_INVALID");
  const archivePath = path.join(directory, archive);
  const info = regular(archivePath, 2147483648);
  if (info.size !== manifest.archiveSize)
    throw Error("RELEASE_ARCHIVE_SIZE_INVALID");
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(archivePath))
    hash.update(chunk);
  if (hash.digest("hex") !== manifest.archiveSha256)
    throw Error("RELEASE_ARCHIVE_DIGEST_INVALID");
  return [archive, "farol-release.json", "SHA256SUMS"];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3)
    throw Error("RELEASE_ASSET_DIRECTORY_REQUIRED");
  const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  console.log(
    JSON.stringify(
      await verifyReleaseAssets(process.argv[2], { version, head }),
    ),
  );
}
