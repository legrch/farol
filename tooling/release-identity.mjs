// Only committed package metadata chooses this channel; no environment or workspace URL.
export function releaseBuildFields(packageDocument) {
  const release = packageDocument.farolRelease;
  if (release === undefined) return {};
  if (
    release === null ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    Object.keys(release).sort().join(",") !== "buildVersion,updateChannel" ||
    !["github-owner-beta", "github-stable"].includes(release.updateChannel) ||
    typeof release.buildVersion !== "string" ||
    !/^[1-9][0-9]{0,8}$/u.test(release.buildVersion) ||
    !(
      release.updateChannel === "github-stable"
        ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u
        : /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-owner\.beta\.(0|[1-9][0-9]*)$/u
    ).test(packageDocument.version)
  )
    throw new Error("RELEASE_BUILD_FIELDS_INVALID");
  return {
    updateChannel: release.updateChannel,
    buildVersion: release.buildVersion,
  };
}
