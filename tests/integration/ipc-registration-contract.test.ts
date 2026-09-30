import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// S35-TA-9. This guards REGISTRATION COMPLETENESS, not runtime behaviour.
//
// What the predicate does when it runs is covered by the eight cases in
// `tests/unit/ipc-sender.test.ts`, which call `isTrustedIpcSender` directly.
// What no runtime test can cover is the handler nobody wrote yet: the
// registrations live inside `installIpc` in `main.ts`, which exports nothing
// and which no test loads, so there is no way to enumerate them by calling
// anything. The regression this file exists for is another privileged
// channel, registered next year by someone who does not notice that checking
// the sender is part of registering one.
//
// So it reads the source. That is a real technique in this repository, not an
// improvisation: `watch-rail-product-contract.test.mjs` already asserts on
// `main.ts` as text for the same reason. It is a weaker kind of evidence than
// executing the code, and the limits are worth stating plainly: it would not
// notice a handler that calls the predicate and ignores the answer, and it
// matches text rather than understanding it. It catches the one mistake that
// is actually likely, which is forgetting.
//
// Note on scope: only these registered channels are renderer-to-main. The others
// are main-to-renderer sends and correctly have no sender check, which is why
// this counts registrations rather than
// iterating the channel list — a test built on the channel list would demand
// checks on outbound channels and be wrong.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

/**
 * Every `ipcMain.handle(...)` / `ipcMain.on(...)` in `main.ts`, with the body
 * that follows it up to the next registration (or the end of `installIpc`).
 */
async function registrations(): Promise<
  ReadonlyArray<Readonly<{ channel: string; body: string }>>
> {
  const source = await fs.readFile(mainSource, "utf8");
  const pattern = /ipcMain\.(?:handle|on)\(\s*channels\.(\w+)/gu;
  const found: { channel: string; index: number }[] = [];
  for (const match of source.matchAll(pattern)) {
    found.push({ channel: match[1]!, index: match.index });
  }
  return found.map((entry, position) => ({
    channel: entry.channel,
    body: source.slice(
      entry.index,
      found[position + 1]?.index ?? entry.index + 4_000,
    ),
  }));
}

describe("privileged IPC registration contract", () => {
  it("S35-TA-9 every ipcMain registration checks the sender through the named predicate", async () => {
    const found = await registrations();

    // If this list changes, the change is the point: a new privileged
    // channel must be added here deliberately, with its check.
    expect(found.map((entry) => entry.channel)).toEqual([
      "installedUpdate",
      "bootstrap",
      "snapshot",
      "configuration",
      "task",
      "navigationShortcuts",
      "control",
      "layout",
    ]);

    const unchecked = found.filter(
      (entry) => !entry.body.includes("isTrustedIpcSender(event, window)"),
    );
    expect(unchecked.map((entry) => entry.channel)).toEqual([]);
  });

  it("S35-TA-9 no registration compares the sender inline instead of using the predicate", async () => {
    // The existing copies were each correct; repetition is how another
    // handler comes to be written without one. A reviewer looking for the
    // check should find one spelling of it, not a family of them.
    const source = await fs.readFile(mainSource, "utf8");
    expect(source).not.toContain("event.sender === window?.webContents");
    expect(source).not.toContain("event.sender !== window?.webContents");
  });

  it("S35-TA-9 the predicate this file names is the one main.ts imports", async () => {
    // Guards the test itself: a renamed or removed export would otherwise
    // leave both assertions above passing against a string that means
    // nothing.
    const source = await fs.readFile(mainSource, "utf8");
    expect(source).toContain(
      'import { isTrustedIpcSender } from "./ipc-sender"',
    );
    const module = await import("../../src/apps/desktop/ipc-sender");
    expect(typeof module.isTrustedIpcSender).toBe("function");
  });
});
