// Guest-only lifecycle metadata. Absence of a GUI is not a child-drain receipt.
ObjC.import("Foundation");
function run(argv) {
  const read = (path) =>
    $.NSString.stringWithContentsOfFileEncodingError(path, 4, null).js;
  const identity = JSON.parse(read(argv[0]));
  const root =
    $.NSHomeDirectory().js +
    "/Library/Application Support/" +
    identity.dataLeaf +
    "/farol-state/";
  const exists = (path) =>
    $.NSFileManager.defaultManager.fileExistsAtPath(path);
  const text = exists(root + "last-quit.json")
    ? read(root + "last-quit.json")
    : null;
  let drained = false;
  let quitAt = null;
  if (text !== null && text.length < 16384) {
    try {
      const record = JSON.parse(text);
      const at = Date.parse(record.at);
      drained =
        Object.keys(record).sort().join(",") ===
          "at,drained,schema,unconfirmed" &&
        record.schema === 1 &&
        record.drained === true &&
        Array.isArray(record.unconfirmed) &&
        record.unconfirmed.length === 0 &&
        Number.isFinite(at) &&
        new Date(at).toISOString() === record.at;
      if (drained) quitAt = at;
    } catch {
      /* An invalid receipt never confirms drain. */
    }
  }
  return JSON.stringify({
    observedAt: Date.now(),
    running: Boolean(exists(root + "running.json")),
    receipt: text,
    drained,
    quitAt,
  });
}
