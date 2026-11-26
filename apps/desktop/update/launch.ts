import path from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalBuildIdentityPayload,
  type BuildIdentity,
} from "../../../src/pkg/build-info/identity";

// Pure checks on the running build and on where a private launch lives.

const CHANNELS = ["github-owner-beta", "github-stable"];

// True when the build cannot anchor an installed update: dirty source, no
// build version, an unknown channel or an id that is not its own payload hash.
export function buildRefused(build: BuildIdentity): boolean {
  return (
    build.sourceDirty ||
    !build.buildVersion ||
    !CHANNELS.includes(build.updateChannel) ||
    createHash("sha256")
      .update(canonicalBuildIdentityPayload(build))
      .digest("hex") !== build.buildId
  );
}

// The operation id of a private launch image `<root>/<id>/launch-Farol.app`,
// or null when the app lives anywhere else.
export function launchOperation(root: string, app: string): string | null {
  const relative = path.relative(root, app).split(path.sep);
  if (
    relative.length !== 2 ||
    !/^[a-f0-9]{32}$/u.test(relative[0]!) ||
    relative[1] !== "launch-Farol.app"
  )
    return null;
  return relative[0]!;
}
