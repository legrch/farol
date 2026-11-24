import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The caller relay and the saved-chat bridge live in
// apps/desktop/runtime/bridge.ts and are tested there with injected ports.
// Nothing else checks which main-process state each port reads, or that every
// reader in main still reads the owner's cell at the place it always did, so a
// swapped getter or a reader left on a stale copy would pass every other test.
// This asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function read(): Promise<{ source: string; block: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("\nconst bridge = createBridge({");
  expect(begin).toBeGreaterThanOrEqual(0);
  const block = source
    .slice(begin, source.indexOf("\n});\n", begin) + 4)
    .replace(/\s+/g, " ");
  return { source, block };
}

describe("relay and saved-chat bridge wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, block } = await read();
    for (const name of [
      "configuration",
      "summaryExecutionFence",
      "window",
      "chatGptHomeUrl",
      "chatGptE2eOrigin",
    ]) {
      expect(block).toContain(` ${name}: () => ${name},`);
      // A lent variable stays a `let` main owns, not a copy taken at creation.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("shares each const owner and main helper by reference, assigning nothing back", async () => {
    const { source, block } = await read();
    for (const name of [
      "statePaths",
      "isolatedE2EHome",
      "runtimeEnvironment",
      "activeDesktopIdentity",
      "buildIdentity",
      "createManagedChatGptRoute",
      "startCodexCallerRelay",
      "startSavedChatBridge",
    ]) {
      expect(block).toContain(` ${name},`);
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
    expect(block).toContain(" env: process.env,");
    expect(block).not.toMatch(/\(value\) =>/);
    expect(block).not.toMatch(/ set[A-Z]\w*:/);
  });

  it("builds the handoff from the private journal, the digester and the canonical URL", async () => {
    const { block } = await read();
    expect(block).toContain(
      " createSavedChatHandoff: (root, canonical, browser, approve) => new PersistentChatGptHandoff( new PrivateSavedChatJournal(root, canonical), browser, new Sha256SavedChatDigester(), canonical, approve, ),",
    );
    expect(block).toContain(
      " showMessageBox: (owner, options) => dialog.showMessageBox(owner, options),",
    );
  });

  it("declares no relay or bridge handle in main and keeps neither initializer", async () => {
    const { source } = await read();
    expect(source).not.toMatch(/\bcallerRelayRuntime\b/);
    expect(source).not.toMatch(/\bcallerRelayDirectoryWitness\b/);
    // The drain's port keeps its name; main no longer owns a variable of it.
    expect(source).not.toMatch(/\n\s*let savedChatBridgeRuntime\b/);
    expect(source).not.toMatch(/\bsavedChatBridgeRuntime\s*=[^=>]/);
    expect(source).not.toContain("function initializeCallerRelay");
    expect(source).not.toContain("function initializeSavedChatBridge");
    expect(source).toContain("const bridge = createBridge({");
  });

  it("creates the owner before anything reads it, at module level", async () => {
    const { source } = await read();
    const created = source.indexOf("\nconst bridge = createBridge({");
    expect(created).toBeGreaterThan(
      source.indexOf("\nlet summaryExecutionFence"),
    );
    expect(created).toBeGreaterThan(
      source.indexOf("\nlet taskCountsBeforeRuntimeExit"),
    );
    expect(created).toBeLessThan(source.indexOf("\nasync function main("));
    expect(source.match(/createBridge\(/g)).toHaveLength(1);
  });

  it("reads the directory witness through its cell for the E2E readback only", async () => {
    const { source } = await read();
    expect(source).toContain(
      'if (process.env.FAROL_E2E === "1") {\n  // Main-process metadata readback only: no token, socket client or control API.\n  Object.defineProperty(app, "__farolE2ERelayDirectory", {\n    get: () => bridge.directoryWitness.get(),\n  });\n}',
    );
    expect(source.match(/directoryWitness/g)).toHaveLength(1);
  });

  it("starts the relay, then the bridge, between context recovery and Route B", async () => {
    const { source } = await read();
    expect(source.replace(/\s+/g, " ")).toContain(
      "await initializeCodexContextController(); await reconcileContextAfterRestart(); await bridge.initializeCallerRelay(); await bridge.initializeSavedChatBridge(); await initializeRouteBRuntime(); });",
    );
    expect(source.match(/bridge\.initializeCallerRelay\(/g)).toHaveLength(1);
    expect(source.match(/bridge\.initializeSavedChatBridge\(/g)).toHaveLength(
      1,
    );
  });

  it("hands Route B the relay read once, before the start", async () => {
    const { source } = await read();
    const flat = source.replace(/\s+/g, " ");
    expect(flat).toContain(
      "if (!controller || routeBRuntime) return; const relay = bridge.relay.get(); try { routeBRuntime = await startRouteBRuntime({ stateRoot: statePaths().state, surfaces: routeBTaskSurfaces, compaction: controller.continuity, ...(relay ? { relay } : {}), });",
    );
  });

  it("captures the default bridge at stop entry and clears only the one it closed", async () => {
    const { source } = await read();
    const flat = source.replace(/\s+/g, " ");
    expect(flat).toContain(
      "core = desktopGoCore, savedChat = bridge.saved.get(),",
    );
    expect(
      flat.match(
        /await savedChat\.close\(\); if \(bridge\.saved\.get\(\) === savedChat\) bridge\.saved\.set\(null\);/g,
      ),
    ).toHaveLength(2);
  });

  it("reads the bridge once at Quit and clears the relay as it is collected", async () => {
    const { source } = await read();
    const flat = source.replace(/\s+/g, " ");
    expect(flat).toContain(
      "const core = desktopGoCore; const savedChat = bridge.saved.get(); const quitStartDeadlineAt =",
    );
    expect(flat).toContain(
      '} else if (savedChat) { bridge.saved.set(null); beforeCore = { name: "saved-chat-bridge", close: () => savedChat.close(), }; }',
    );
    expect(flat).toContain(
      'const relay = bridge.relay.get(); bridge.relay.set(null); if (relay) closers.push({ name: "caller-relay", close: () => relay.close() });',
    );
    // Quit closes the relay after Route B, as before.
    expect(flat.indexOf('name: "route-b"')).toBeLessThan(
      flat.indexOf("const relay = bridge.relay.get(); bridge.relay.set(null);"),
    );
  });

  it("lends the bridge to the configuration drain as a getter on its cell", async () => {
    const { source } = await read();
    expect(source).toContain(
      "    savedChatBridgeRuntime: () => bridge.saved.get(),",
    );
  });
});
