import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Shell } from "../../src/ui/renderer/shell";
import { Services } from "../../src/ui/renderer/services";
import { WindowController } from "../../src/ui/renderer/controller";
import type { InstalledUpdateView } from "../../src/modules/release/contract/installed-update";
import {
  InstalledUpdateCommandSchema,
  InstalledUpdateViewSchema,
} from "../../src/modules/release/contract/installed-update";
import { bootstrap, fixture, deferred } from "./fixture";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// DOM-only notice/sheet fixtures: no host dispatch, browser layout or live updater proof.
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
});
const available: InstalledUpdateView = {
  phase: "available",
  version: "0.2.0-owner.beta.4",
  deferred: false,
  notice: { key: "version:0.2.0-owner.beta.4", seen: false, blockedBy: null },
};
function withSeen(view: InstalledUpdateView): InstalledUpdateView {
  if (!("notice" in view) || !view.notice) throw new Error("NOTICE_MISSING");
  return { ...view, notice: { ...view.notice, seen: true } };
}
async function mount(
  update: InstalledUpdateView = available,
  environment: "preview" | "dev" = "preview",
) {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({ ...bootstrap(), environment });
  vi.mocked(f.api.installedUpdate).mockResolvedValue(update);
  const c = new WindowController(f.api);
  await c.start();
  vi.mocked(f.api.installedUpdate).mockClear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StrictMode>
        <Services value={c}>
          <Shell />
        </Services>
      </StrictMode>,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    c.dispose();
  });
  return { f, c, host };
}
function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) =>
      (node.getAttribute("aria-label") ?? node.textContent)?.trim() === label,
  );
  if (!found) throw new Error(`BUTTON_MISSING:${label}`);
  return found;
}
it.each(["available", "ready"] as const)(
  "uses one atomic automatic update choice in the %s sheet and preserves an unknown save",
  async (phase) => {
    const legacy: InstalledUpdateView = {
      ...(phase === "ready" ? { phase, blockedBy: null } : { phase }),
      version: available.version,
      deferred: false,
      automaticUpdatePreference: { status: "confirmed", enabled: true },
      installOnQuitPreference: {
        status: "confirmed",
        scope: "install-on-normal-quit",
        enabled: true,
      },
    };
    const { host, c, f } = await mount(legacy);
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".rail .update-action")!.click(),
    );
    const checkbox = () =>
      host.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!;
    expect(host.querySelectorAll('dialog input[type="checkbox"]')).toHaveLength(
      1,
    );
    expect(checkbox().closest("label")?.textContent).toContain(
      "Automatically update Farol",
    );
    expect(checkbox().checked).toBe(false);
    expect(host.textContent).toContain(
      "Download and install updates when Farol is idle.",
    );
    expect(host.textContent).not.toContain(
      "Install downloaded updates when I quit Farol",
    );
    expect(host.textContent).not.toContain(
      "Automatic downloads do not grant permission",
    );
    expect(f.api.installedUpdate).not.toHaveBeenCalled();
    const waiting = deferred<unknown>();
    vi.mocked(f.api.installedUpdate).mockReturnValueOnce(waiting.promise);
    await act(async () => {
      checkbox().click();
      checkbox().click();
    });
    expect(checkbox().disabled).toBe(true);
    expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "set-automatic-update-preference",
      enabled: true,
      scope: "download-and-install",
    });
    await act(async () => waiting.reject(new Error("reply lost")));
    const original = c.getSnapshot().intents["update-automatic-downloads"];
    expect(original?.state).toBe("unknown");
    await act(async () => {
      c.overlay("none");
      f.emit("update", legacy);
    });
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".rail .update-action")!.click(),
    );
    expect(checkbox().disabled).toBe(true);
    expect(host.querySelector("dialog")?.textContent).toContain(
      "Do not repeat this change",
    );
    expect(c.getSnapshot().intents["update-automatic-downloads"]).toBe(
      original,
    );
    expect(button(host, "Remind Me Later").disabled).toBe(false);
  },
);

it("never grants automatic updating in a Dev sheet", async () => {
  const { host, f } = await mount(
    {
      phase: "available",
      version: available.version,
      deferred: false,
      automaticUpdatePreference: { status: "confirmed", enabled: true },
    },
    "dev",
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".rail .update-action")!.click(),
  );
  const checkbox = host.querySelector<HTMLInputElement>(
    'dialog input[type="checkbox"]',
  )!;
  expect(checkbox.disabled).toBe(true);
  expect(checkbox.checked).toBe(false);
  await act(async () => checkbox.click());
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});

it.each([
  available,
  {
    phase: "ready",
    version: available.version,
    deferred: false,
    blockedBy: null,
    notice: available.notice,
  },
  {
    phase: "failed",
    code: "UPDATE_CHECKSUM_MISMATCH",
    recoveryRequired: true,
    notice: { key: "failure:first", seen: false, blockedBy: null },
  },
] satisfies InstalledUpdateView[])(
  "dismisses only the quiet %j notice and retains rail/sheet and release truth",
  async (view) => {
    const { host, c, f } = await mount(view);
    expect(host.querySelector('[aria-label="Update notice"]')).not.toBeNull();
    expect(host.querySelector(".rail .update-dot")).not.toBeNull();
    const pending = deferred<unknown>();
    vi.mocked(f.api.installedUpdate).mockReturnValueOnce(pending.promise);
    await act(async () => button(host, "Dismiss update notice").click());
    expect(host.querySelector('[aria-label="Update notice"]')).not.toBeNull();
    expect(c.getSnapshot().intents["update-notice"]?.state).toBe("pending");
    await act(async () => pending.resolve(withSeen(view)));
    expect(host.querySelector('[aria-label="Update notice"]')).toBeNull();
    expect(host.querySelector(".rail .update-action")).not.toBeNull();
    expect(host.querySelector(".rail .update-dot")).toBeNull();
    expect(c.getSnapshot().update).toEqual(withSeen(view));
    expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
      kind: "notice-seen",
      noticeKey: view.notice!.key,
    });
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".rail .update-action")!.click(),
    );
    expect(host.querySelector("dialog h2")?.textContent).toBe(
      view.phase === "available"
        ? "Update available"
        : view.phase === "ready"
          ? "Ready to install"
          : "The update did not finish",
    );
    expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
  },
);
it("viewing the sheet acknowledges the exact notice once under StrictMode without an update operation", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockResolvedValue(withSeen(available));
  await act(async () => button(host, "View update").click());
  expect(host.querySelector("dialog h2")?.textContent).toBe("Update available");
  expect(c.getSnapshot().update).toEqual(withSeen(available));
  expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
    kind: "notice-seen",
    noticeKey: available.notice!.key,
  });
});
it("reopened windows hide a seen version while a newer version and failure each surface again", async () => {
  const { host, f } = await mount(withSeen(available));
  expect(host.querySelector('[aria-label="Update notice"]')).toBeNull();
  await act(async () =>
    f.emit("update", {
      ...available,
      version: "0.2.1",
      notice: { key: "version:0.2.1", seen: false, blockedBy: null },
    }),
  );
  expect(
    host.querySelector('[aria-label="Update notice"]')?.textContent,
  ).toContain("0.2.1");
  await act(async () =>
    f.emit("update", {
      phase: "failed",
      code: "UPDATE_DOWNLOAD_FAILED",
      recoveryRequired: false,
      notice: { key: "failure:new", seen: false, blockedBy: null },
    }),
  );
  expect(
    host.querySelector('[aria-label="Update notice"]')?.textContent,
  ).toContain("The update did not finish");
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it("missing host dispatch refuses acknowledgement without hiding or deferring the notice", async () => {
  const { host, c, f } = await mount();
  await act(async () => button(host, "Dismiss update notice").click());
  expect(c.getSnapshot().intents["update-notice"]).toMatchObject({
    state: "refused",
    code: "UPDATE_NOTICE_NOT_ACKNOWLEDGED",
  });
  expect(host.querySelector('[aria-label="Update notice"]')).not.toBeNull();
  expect(c.getSnapshot().update).toEqual(available);
  expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
    kind: "notice-seen",
    noticeKey: available.notice!.key,
  });
});
it("lost notice replies stay unknown and cannot be retried or used to release an operation", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockRejectedValue(new Error("reply lost"));
  await act(async () => button(host, "Dismiss update notice").click());
  expect(c.getSnapshot().intents["update-notice"]?.state).toBe("unknown");
  expect(host.querySelector('[aria-label="Update notice"]')).not.toBeNull();
  expect(button(host, "Dismiss update notice").disabled).toBe(true);
  await act(async () => c.update("notice-seen", available.notice!.key));
  vi.mocked(f.api.installedUpdate).mockResolvedValue({ phase: "downloading" });
  await act(async () =>
    expect((await c.update("download")).state).toBe("applied"),
  );
  expect(c.getSnapshot().intents["update-notice"]?.state).toBe("unknown");
  expect(f.api.installedUpdate).toHaveBeenCalledTimes(2);
  expect(f.api.installedUpdate).toHaveBeenLastCalledWith({ kind: "download" });
});
it("a known preference refusal keeps the notice visible and remains inspectable without blocking update actions", async () => {
  const { host, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockResolvedValue({
    ...available,
    notice: {
      ...available.notice!,
      blockedBy: "UPDATE_PREFERENCES_UNREADABLE",
    },
  });
  await act(async () => button(host, "Dismiss update notice").click());
  expect(host.querySelector('[aria-label="Update notice"]')).not.toBeNull();
  expect(button(host, "Dismiss update notice").disabled).toBe(true);
  await act(async () => button(host, "View update").click());
  expect(host.querySelector("dialog")?.textContent).toContain(
    "Saved update notices could not be confirmed",
  );
  expect(host.querySelector("dialog")?.textContent).toContain(
    "Update actions retain their separate safety checks",
  );
  expect(host.querySelector("dialog")?.textContent).not.toContain(
    "Update actions are paused",
  );
  expect(button(host, "Download and Install").disabled).toBe(false);
  expect(f.api.installedUpdate).toHaveBeenCalledTimes(1);
});
it("acknowledging a notice never clears an unknown update intention even after a fresh status event", async () => {
  const { host, c, f } = await mount();
  vi.mocked(f.api.installedUpdate).mockRejectedValue(
    new Error("update reply lost"),
  );
  await act(async () => c.update("download"));
  expect(c.getSnapshot().intents.update?.state).toBe("unknown");
  await act(async () => f.emit("update", available));
  expect(button(host, "Dismiss update notice").disabled).toBe(true);
  expect((await c.update("notice-seen", available.notice!.key)).state).toBe(
    "refused",
  );
  expect(c.getSnapshot().intents.update?.state).toBe("unknown");
  expect(f.api.installedUpdate).toHaveBeenCalledExactlyOnceWith({
    kind: "download",
  });
});
it("a late acknowledgement reply cannot overwrite a newer update event", async () => {
  const { host, c, f } = await mount();
  const pending = deferred<unknown>();
  vi.mocked(f.api.installedUpdate).mockReturnValueOnce(pending.promise);
  await act(async () => button(host, "Dismiss update notice").click());
  const newer = {
    ...available,
    version: "0.2.1",
    notice: { key: "version:0.2.1", seen: false, blockedBy: null },
  };
  await act(async () => f.emit("update", newer));
  await act(async () => pending.resolve(withSeen(available)));
  expect(c.getSnapshot().update).toEqual(newer);
  expect(
    host.querySelector('[aria-label="Update notice"]')?.textContent,
  ).toContain("0.2.1");
});
it("unknown release state remains inspectable and cannot be acknowledged", async () => {
  const failed: InstalledUpdateView = {
    phase: "failed",
    code: "UPDATE_HANDOFF_UNKNOWN",
    recoveryRequired: true,
    notice: { key: "failure:unknown", seen: false, blockedBy: null },
  };
  const { host, c, f } = await mount(failed);
  expect(button(host, "Dismiss update notice").disabled).toBe(true);
  await act(async () => button(host, "View update").click());
  expect(host.querySelector("dialog")?.textContent).toContain(
    "UPDATE_HANDOFF_UNKNOWN",
  );
  expect((await c.update("notice-seen", failed.notice!.key)).state).toBe(
    "refused",
  );
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it("offers explicit confirmation when browser activity could not be observed", async () => {
  const blocked: InstalledUpdateView = {
    phase: "ready",
    version: available.version,
    deferred: false,
    blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN",
    notice: available.notice,
  };
  const { host, f } = await mount(blocked);
  const notice = host.querySelector('[aria-label="Update notice"]')!;
  expect(notice.textContent).toContain("is downloaded");
  expect(notice.textContent).toContain("Ready to install");
  expect(notice.textContent).not.toContain("Do not retry this update action");
  expect(button(notice, "Dismiss update notice").disabled).toBe(true);
  await act(async () => button(notice, "View update").click());
  expect(host.querySelector("dialog")?.textContent).toContain(
    "close open ChatGPT sessions and interrupt work",
  );
  expect(button(host, "Install and Relaunch").disabled).toBe(false);
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
it("notice contracts reject unbound or malformed commands and metadata", () => {
  expect(
    InstalledUpdateCommandSchema.safeParse({ kind: "notice-seen" }).success,
  ).toBe(false);
  expect(
    InstalledUpdateCommandSchema.safeParse({
      kind: "notice-seen",
      noticeKey: "",
    }).success,
  ).toBe(false);
  expect(
    InstalledUpdateCommandSchema.safeParse({
      kind: "notice-seen",
      noticeKey: "version:1",
      skip: true,
    }).success,
  ).toBe(false);
  expect(
    InstalledUpdateViewSchema.safeParse({
      ...available,
      notice: { key: "version:1", seen: "yes", blockedBy: null },
    }).success,
  ).toBe(false);
});

it("keeps the quiet notice out of the sidebar overlay without acknowledging it", async () => {
  const { host, c, f } = await mount();
  await act(async () => c.toggleSidebar(true));
  expect(host.querySelector('[aria-label="Update notice"]')).toBeNull();
  await act(async () => c.toggleSidebar(false));
  expect(host.querySelector('[aria-label="Update notice"]')).not.toBeNull();
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
});
