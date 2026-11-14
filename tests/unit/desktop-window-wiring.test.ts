import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const main = new URL("../../src/apps/desktop/main.ts", import.meta.url);
function call(source: string, signature: string) {
  const begin = source.indexOf(signature);
  expect(begin).toBeGreaterThanOrEqual(0);
  return source.slice(begin, source.indexOf("\n});\n", begin) + 4);
}

it("lends current window/runtime state to both window adapters", async () => {
  const source = await readFile(main, "utf8");
  const state = source.slice(
    source.indexOf("const desktopWindowState = {"),
    source.indexOf("const windowSurfaces ="),
  );
  for (const name of [
    "window",
    "windowPresentationReady",
    "runtime",
    "runtimeState",
    "quitInProgress",
    "installedUpdateAdmission",
    "selectedTaskId",
    "browserHomeSurfaceOpen",
  ]) {
    expect(state).toContain(`get ${name}() {\n    return ${name};\n  }`);
  }
  for (const name of [
    "window",
    "windowPresentationReady",
    "browserHomeSurfaceOpen",
  ]) {
    expect(state).toContain(`set ${name}(value) {\n    ${name} = value;\n  }`);
  }
  const surfaces = call(source, "const windowSurfaces = taskSurfaces({");
  const window = call(source, "} = mainWindow({");
  for (const body of [surfaces, window])
    expect(body).toContain("state: desktopWindowState,");
  for (const name of [
    "WebContentsView",
    "taskViews",
    "taskViewKinds",
    "nativeViewVisibility",
    "streamControllers",
    "taskSurfaceFailures",
    "pendingComputer",
    "session",
    "runtimeBase",
    "currentSurfaceLayout",
    "applyLayout",
    "handleShortcut",
    "preventEmbeddedWindowDrag",
    "operationsStore",
    "fetch",
  ]) {
    expect(surfaces).toContain(`\n  ${name},\n`);
  }
  expect(surfaces).toContain(
    "runtimePartition: activeDesktopIdentity.runtimePartition,",
  );
  expect(surfaces).toContain("signInSurfaceId: SIGN_IN_SURFACE_ID,");
  for (const name of [
    "BrowserWindow",
    "pendingComputer",
    "taskSurfaceFailures",
    "nativeViewVisibility",
    "managedChatGptRoutes",
    "liveTaskRoutes",
    "handleShortcut",
    "applyLayout",
    "focusForLayoutAfterRendererCommit",
    "openLiveTaskSurface",
    "closeStartupSplash",
  ]) {
    expect(window).toContain(`\n  ${name},\n`);
  }
  expect(window).toContain("surfaces: windowSurfaces,");
  expect(window).toContain("coordinator: windowOpenCoordinator,");
  expect(window).toContain("aboutPanel: () => aboutPanel,");
  expect(window).toContain("updatesPanel: () => updatesPanel,");
});

it("constructs after the task maps and defers navigation's earlier surface callback", async () => {
  const source = await readFile(main, "utf8");
  expect(
    source.indexOf("const windowSurfaces = taskSurfaces({"),
  ).toBeGreaterThan(source.indexOf("const pendingComputer = new Map<"));
  expect(call(source, "} = surfaceNavigation({")).toMatch(
    /attachTaskView: \(taskId, view, bounds\) =>\s+attachTaskView\(taskId, view, bounds\)/,
  );
  for (const name of [
    "currentWindowState",
    "publishWindowState",
    "createWindow",
    "selectedVisibleTestPlacement",
    "chatGptWindowPresentation",
    "chatGptWindowPresentationOption",
    "revealWindow",
    "reconcileVisibleTestDisplay",
    "recoverWindowOpenFailure",
    "ensureWindow",
    "reopenWindow",
    "attachTaskView",
    "attachTaskViews",
    "detachTaskViews",
    "liveChatGptSurfaceFactory",
    "signInChatGptSurfaceFactory",
    "disposeTaskView",
    "disposeTaskViews",
    "stopStreams",
    "publishTaskSurfaceStatus",
    "failTaskSurface",
    "partitionName",
    "installNetworkFence",
    "createTaskViews",
    "consumeSse",
  ]) {
    expect(source).not.toMatch(new RegExp(`\\n(?:async )?function ${name}\\(`));
  }
});
