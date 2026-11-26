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
    source.indexOf("const windowState = desktopWindowState({"),
    source.indexOf("const windowSurfaces ="),
  );
  for (const [name, owner] of [
    ["window", "window"],
    ["windowPresentationReady", "windowPresentationReady"],
    ["runtime", "runtime"],
    ["runtimeState", "runtimeState"],
    ["selectedTaskId", "selectedTaskId"],
    ["browserHomeSurfaceOpen", "browserHomeSurfaceOpen"],
  ] as const)
    expect(state).toContain(`${name}: () => ${owner},`);
  for (const name of ["quitInProgress", "installedUpdateAdmission"])
    expect(state).toContain(`${name}: () => desktopAdmission.${name},`);
  for (const [setter, owner] of [
    ["setWindow", "window"],
    ["setWindowPresentationReady", "windowPresentationReady"],
    ["setBrowserHomeSurfaceOpen", "browserHomeSurfaceOpen"],
  ] as const)
    expect(state).toContain(
      `${setter}: (value) => {\n    ${owner} = value;\n  },`,
    );
  const surfaces = call(source, "const windowSurfaces = taskSurfaces({");
  const window = call(source, "} = mainWindow({");
  for (const body of [surfaces, window])
    expect(body).toContain("state: windowState,");
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
