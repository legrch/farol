import { admissionFixture } from "../support/desktop-admission";
import { describe, expect, it } from "vitest";
import {
  shellCommands,
  type ShellPublisher,
} from "../../apps/desktop/shell/navigation";
import { createShellRequests } from "../../apps/desktop/shell/request";
import { navigationHost } from "../support/navigation-host";

const names = [
  "requestQuickSwitcher",
  "requestSidebarToggle",
  "requestUpdates",
  "requestSettings",
  "closeShellOverlay",
] as const;

// Execute the actual small native publisher callbacks with injected window/IO
// ports: the navigation commands by import, the two
// shell requests from their factory. These fixtures prove no Electron window, updater or native focus.
async function publishers({
  applying = false,
  quitting = false,
  admitWhileOpening = false,
  quitWhileOpening = false,
} = {}) {
  const effects: string[] = [];
  const checks: string[] = [];
  const publications: unknown[][] = [];
  let opening: Promise<void> | undefined;
  const context: Record<string, unknown> = {
    quitInProgress: quitting,
    installedUpdateAdmission: applying,
    installedUpdates: { requestCheck: () => checks.push("check") },
    setupOpen: false,
    shellOverlay: "task-menu",
    sidebarMode: "overlay",
    window: {
      isDestroyed: () => false,
      webContents: { focus: () => effects.push("focus") },
    },
    applyLayout: () => effects.push("layout"),
    focusForLayout: () => effects.push("focus"),
    publishShellAction: (...args: unknown[]) => publications.push(args),
    ensureWindow: async () => {
      effects.push("open");
      if (admitWhileOpening) context.installedUpdateAdmission = true;
      if (quitWhileOpening) context.quitInProgress = true;
    },
    containWindowOpenFailure: (run: () => Promise<void>) => {
      opening = run();
      return opening;
    },
    recoverWindowOpenFailure: () => {
      throw Error("UNEXPECTED_RECOVERY");
    },
  };
  const publishShellAction = ((...args: unknown[]) =>
    (context.publishShellAction as (...values: unknown[]) => void)(
      ...args,
    )) as ShellPublisher["publishShellAction"];
  const commands = shellCommands(navigationHost(context), {
    publishShellAction,
    applyLayout: () => (context.applyLayout as () => void)(),
    focusForLayout: () => (context.focusForLayout as () => void)(),
    focusForLayoutAfterRendererCommit: () => {
      throw Error("UNEXPECTED_DEFERRED_FOCUS");
    },
  });
  const fixture = admissionFixture(context);
  const requests = createShellRequests({
    closed: () => fixture.desktopAdmission.closed(),
    contain: (work) =>
      (
        context.containWindowOpenFailure as (
          run: () => Promise<void>,
        ) => Promise<unknown>
      )(work),
    ensureWindow: () => (context.ensureWindow as () => Promise<void>)(),
    window: () => context.window as never,
    publishShellAction: (...args: unknown[]) =>
      (context.publishShellAction as (...values: unknown[]) => void)(...args),
    requestUpdateCheck: () =>
      (context.installedUpdates as { requestCheck(): unknown }).requestCheck(),
  });
  const exports: Record<(typeof names)[number], () => void> = {
    requestUpdates: requests.requestUpdates,
    requestSettings: requests.requestSettings,
    requestQuickSwitcher: commands.requestQuickSwitcher,
    requestSidebarToggle: commands.requestSidebarToggle,
    closeShellOverlay: commands.closeShellOverlay,
  };
  return {
    effects,
    checks,
    publications,
    context,
    async invoke(name: (typeof names)[number]) {
      exports[name]();
      await opening;
    },
  };
}

describe("native Quit and applying-update presentation ownership", () => {
  it.each(names)(
    "refuses %s before native presentation or publication",
    async (name) => {
      const host = await publishers({ applying: true });
      await host.invoke(name);
      expect(host.effects).toEqual([]);
      expect(host.publications).toEqual([]);
      expect(host.context.shellOverlay).toBe("task-menu");
      expect(host.context.sidebarMode).toBe("overlay");
    },
  );
  it.each(names)(
    "refuses %s during Quit before native presentation or publication",
    async (name) => {
      const host = await publishers({ quitting: true });
      await host.invoke(name);
      expect(host.effects).toEqual([]);
      expect(host.publications).toEqual([]);
      expect(host.context.shellOverlay).toBe("task-menu");
      expect(host.context.sidebarMode).toBe("overlay");
    },
  );
  it.each(names)("keeps %s usable before applying admission", async (name) => {
    const host = await publishers();
    await host.invoke(name);
    expect(host.publications).toHaveLength(1);
  });
  it("asks for one explicit update check when Updates opens", async () => {
    const host = await publishers();
    await host.invoke("requestUpdates");
    expect(host.checks).toEqual(["check"]);
  });
  it("does not check when Quit starts during window opening", async () => {
    const host = await publishers({ quitWhileOpening: true });
    await host.invoke("requestUpdates");
    expect(host.checks).toEqual([]);
  });
  it("does not publish Updates when admission changes during window opening", async () => {
    const host = await publishers({ admitWhileOpening: true });
    await host.invoke("requestUpdates");
    expect(host.effects).toEqual(["open"]);
    expect(host.publications).toEqual([]);
  });
  it("does not publish or focus Updates when Quit starts during window opening", async () => {
    const host = await publishers({ quitWhileOpening: true });
    await host.invoke("requestUpdates");
    expect(host.effects).toEqual(["open"]);
    expect(host.publications).toEqual([]);
    expect(host.context.quitInProgress).toBe(true);
    expect(host.context.installedUpdateAdmission).toBe(false);
    expect(host.context.shellOverlay).toBe("task-menu");
    expect(host.context.sidebarMode).toBe("overlay");
  });
});
