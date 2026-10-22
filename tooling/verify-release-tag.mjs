import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function verifyVersion(tag, version) {
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
    tag !== `v${version}`
  )
    throw Error("RELEASE_TAG_VERSION_MISMATCH");
}

export function verifyReleaseTag(
  tag,
  git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", timeout: 30000 }).trim(),
) {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  verifyVersion(tag, version);
  const head = git("rev-parse", "HEAD");
  const tagged = git("rev-parse", `refs/tags/${tag}^{commit}`);
  if (tagged !== head) throw Error("RELEASE_TAG_HEAD_MISMATCH");
  const tagObject = git("rev-parse", `refs/tags/${tag}`);
  // A lightweight tag carries no tagger or message; only an annotated tag
  // object may start a release.
  if (tagObject === head || git("cat-file", "-t", `refs/tags/${tag}`) !== "tag")
    throw Error("RELEASE_TAG_NOT_ANNOTATED");
  git("merge-base", "--is-ancestor", head, "refs/remotes/origin/main");
  const remote = git(
    "ls-remote",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  );
  const refs = new Map(
    remote
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/u).reverse()),
  );
  if (
    refs.get(`refs/tags/${tag}^{}`) !== head ||
    refs.get(`refs/tags/${tag}`) !== tagObject
  )
    throw Error("RELEASE_REMOTE_TAG_CHANGED");
  return head;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_REF_TYPE !== "tag")
    throw Error("RELEASE_TAG_REQUIRED");
  console.log(verifyReleaseTag(process.env.GITHUB_REF_NAME));
}
