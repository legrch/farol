import {
  mainWindow,
  type MainWindowPorts,
} from "../../apps/desktop/window/main";
import {
  taskSurfaces,
  type TaskSurfacePorts,
} from "../../apps/desktop/window/surface";

// Adapt controlled native interfaces to the real factories' ports. These
// fixtures establish no Electron, filesystem, provider or profile behavior.
export function surfacePorts(owner: object): TaskSurfacePorts {
  const context = owner as Record<string, unknown>;
  const partition = context.partitionName as (() => string) | undefined;
  const fence = context.installNetworkFence as (() => unknown) | undefined;
  return new Proxy(
    {},
    {
      get(_target, name: string) {
        if (name === "state") return context;
        if (name === "runtimePartition") {
          const identity = context.activeDesktopIdentity as
            { runtimePartition?: string } | undefined;
          return identity?.runtimePartition ?? partition?.();
        }
        if (name === "signInSurfaceId") return context.SIGN_IN_SURFACE_ID;
        if (name === "session" && context.session === undefined)
          return {
            fromPartition: () => {
              fence?.();
              return {
                setPermissionRequestHandler() {},
                setPermissionCheckHandler() {},
                webRequest: { onBeforeRequest() {} },
              };
            },
          };
        return context[name];
      },
    },
  ) as TaskSurfacePorts;
}

export function windowHost(owner: object) {
  const context = owner as Record<string, unknown>;
  const surfaces = taskSurfaces(surfacePorts(context));
  const stopStreams =
    typeof context.stopStreams === "function"
      ? context.stopStreams
      : surfaces.stopStreams;
  const main = mainWindow(
    new Proxy(
      {},
      {
        get(_target, name: string) {
          if (name === "state") return context;
          if (name === "surfaces") return { ...surfaces, stopStreams };
          if (name === "coordinator") return context.windowOpenCoordinator;
          if (name === "platform")
            return (context.process as { platform: string }).platform;
          if (name === "writeLog")
            return (line: string) =>
              (
                context.process as { stderr: { write(line: string): unknown } }
              ).stderr.write(line);
          if (name === "aboutPanel" || name === "updatesPanel")
            return () => context[name];
          return context[name];
        },
      },
    ) as MainWindowPorts,
  );
  return { ...surfaces, ...main };
}
