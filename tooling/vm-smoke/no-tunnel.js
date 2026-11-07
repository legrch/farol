// Inspect guest configuration locally and emit no configuration or credential.
ObjC.import("Foundation");
function run(argv) {
  const config = JSON.parse(
    $.NSString.stringWithContentsOfFileEncodingError(argv[0], 4, null).js,
  );
  const connector = config.connectors && config.connectors.secureMcp;
  if (
    config.setup &&
    config.setup.connect &&
    config.setup.connect.outcomeUnknown
  )
    throw Error("GUEST_EFFECT_UNKNOWN");
  const marker = $.NSHomeDirectory().js + "/.farol-vm-dev-connection.json";
  let approved = null;
  if ($.NSFileManager.defaultManager.fileExistsAtPath(marker)) {
    approved = JSON.parse(
      $.NSString.stringWithContentsOfFileEncodingError(marker, 4, null).js,
    );
  }
  const empty =
    connector &&
    connector.tunnelId === null &&
    connector.credential === "missing" &&
    connector.runtime === null;
  const dev =
    connector &&
    approved &&
    approved.schema === 1 &&
    approved.source === "dev-only" &&
    connector.tunnelId === approved.tunnelId &&
    connector.credential === "stored" &&
    !(connector.runtime && connector.runtime.state === "outcome_unknown") &&
    !connector.appVerificationPending;
  if (!empty && !dev) throw Error("GUEST_CONNECTION_NOT_APPROVED_DEV");
  return dev ? "APPROVED_DEV" : "UNCONFIGURED";
}
