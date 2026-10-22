// A test-owned copy of a packaged app that is executed in place.
//
// macOS LaunchServices registers a bundle the first time a process runs out of
// it. A clone named the product bundle therefore becomes a second, runnable
// application under the production bundle identifier, and deleting the
// directory afterwards does not unregister it. Later `open` and relaunch
// acceptance can then resolve that identifier to a path that no longer exists.
//
// The copy is executed by its absolute path, never opened as an application,
// so it does not need the `.app` suffix that makes the directory a bundle
// package. A non-package suffix keeps the executable layout under test
// (`Contents/MacOS/...`, `Contents/Frameworks/...`) byte-identical while the
// directory itself never presents the production identifier as an application.
export const UNREGISTERED_COPY_SUFFIX = ".unregistered-copy";

export function unregisteredAppCopyName(appName) {
  if (
    typeof appName !== "string" ||
    !appName.endsWith(".app") ||
    appName === ".app" ||
    appName.includes("/") ||
    appName.includes("\0")
  ) {
    throw new Error("UNREGISTERED_APP_COPY_NAME_INVALID");
  }
  return `${appName.slice(0, -".app".length)}${UNREGISTERED_COPY_SUFFIX}`;
}
