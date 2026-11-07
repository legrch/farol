// Offline import into the guest package profile. No host computer identity,
// workspace grant, browser session, runtime receipt or app attachment is copied.
ObjC.import("Foundation");
function run(argv) {
  const fm = $.NSFileManager.defaultManager;
  const read = (path) =>
    $.NSString.stringWithContentsOfFileEncodingError(path, 4, null).js;
  const identity = JSON.parse(read(argv[0]));
  const stage = argv[1];
  const input = JSON.parse(read(stage + "/dev-connection.json"));
  if (input.schema !== 1 || !/^[0-9A-Za-z._:-]{1,160}$/.test(input.tunnelId))
    throw Error("DEV_CONNECTION_INVALID");
  const home = $.NSHomeDirectory().js;
  const root = home + "/Library/Application Support/" + identity.dataLeaf;
  const file = root + "/farol-state/config.json";
  const config = JSON.parse(read(file));
  const connector = config.connectors.secureMcp;
  if (
    connector.appVerificationPending === true ||
    (connector.runtime && connector.runtime.state === "outcome_unknown") ||
    config.setup.connect.outcomeUnknown === true
  )
    throw Error("GUEST_EFFECT_UNKNOWN");
  if (connector.tunnelId !== null && connector.tunnelId !== input.tunnelId)
    throw Error("FOREIGN_GUEST_CONNECTION");
  const keyRoot = root + "/farol-private/secure-mcp-connector";
  if (
    !fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
      keyRoot,
      true,
      { NSFilePosixPermissions: 448 },
      null,
    )
  )
    throw Error("GUEST_KEY_DIRECTORY_FAILED");
  const key = $.NSData.dataWithContentsOfFile(stage + "/dev-key");
  if (!key || key.length < 20 || key.length > 512)
    throw Error("DEV_KEY_INVALID");
  const keyFile = keyRoot + "/control-plane-api-key";
  if (
    !key.writeToFileAtomically(keyFile, true) ||
    !fm.setAttributesOfItemAtPathError(
      { NSFilePosixPermissions: 384 },
      keyFile,
      null,
    )
  )
    throw Error("GUEST_KEY_WRITE_FAILED");
  connector.generation += 1;
  connector.tunnelId = input.tunnelId;
  connector.credential = "stored";
  connector.runtime = null;
  connector.challenge = null;
  connector.attachment = null;
  connector.lastVerifiedAttachment = null;
  connector.chatgptApp = null;
  config.revision += 1;
  const write = (path, value) => {
    if (
      !$(
        JSON.stringify(value, null, 2) + "\n",
      ).writeToFileAtomicallyEncodingError(path, true, 4, null) ||
      !fm.setAttributesOfItemAtPathError(
        { NSFilePosixPermissions: 384 },
        path,
        null,
      )
    )
      throw Error("GUEST_CONFIG_WRITE_FAILED");
  };
  write(file, config);
  write(home + "/.farol-vm-dev-connection.json", {
    schema: 1,
    source: "dev-only",
    tunnelId: input.tunnelId,
  });
  return "IMPORTED_DEV_CONNECTION";
}
