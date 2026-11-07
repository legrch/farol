// Inspect guest configuration locally and emit no configuration or credential.
ObjC.import("Foundation");
function run(argv) {
  const config = JSON.parse(
    $.NSString.stringWithContentsOfFileEncodingError(argv[0], 4, null).js,
  );
  const connector = config.connectors && config.connectors.secureMcp;
  if (
    !connector ||
    connector.tunnelId !== null ||
    connector.credential !== "missing" ||
    connector.runtime !== null
  )
    throw Error("GUEST_CONNECTION_NOT_EMPTY");
  return "UNCONFIGURED";
}
