import { describe, expect, it } from "vitest";

import { isTrustedIpcSender } from "../../src/apps/desktop/ipc-sender";

// S35-TA-9. The privileged IPC channels — bootstrap, snapshot,
// configuration, task, control, layout — are how the renderer changes
// settings, starts tasks and reads runtime state. Each handler compared
// `event.sender` with `window?.webContents` itself. The cases below are the
// ones an inline comparison gets wrong by accident, and the reason the check
// is now a named predicate rather than six copies.

const webContents = { id: "the-one-window" };
const trustedWindow = { webContents };

describe("trusted IPC sender", () => {
  it("S35-TA-9 accepts the window this process owns", () => {
    expect(isTrustedIpcSender({ sender: webContents }, trustedWindow)).toBe(
      true,
    );
  });

  it("S35-TA-9 refuses a sender that is not this window's webContents", () => {
    expect(
      isTrustedIpcSender({ sender: { id: "somewhere-else" } }, trustedWindow),
    ).toBe(false);
  });

  // The states where there is nothing to compare against. Before the window
  // exists and after it is gone, `window?.webContents` is `undefined`, and
  // `undefined === undefined` is true — so a bare comparison would accept an
  // event whose sender was also undefined, at exactly the moment no window
  // owns the channel.
  //
  // Being accurate about this: Electron always supplies a real `WebContents`
  // on `event.sender`, so that is not a hole anyone can reach through the
  // product today, and the six inline comparisons were not a live defect.
  // It is a shape the types permit and the predicate forecloses, which is
  // worth having because the predicate is what a seventh handler will copy.
  const nothingToCompareAgainst: ReadonlyArray<
    Readonly<{ name: string; window: Parameters<typeof isTrustedIpcSender>[1] }>
  > = [
    { name: "no window yet", window: null },
    { name: "the window reference is undefined", window: undefined },
    {
      name: "a window whose webContents is gone",
      window: { webContents: undefined },
    },
    {
      name: "a window whose webContents is null",
      window: { webContents: null },
    },
  ];

  for (const row of nothingToCompareAgainst) {
    it(`S35-TA-9 refuses every sender when there is ${row.name}`, () => {
      expect(isTrustedIpcSender({ sender: undefined }, row.window)).toBe(false);
      expect(isTrustedIpcSender({ sender: null }, row.window)).toBe(false);
      expect(isTrustedIpcSender({ sender: webContents }, row.window)).toBe(
        false,
      );
    });
  }

  it("S35-TA-9 refuses a missing event rather than treating it as the window's", () => {
    expect(isTrustedIpcSender(null, trustedWindow)).toBe(false);
    expect(isTrustedIpcSender(undefined, trustedWindow)).toBe(false);
  });

  it("S35-TA-9 refuses the old window's event once a new window owns the channel", () => {
    // A reopen replaces the window. An event still in flight from the old
    // one is not from the window this process owns now, and a channel that
    // can change settings or start a task must not accept it.
    const reopened = { webContents: { id: "the-new-window" } };
    expect(isTrustedIpcSender({ sender: webContents }, reopened)).toBe(false);
  });
});
