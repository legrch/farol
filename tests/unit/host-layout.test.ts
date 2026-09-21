import { describe, expect, it } from "vitest";
import {
  hostLayoutChanged,
  hostLayoutUpdate,
  type HostLayout,
  type RendererLayout,
} from "../../src/ui/host-layout";

const push: HostLayout = {
  section: "browser",
  taskId: "task-1",
  setupOpen: false,
  sidebar: "full",
  overlay: "none",
};

describe("what the renderer adopts from a layout the host pushes", () => {
  it("carries no answer about whether an overlay is open", () => {
    // The defect this exists for: `shellOverlay` was assigned straight from
    // the payload, and the dialog follows `shellOverlay`. A push whose
    // mirror predated the renderer opening its task menu closed that menu
    // mid-keystroke, with no owner action and no shell action in the trace.
    // The shape of the update is the assertion: there is nothing here to
    // close an overlay with.
    expect(Object.keys(hostLayoutUpdate(push)).sort()).toEqual([
      "section",
      "setupOpen",
      "sidebarOverlayOpen",
      "sidebarPreference",
      "taskId",
    ]);
    expect(hostLayoutUpdate(push)).not.toHaveProperty("overlay");
    expect(hostLayoutUpdate(push)).not.toHaveProperty("shellOverlay");
  });

  it("ignores the overlay field whatever it says", () => {
    for (const overlay of ["none", "task-menu", "sidebar", "quick-switcher"]) {
      expect(hostLayoutUpdate({ ...push, overlay })).toEqual(
        hostLayoutUpdate(push),
      );
    }
  });

  it("still adopts the section and task main lays its surfaces out for", () => {
    const update = hostLayoutUpdate({
      ...push,
      section: "settings",
      taskId: "task-2",
      setupOpen: true,
    });
    expect(update.section).toBe("settings");
    expect(update.taskId).toBe("task-2");
    expect(update.setupOpen).toBe(true);
  });

  it("adopts a sidebar preference only when the push names one", () => {
    expect(
      hostLayoutUpdate({ ...push, sidebar: "full" }).sidebarPreference,
    ).toBe("full");
    expect(
      hostLayoutUpdate({ ...push, sidebar: "rail" }).sidebarPreference,
    ).toBe("rail");
    // "overlay" is a state, not a preference: adopting it as one would
    // change what the sidebar returns to when it stops being an overlay.
    expect(
      hostLayoutUpdate({ ...push, sidebar: "overlay" }).sidebarPreference,
    ).toBeNull();
  });

  it("opens the sidebar overlay exactly when the push says overlay", () => {
    expect(
      hostLayoutUpdate({ ...push, sidebar: "overlay" }).sidebarOverlayOpen,
    ).toBe(true);
    for (const sidebar of ["full", "rail"]) {
      expect(hostLayoutUpdate({ ...push, sidebar }).sidebarOverlayOpen).toBe(
        false,
      );
    }
  });
});

describe("whether a pushed layout moves anything the renderer holds", () => {
  const held: RendererLayout = {
    section: "browser",
    taskId: "task-1",
    setupOpen: false,
    sidebarPreference: "full",
    sidebarOverlayOpen: false,
  };
  const same: HostLayout = {
    section: "browser",
    taskId: "task-1",
    setupOpen: false,
    sidebar: "full",
    overlay: "none",
  };

  it("says no for the push that was actually measured", () => {
    // 1.76 s after a sign-in outcome, carrying the section and task the
    // renderer already had. The renderer rebuilt for it anyway, mid-word,
    // and the owner's "notes" was cut to "no".
    expect(hostLayoutChanged(hostLayoutUpdate(same), held)).toBe(false);
  });

  it("says no however the overlay field differs", () => {
    // The overlay is the field the host must never be believed about, so a
    // push differing only there moves nothing at all.
    for (const overlay of ["none", "task-menu", "sidebar"]) {
      expect(
        hostLayoutChanged(hostLayoutUpdate({ ...same, overlay }), held),
      ).toBe(false);
    }
  });

  it("says yes for each thing the host genuinely coordinates", () => {
    const cases: readonly HostLayout[] = [
      { ...same, section: "settings" },
      { ...same, taskId: "task-2" },
      { ...same, setupOpen: true },
      { ...same, sidebar: "rail" },
      { ...same, sidebar: "overlay" },
    ];
    for (const layout of cases) {
      expect(
        hostLayoutChanged(hostLayoutUpdate(layout), held),
        JSON.stringify(layout),
      ).toBe(true);
    }
  });

  it("does not call an absent sidebar preference a change", () => {
    // "overlay" carries no preference; comparing null against "full" would
    // make every overlay push look like a change and rebuild the menu.
    const update = hostLayoutUpdate({ ...same, sidebar: "overlay" });
    expect(update.sidebarPreference).toBeNull();
    expect(
      hostLayoutChanged(update, { ...held, sidebarOverlayOpen: true }),
    ).toBe(false);
  });
});
