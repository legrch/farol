// Activation stays inside the guest; no host focus or Apple Events permission.
ObjC.import("AppKit");
function run(argv) {
  const identity = JSON.parse(
    $.NSString.stringWithContentsOfFileEncodingError(argv[0], 4, null).js,
  );
  const root = "/Applications/" + identity.name + ".app";
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  let activated = false;
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    if (
      app.bundleURL &&
      (app.bundleURL.path.js === root ||
        app.bundleURL.path.js.startsWith(root + "/Contents/"))
    ) {
      activated = Boolean(app.activateWithOptions(2)) || activated;
    }
  }
  if (!activated) throw Error("GUEST_APP_ACTIVATION_FAILED");
  return "ACTIVATED";
}
