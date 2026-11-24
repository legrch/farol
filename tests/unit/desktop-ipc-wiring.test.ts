import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The IPC table lives in apps/desktop/shell/ipc.ts and is tested there with a
// recording ipcMain and injected ports. Nothing else checks which main-process
// state each port reads or writes, so a swapped getter or setter would pass
// every other test. This asserts the wiring as text; it executes nothing from
// main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);
const factorySource = path.resolve(
  import.meta.dirname,
  "../../apps/desktop/shell/ipc.ts",
);

async function wrapper(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const header = "function installIpc(): void {";
  const begin = source.indexOf(header);
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, body };
}

describe("IPC table wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, body } = await wrapper();
    for (const name of [
      "window",
      "configuration",
      "startupConnectionChecking",
      "desktopGoCore",
      "runtime",
      "section",
      "setupOpen",
      "shellOverlay",
      "selectedTaskId",
      "chatGptRoute",
    ]) {
      expect(body).toContain(` ${name}: () => ${name},`);
      // A lent variable stays a `let` main owns, not a copy taken at install.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("gives the one assignment a setter to the let it names", async () => {
    const { source, body } = await wrapper();
    expect(body).toContain(
      "setNavigationShortcuts: (value) => { navigationShortcuts = value; },",
    );
    // Exactly this one let is assigned by the table, and no other.
    expect(body.match(/\(value\) => \{/g)).toHaveLength(1);
    expect(source).toMatch(/\nlet navigationShortcuts\b/);
  });

  it("shares each const owner and main helper by reference", async () => {
    const { source, body } = await wrapper();
    for (const name of [
      "ipcMain",
      "updatesPanel",
      "installedUpdates",
      "desktopAdmission",
      "windowMode",
      "UPDATES_PANEL_SIZE",
      "selectedVisibleTestPlacement",
      "operationsStore",
      "connectionAdmissionInProgress",
      "runSelfTestCommand",
      "bootstrap",
      "runtimeJson",
      "configureProduct",
      "configurationFailure",
      "readChatHistoryView",
      "readRetiredRepliesView",
      "runProductTaskCommand",
      "taskFailure",
      "installApplicationMenu",
      "controlSchema",
      "runContextFixtureControl",
      "expectedTasks",
      "taskSurfaceFailures",
      "pendingComputer",
      "liveTaskRoutes",
      "applyRendererLayout",
    ]) {
      expect(body).toContain(` ${name},`);
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
    expect(body).toContain(
      " installedUpdateCommandSchema: InstalledUpdateCommandSchema,",
    );
  });

  it("does not lend the sender-trust predicate or the channel names", async () => {
    const { source, body } = await wrapper();
    // The predicate and the names are imported where the handlers are, so no
    // caller can swap the check a handler makes.
    expect(body).not.toContain("isTrustedIpcSender");
    expect(body).not.toContain("channels");
    expect(source).not.toContain("isTrustedIpcSender");
    const factory = await readFile(factorySource, "utf8");
    expect(factory).toContain(
      'import { isTrustedIpcSender } from "../../../src/apps/desktop/ipc-sender";',
    );
    expect(factory).toContain(
      'import { channels } from "../../../src/pkg/ipc/channels";',
    );
  });

  it("keeps only a thin wrapper in main that installs once at the same call site", async () => {
    const { source, body } = await wrapper();
    expect(body.startsWith("function installIpc(): void { createIpc({")).toBe(
      true,
    );
    expect(body.endsWith("}).install(); }")).toBe(true);
    expect(source.match(/\n {2}installIpc\(\);\n/g)).toHaveLength(1);
  });

  it("leaves none of the registrations behind", async () => {
    const { source } = await wrapper();
    expect(source).not.toContain("ipcMain.on(");
    expect(source).not.toContain("ipcMain.handle(");
    for (const fragment of [
      "IPC_SENDER_DENIED",
      "SELF_TEST_UNAVAILABLE",
      "CONTROL_NOT_PENDING",
      "DESKTOP_UPDATES_PRESENTATION_FAILED",
    ])
      expect(source).not.toContain(fragment);
  });
});
