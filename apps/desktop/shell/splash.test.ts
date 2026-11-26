import { describe, expect, it, vi } from "vitest";
import { openOwnerStartupSplash, type SplashPorts } from "./splash";

// The startup splash open over recording ports. The log is the order of every
// effect; the cases pin the three gate branches (window mode, background-only,
// E2E), the secondary-visible placement, the order the owner is written and
// the quit hook registered, and that any failure clears the owner and ends in
// silence rather than aborting startup.

const size = { width: 1180, height: 760 } as const;
const bounds = { x: -1500, y: 40, width: 1180, height: 760 } as const;

function fixture(overrides: Partial<SplashPorts> = {}, e2e = false) {
  const log: string[] = [];
  const open = vi.fn<SplashPorts["open"]>(() => {
    log.push("open");
    return { close: () => void log.push("close") };
  });
  const ports: SplashPorts = {
    windowMode: "default",
    ownerBackgroundOnly: false,
    e2e: () => {
      log.push("e2e");
      return e2e;
    },
    title: "Farol",
    size,
    iconDataUrl: () => {
      log.push("icon");
      return "data:image/png;base64,AAAA";
    },
    placement: (requested) => {
      log.push(`place:${requested.width}x${requested.height}`);
      return { bounds };
    },
    open,
    setSplash: (splash) => void log.push(splash ? "owner:set" : "owner:null"),
    closeOnBeforeQuit: () => void log.push("quit-hook"),
    ...overrides,
  };
  return { ports, log, open };
}

describe("owner startup splash", () => {
  it("opens an ordinary owner launch, then writes the owner, then hooks quit", () => {
    const { ports, log, open } = fixture();
    openOwnerStartupSplash(ports);
    expect(open).toHaveBeenCalledWith({
      title: "Farol",
      width: 1180,
      height: 760,
      iconDataUrl: "data:image/png;base64,AAAA",
    });
    expect(log).toEqual(["e2e", "icon", "open", "owner:set", "quit-hook"]);
  });

  it("places a secondary-visible splash inactive on its display", () => {
    const { ports, log, open } = fixture({ windowMode: "secondary-visible" });
    openOwnerStartupSplash(ports);
    expect(open).toHaveBeenCalledWith({
      title: "Farol",
      width: 1180,
      height: 760,
      iconDataUrl: "data:image/png;base64,AAAA",
      bounds,
      inactive: true,
    });
    // The icon is read before the placement, as the options are composed.
    expect(log).toEqual([
      "e2e",
      "icon",
      "place:1180x760",
      "open",
      "owner:set",
      "quit-hook",
    ]);
  });

  it.each([
    ["a hidden window", { windowMode: "hidden" as const }],
    ["an owner background-only launch", { ownerBackgroundOnly: true }],
  ])("opens nothing for %s and never reads the E2E flag", (_name, change) => {
    const { ports, log, open } = fixture(change);
    openOwnerStartupSplash(ports);
    expect(open).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("opens nothing in the E2E lane", () => {
    const { ports, log, open } = fixture({}, true);
    openOwnerStartupSplash(ports);
    expect(open).not.toHaveBeenCalled();
    expect(log).toEqual(["e2e"]);
  });

  it("clears the owner and stays silent when the open throws", () => {
    const { ports, log } = fixture({
      open: () => {
        throw new Error("no window");
      },
    });
    expect(() => openOwnerStartupSplash(ports)).not.toThrow();
    expect(log).toEqual(["e2e", "icon", "owner:null"]);
  });

  it("clears the owner when the icon cannot be read, before any open", () => {
    const { ports, log, open } = fixture({
      iconDataUrl: () => {
        throw new Error("icon");
      },
    });
    openOwnerStartupSplash(ports);
    expect(open).not.toHaveBeenCalled();
    expect(log).toEqual(["e2e", "owner:null"]);
  });

  it("clears the owner when the secondary placement throws", () => {
    const { ports, log, open } = fixture({
      windowMode: "secondary-visible",
      placement: () => {
        throw new Error("display gone");
      },
    });
    openOwnerStartupSplash(ports);
    expect(open).not.toHaveBeenCalled();
    expect(log).toEqual(["e2e", "icon", "owner:null"]);
  });

  it("clears the owner after it was set when the quit hook cannot register", () => {
    const { ports, log } = fixture({
      closeOnBeforeQuit: () => {
        throw new Error("app");
      },
    });
    openOwnerStartupSplash(ports);
    expect(log).toEqual(["e2e", "icon", "open", "owner:set", "owner:null"]);
  });
});
