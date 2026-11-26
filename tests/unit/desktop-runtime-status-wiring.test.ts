import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The runtime status lives in apps/desktop/runtime/status.ts and is tested
// there with injected ports. Nothing else checks which main-process state each
// port reads, that the wrappers main keeps still reach the one owner, or that
// every consumer still gets them by their old names, so a swapped getter or a
// port left on a stale copy would pass every other test. This asserts the
// wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function read(): Promise<{ source: string; flat: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function runtimeStatus() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, flat: source.replace(/\s+/g, " "), body };
}

describe("runtime status wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, body } = await read();
    for (const name of [
      "runtime",
      "runtimeState",
      "runtimeError",
      "window",
      "desktopGoCore",
      "configuration",
      "selectedTaskId",
      "chatGptRoute",
      "recoverableChatGptTask",
      "chatGptSignInOutcome",
    ]) {
      expect(body).toContain(`${name}: () => ${name},`);
      // A lent variable stays a `let` main owns, not a copy taken at creation.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("shares the const owners and the function ports by reference", async () => {
    const { source, body } = await read();
    expect(body).toContain(
      " liveTaskRoutes, recoverableChatGptTask: () => recoverableChatGptTask, chatGptSignInOutcome: () => chatGptSignInOutcome, chatGptSignInBlocked, nativeImage,",
    );
    expect(body).toContain(
      " directory, env: process.env, versions: process.versions, productName, bundleId, activeDesktopIdentity, buildIdentity, demoMode, legacySetupTestMode, compiledGoCore, WORKSPACE_EDIT_ACK_HOLD_ENV, WORKSPACE_EDIT_ACK_HOLD_INVALID, e2eBudget, productTasksState, currentConnectionStatus, chatGptConversationState, productAgentCapabilityAvailable, currentWindowState, }",
    );
    for (const owner of [
      "liveTaskRoutes",
      "chatGptSignInBlocked",
      "directory",
      "productName",
      "bundleId",
      "buildIdentity",
      "compiledGoCore",
    ])
      expect(source).toMatch(new RegExp(`\\nconst ${owner}\\b`));
    // The launch flags are read once, at import time, by the launch host.
    expect(source).toMatch(
      /\nconst \{[^}]*\bdemoMode,[^}]*\blegacySetupTestMode,[^}]*\} = readLaunchArguments\(process\.argv, process\.env, buildEnvironment\);/,
    );
    for (const fn of [
      "productTasksState",
      "chatGptConversationState",
      "productAgentCapabilityAvailable",
    ])
      expect(source).toMatch(new RegExp(`\\nfunction ${fn}\\(`));
    // The settled-at-load owners come from their own declarations.
    expect(source).toMatch(/\nconst \{[^}]*\bcurrentConnectionStatus,/);
    expect(source).toMatch(/\nconst \{[^}]*\bcurrentWindowState,/);
    // The environment guard stays the module's own, never a copy in main.
    expect(source).toContain(
      'import {\n  WORKSPACE_EDIT_ACK_HOLD_ENV,\n  WORKSPACE_EDIT_ACK_HOLD_INVALID,\n  createConfigurationReplyFault,\n  e2eBudget,\n} from "./configuration-reply-fault";',
    );
  });

  it("reaches the request function at the call, through the global", async () => {
    const { body } = await read();
    // A stub installed on the global after start is still the one called.
    expect(body).toContain("fetch: (input, init) => fetch(input, init),");
  });

  it("builds the status lazily and caches it", async () => {
    const { source, body } = await read();
    expect(body).toContain("(runtimeStatusCache ??= createRuntimeStatus({");
    expect(source).toContain("let runtimeStatusCache");
  });

  it("keeps thin wrappers that delegate to the one status under the old names", async () => {
    const { flat } = await read();
    for (const wrapper of [
      "function runtimeBase(): string | null { return runtimeStatus().runtimeBase(); }",
      "function bootstrap() { return runtimeStatus().bootstrap(); }",
      "function publishRuntimeStatus(): void { runtimeStatus().publishRuntimeStatus(); }",
      "function desktopBrandImage() { return runtimeStatus().desktopBrandImage(); }",
      'function runtimeJson( pathname: string, method = "GET", body?: unknown, ): Promise<unknown> { return runtimeStatus().runtimeJson(pathname, method, body); }',
    ])
      expect(flat).toContain(wrapper);
  });

  it("no longer owns the payload, the status event, the mark or the runtime call", async () => {
    const { source } = await read();
    for (const moved of [
      "schema: 3,",
      "e2eWorkspaceEditAckHold",
      "function currentRuntimeStatus",
      "RUNTIME_OFFLINE",
      "DESKTOP_BRAND_IMAGE_INVALID",
      "farol-dev-mark.png",
      "farol-preview-mark.png",
      "nativeImage.createFromPath",
      "channels.runtimeState",
      "authorization: `Bearer",
    ])
      expect(source).not.toContain(moved);
  });

  it("still lends the wrappers to every consumer by their old names", async () => {
    const { flat } = await read();
    // The task surfaces take the base address.
    expect(flat).toContain(
      " runtimePartition: activeDesktopIdentity.runtimePartition, signInSurfaceId: SIGN_IN_SURFACE_ID, session, runtimeBase,",
    );
    // The preview runtime publishes the status event.
    expect(flat).toContain(" publishRuntimeStatus,");
    // The IPC table takes the payload and the runtime call.
    expect(flat).toContain(" bootstrap, runtimeJson, configureProduct,");
    // The About panel, the Dock and the splash take the mark.
    expect(flat).toContain("icon: () => desktopBrandImage().toDataURL(),");
    expect(flat).toContain("app.dock?.setIcon(desktopBrandImage());");
    expect(flat).toContain(
      "iconDataUrl: () => desktopBrandImage().toDataURL(),",
    );
  });
});
