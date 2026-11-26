import type { ConnectionStatusView } from "../renderer/connection-status";
import { menuBarIconState } from "../../../src/apps/desktop/menu-bar";

// The native menu bar item at startup. Hidden tests own no visible status
// item, so nothing is created unless `enabled`. Creation runs inside the
// caller's startup boundary and answers the disposer; main keeps that owner
// and registers it for will-quit, so a Quit during the next startup step
// still closes the item. Commands route through the same app functions as the
// application menu.

type MenuBarState = ConnectionStatusView["state"];
type Dispose = () => void;

export type MenuBarPorts = Readonly<{
  enabled: boolean;
  boundary: (create: () => Dispose) => Promise<Dispose>;
  create: (
    actions: Readonly<{
      open: () => void;
      current: () => void;
      updates: () => void;
      quit: () => void;
    }>,
    status: () => Readonly<{
      label: string;
      icon: ReturnType<typeof menuBarIconState>;
      current: string | null;
    }>,
  ) => Dispose;
  reopen: () => void;
  runningTask: () => Readonly<{ taskId: string; label: string }> | null;
  showTask: (taskId: string) => void;
  requestUpdates: () => void;
  quit: () => void;
  connection: () => Readonly<{ state: MenuBarState; label: string }>;
  attached: (state: MenuBarState) => boolean;
}>;

export async function startMenuBar(
  ports: MenuBarPorts,
): Promise<Dispose | null> {
  if (!ports.enabled) return null;
  return ports.boundary(() =>
    ports.create(
      {
        open: () => {
          ports.reopen();
        },
        current: () => {
          const task = ports.runningTask();
          if (task) ports.showTask(task.taskId);
          ports.reopen();
        },
        updates: () => {
          ports.requestUpdates();
        },
        quit: () => {
          ports.quit();
        },
      },
      () => {
        const status = ports.connection();
        const attached = ports.attached(status.state);
        return {
          label: "Farol · " + status.label,
          icon: menuBarIconState(status.state, attached),
          current: ports.runningTask()?.label ?? null,
        };
      },
    ),
  );
}
