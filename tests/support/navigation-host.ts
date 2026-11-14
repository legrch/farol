import type {
  NavigationState,
  SurfaceNavigationPorts,
} from "../../apps/desktop/shell/navigation";

// Ports for apps/desktop/shell/navigation.ts read from one mutable fixture
// object under the names main.ts gives its own state and functions. The
// navigation state is that same object, so an assignment in the module is
// visible to the fixture and to source it still extracts from main.ts. A
// missing function fails at the call that needs it.
export function navigationHost(
  fixture: Record<string, unknown>,
): SurfaceNavigationPorts {
  const read =
    <T>(name: string) =>
    () =>
      fixture[name] as T;
  const call =
    (name: string) =>
    (...args: unknown[]) =>
      (fixture[name] as (...values: unknown[]) => unknown)(...args);
  const host = {
    state: fixture as unknown as NavigationState,
    window: read("window"),
    quitInProgress: read("quitInProgress"),
    installedUpdateAdmission: read("installedUpdateAdmission"),
    runtimeState: read("runtimeState"),
    taskViews: read("taskViews"),
    taskViewKinds: read("taskViewKinds"),
    nativeViewVisibility: read("nativeViewVisibility"),
    get liveTaskRoutes() {
      return fixture.liveTaskRoutes;
    },
    get signInSurfaceId() {
      return fixture.SIGN_IN_SURFACE_ID;
    },
    compactBrowser: () =>
      (fixture.compactBrowserSelected as (input: object) => boolean)({
        environment: fixture.runtimeEnvironment,
        demoMode: fixture.demoMode,
        legacySetupTestMode: fixture.legacySetupTestMode,
      }),
    productTasksState: call("productTasksState"),
    attachTaskView: call("attachTaskView"),
    openLiveTaskSurface: call("openLiveTaskSurface"),
    requestSettings: call("requestSettings"),
  };
  return host as unknown as SurfaceNavigationPorts;
}
