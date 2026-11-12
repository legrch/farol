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
  // Foundation's item attributes do not follow the final symlink. Inspect
  // every parent as well: an alias or an inaccessible ancestor is unresolved.
  const classify = (path) => {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length; i++) {
      current += "/" + parts[i];
      const error = Ref();
      const attrs = $.NSFileManager.defaultManager.attributesOfItemAtPathError(
        current,
        error,
      );
      if (!attrs || !attrs.js) {
        const failure = error[0];
        return failure &&
          failure.domain.js === "NSCocoaErrorDomain" &&
          Number(failure.code) === 260
          ? "absent"
          : "unconfirmed";
      }
      const kind = attrs.objectForKey("NSFileType").js;
      if (i < parts.length - 1) {
        if (kind !== "NSFileTypeDirectory") return "unconfirmed";
      } else return kind === "NSFileTypeRegular" ? "present" : "unconfirmed";
    }
    return "unconfirmed";
  };
  const runningMarker = classify(root + "running.json");
  let receiptMarker = classify(root + "last-quit.json");
  let text = null;
  if (receiptMarker === "present") {
    const value = read(root + "last-quit.json");
    if (typeof value === "string") text = value;
    else receiptMarker = "unconfirmed";
  }
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
    running:
      runningMarker === "present"
        ? true
        : runningMarker === "absent"
          ? false
          : null,
    runningMarker,
    receiptMarker,
    receipt: text,
    drained,
    quitAt,
  });
}
