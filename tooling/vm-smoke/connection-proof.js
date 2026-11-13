// Read only guest-local identity metadata; never export a tunnel ID or key.
ObjC.import("Foundation");
function run(argv) {
  const read = (path) =>
    $.NSString.stringWithContentsOfFileEncodingError(path, 4, null).js;
  const identity = JSON.parse(read(argv[0]));
  const home = $.NSHomeDirectory().js;
  const root = home + "/Library/Application Support/" + identity.dataLeaf;
  const config = JSON.parse(read(root + "/farol-state/config.json"));
  const profile = JSON.parse(read(root + "/farol-state/go-core/profile.json"));
  const connector = config.connectors.secureMcp;
  const markerPath = home + "/.farol-vm-dev-connection.json";
  const approved = $.NSFileManager.defaultManager.fileExistsAtPath(markerPath)
    ? JSON.parse(read(markerPath))
    : null;
  return JSON.stringify({
    profileId: profile.profileId,
    computerId: profile.computerId,
    workspaceCount: config.computer.workspaces.length,
    approvedDev: Boolean(
      approved &&
      approved.source === "dev-only" &&
      approved.tunnelId === connector.tunnelId,
    ),
    tunnelState: connector.runtime ? connector.runtime.state : "not_started",
    buildId: connector.runtime ? connector.runtime.buildId : null,
  });
}
