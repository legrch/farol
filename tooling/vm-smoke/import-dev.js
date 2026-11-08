// Offline import into the guest package profile. No host computer identity,
// workspace grant, browser session, runtime receipt or app attachment is copied.
ObjC.import("Foundation");
function run(argv) {
  const fm = $.NSFileManager.defaultManager;
  const read = (path) =>
    $.NSString.stringWithContentsOfFileEncodingError(path, 4, null).js;
  // A missing file bridges as a truthy nil object whose .js is undefined.
  const readOptional = (path) => {
    const text = $.NSString.stringWithContentsOfFileEncodingError(
      path,
      4,
      null,
    );
    return text && typeof text.js === "string" ? text.js : null;
  };
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
  // Operation-bound commit receipt: its existence proves this exact generation
  // and tunnel landed, so a lost acknowledgement of the final publication
  // re-admits idempotently instead of re-importing another generation. Any
  // other receipt shape is an unclassifiable guest effect, never a retry.
  const receiptFile = root + "/farol-state/secure-mcp-import-receipt.json";
  const receiptText = readOptional(receiptFile);
  if (receiptText !== null) {
    let receipt = null;
    try {
      receipt = JSON.parse(receiptText);
    } catch (error) {
      receipt = null;
    }
    if (
      !receipt ||
      receipt.schema !== 1 ||
      receipt.generation !== connector.generation ||
      receipt.tunnelId !== connector.tunnelId ||
      connector.tunnelId !== input.tunnelId ||
      connector.credential !== "stored"
    )
      throw Error("GUEST_EFFECT_UNKNOWN");
    return "IMPORTED_DEV_CONNECTION";
  }
  // Durability honesty: writeToFileAtomically reproduces only the ordering of
  // the native connector-key-store contract (temporary file, atomic rename).
  // The JXA surface cannot express its fsync file -> rename -> fsync directory
  // steps: there is no explicit fsync and no directory sync, so an acknowledged
  // write is crash-ordered, not proven power-loss durable. The native
  // durability gate remains a separate NOT RUN experiment.
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
  // Publish uncertainty before replacing secret bytes. A partial import must
  // remain fenced even if the next write committed but its acknowledgement failed.
  config.setup.connect.outcomeUnknown = true;
  config.revision += 1;
  write(file, config);
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
  write(file, config);
  write(home + "/.farol-vm-dev-connection.json", {
    schema: 1,
    source: "dev-only",
    tunnelId: input.tunnelId,
  });
  // The uncertainty guard clears only after the receipt proving this import
  // landed is itself published, so a reported failure here keeps the fence up.
  write(receiptFile, {
    schema: 1,
    generation: connector.generation,
    tunnelId: input.tunnelId,
  });
  config.setup.connect.outcomeUnknown = false;
  config.revision += 1;
  write(file, config);
  return "IMPORTED_DEV_CONNECTION";
}
