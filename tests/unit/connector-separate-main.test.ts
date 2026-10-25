import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import { confirmSeparateAppVerificationAttempt } from "../../src/apps/desktop/connector-app-verification-attempt";
import { separateAppVerificationScopeCurrent } from "../../src/pkg/product-settings/separate-app-verification";
import { selectedConnectorApp } from "../../src/pkg/product-settings/connector-app-selection";
import { connectorWorkspaceSelection } from "../../src/pkg/product-settings/connector-workspace-selection";
import {
  fixtureBuildId,
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

// Execute actual desktop composition with synthetic ports, not an Electron,
// native-owner-dialog or provider witness. No source-string assertion of safety.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const functions = ["connectorAppBindingCurrent", "verifySecureMcpApp"]
  .map((name) => {
    const node = tree.program.body.find(
      (n) => n.type === "FunctionDeclaration" && n.id?.name === name,
    );
    if (!node || node.start == null || node.end == null)
      throw Error("VERIFICATION_COMPOSITION_MISSING");
    return source.slice(node.start, node.end);
  })
  .join("\n");

function fixture() {
  const settings = guidedSettingsFixture(),
    connector = settings.connectors.secureMcp;
  connector.attachment = null;
  connector.appVerificationPending = true;
  connector.chatgptApp = {
    name: "Farol Dev",
    tunnelId: connector.tunnelId!,
    connectorGeneration: 1,
  };
  connector.challenge = {
    value: "00000000-0000-4000-8000-000000000003",
    challengeSha256: "c".repeat(64),
    runtimeGeneration: "b".repeat(64),
    computerGeneration: 1,
    buildId: fixtureBuildId,
    preparedAt: "2026-01-01T00:00:00.000Z",
  };
  settings.setup.connect.outcomeUnknown = true;
  const expected = {
    ownerAuthorized: true as const,
    appName: "Farol Dev",
    tunnelId: connector.tunnelId!,
    connectorGeneration: 1,
    computerGeneration: 1,
    runtimeGeneration: "b".repeat(64),
    buildId: fixtureBuildId,
    workspaceId: fixtureWorkspaceId,
    challengeSha256: "c".repeat(64),
  };
  const binding = {
    buildId: fixtureBuildId,
    profileId: "profile",
    backendGeneration: "backend",
    runtimeId: "runtime",
    connectorGeneration: "1",
  };
  const nativeConfirmation = vi.fn(
    async (_owner: unknown, _options: unknown) => ({ response: 0 }),
  );
  const prepare = vi.fn(async () => {}),
    send = vi.fn();
  const clearOld = vi.fn(async () => ({ ok: true }));
  const readGo = vi.fn(async () => ({ binding }));
  const route = vi.fn(
    async (
      _prompt: string,
      _files: unknown[],
      hooks: { onDispatchIntent(): Promise<void> },
    ): Promise<{ state: string; code?: string }> => {
      await hooks.onDispatchIntent();
      send();
      return { state: "outcome_unknown" };
    },
  );
  const context = vm.createContext({
    Error,
    Object,
    embeddedBrowserEnabled: () => true,
    configuration: {
      snapshot: () => ({ status: "ready", settings }),
      recordSecureMcpAppPending: async () => ({ ok: true }),
      clearSecureMcpAppPendingBeforeSubmit: clearOld,
    },
    chatGptRoute: { runReadonlyTask: route },
    secureMcpConnectorRuntime: { isRunning: () => true },
    desktopGoCore: { observeComputerConnectorVerification: readGo },
    window: { isDestroyed: () => false },
    dialog: { showMessageBox: nativeConfirmation },
    buildIdentity: { buildId: fixtureBuildId },
    chatGptTaskAdmission: false,
    connectorTaskAdmission: false,
    configurationFailure: (error: string) => ({ ok: false, error }),
    chatGptTaskAdmissionReady: () => true,
    selectedConnectorApp,
    connectorWorkspaceSelection,
    separateAppVerificationScopeCurrent,
    confirmSeparateAppVerificationAttempt,
    secureMcpLaunchRoot: () => "/synthetic-scope",
    connectorAppVerificationAttemptExists: async () => false,
    prepareConnectorAppVerificationAttempt: prepare,
    waitForConnectorAppReceipt: async () => null,
  });
  const verify = vm.runInContext(
    stripTypeScriptTypes(`${functions}\nverifySecureMcpApp;`),
    context,
  ) as (scope?: typeof expected) => Promise<{ ok: false; error: string }>;
  return {
    expected,
    settings,
    nativeConfirmation,
    prepare,
    send,
    readGo,
    route,
    clearOld,
    verify,
    context,
    binding,
  };
}

describe("actual separate-check desktop admission", () => {
  it("keeps legacy Test fenced without opening a native approval", async () => {
    const f = fixture();
    expect(await f.verify()).toEqual({
      ok: false,
      error: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
    });
    expect(f.nativeConfirmation).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects IPC consent alone and defaults the native prompt to Cancel", async () => {
    const f = fixture();
    expect(await f.verify(f.expected)).toEqual({
      ok: false,
      error: "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED",
    });
    expect(f.nativeConfirmation.mock.calls[0]?.[1]).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      buttons: ["Cancel", "Test in ChatGPT"],
    });
    expect(f.route).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("rechecks the Go owner after native approval before permitting one claimed dispatch", async () => {
    const f = fixture();
    f.nativeConfirmation.mockResolvedValue({ response: 1 });
    expect(await f.verify(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
    });
    expect(f.readGo).toHaveBeenCalledTimes(2);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.clearOld).not.toHaveBeenCalled();
    expect(f.settings.setup.connect.outcomeUnknown).toBe(true);
  });
  it("does not dispatch after scope drift during native approval", async () => {
    const f = fixture();
    f.nativeConfirmation.mockImplementation(async () => {
      f.settings.connectors.secureMcp.generation++;
      return { response: 1 };
    });
    expect(await f.verify(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not dispatch into a different Go owner after approval", async () => {
    const f = fixture();
    f.nativeConfirmation.mockResolvedValue({ response: 1 });
    f.readGo
      .mockResolvedValueOnce({ binding: f.binding })
      .mockResolvedValueOnce({
        binding: { ...f.binding, backendGeneration: "changed" },
      });
    expect(await f.verify(f.expected)).toMatchObject({
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("keeps the legacy UNKNOWN after a positive pre-submit refusal of the separate route", async () => {
    const f = fixture();
    f.nativeConfirmation.mockResolvedValue({ response: 1 });
    f.route.mockResolvedValue({
      state: "failed_before_submit",
      code: "CHATGPT_COMPOSER_DRAFT_PRESENT",
    });
    expect(await f.verify(f.expected)).toMatchObject({
      error: "CHATGPT_COMPOSER_DRAFT_PRESENT",
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.clearOld).not.toHaveBeenCalled();
    expect(f.settings.setup.connect.outcomeUnknown).toBe(true);
    expect(f.settings.connectors.secureMcp.appVerificationPending).toBe(true);
  });
});
