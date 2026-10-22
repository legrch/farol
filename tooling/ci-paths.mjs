import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function docsOnly(files) {
  return (
    files.length > 0 &&
    files.every(
      (file) =>
        !/(?:^|\/)AGENTS\.md$/u.test(file) &&
        /^(?:docs\/(?!tools\/).*\.md|README\.md|CONTRIBUTING\.md|LICENSE(?:\.md)?)$/u.test(
          file,
        ),
    )
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env.PR_BASE_SHA;
  if (!/^[a-f0-9]{40}$/u.test(base ?? "")) throw Error("PR_BASE_SHA_INVALID");
  const files = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", base, "HEAD"],
    {
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean);
  const value = docsOnly(files);
  if (!process.env.GITHUB_OUTPUT) throw Error("GITHUB_OUTPUT_REQUIRED");
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${value}\n`);
  console.log(JSON.stringify({ docsOnly: value, changedFiles: files.length }));
}
