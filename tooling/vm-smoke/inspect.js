// Runs only inside the guest, through the TerminalMacGuest action transport.
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
function run(argv) {
  ObjC.import("Foundation");
  const identity = JSON.parse(
    $.NSString.stringWithContentsOfFileEncodingError(argv[0], 4, null).js,
  );
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  const owners = [];
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    const root = "/Applications/" + identity.name + ".app";
    if (
      app.bundleURL &&
      (app.bundleURL.path.js === root ||
        app.bundleURL.path.js.startsWith(root + "/Contents/"))
    ) {
      owners.push(Number(app.processIdentifier));
    }
  }
  const raw = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0));
  const data = $.NSJSONSerialization.dataWithJSONObjectOptionsError(
    raw,
    0,
    null,
  );
  const windows = JSON.parse($.NSString.alloc.initWithDataEncoding(data, 4).js);
  const normal = windows.filter(
    (w) =>
      owners.includes(w.kCGWindowOwnerPID) &&
      w.kCGWindowLayer === 0 &&
      w.kCGWindowBounds.Width > 200 &&
      w.kCGWindowBounds.Height > 150,
  );
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const root = "/Applications/" + identity.name + ".app";
  const foreground = Boolean(
    front.bundleURL &&
    (front.bundleURL.path.js === root ||
      front.bundleURL.path.js.startsWith(root + "/Contents/")),
  );
  return JSON.stringify({ pids: owners, windows: normal.length, foreground });
}
