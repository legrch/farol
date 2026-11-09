import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it, vi } from "vitest";

// Execute the actual desktop startup continuation with synthetic ports. This
// proves its dispatch boundary, not an installed app or live provider outcome.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const startup: string[] = [];
function visit(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach(visit);
    return;
  }
  const value = node as Record<string, unknown>;
  if (
    value.type === "ExpressionStatement" &&
    typeof value.start === "number" &&
    typeof value.end === "number"
  ) {
    const statement = source.slice(value.start, value.end);
    if (statement.startsWith("void resumeComputerConnector("))
      startup.push(statement.replace(/^void /u, "globalThis.result = "));
  }
  Object.values(value).forEach(visit);
}
visit(tree);
if (startup.length !== 1) throw Error("CONNECTOR_STARTUP_COMPOSITION_MISSING");

it.each(["started", "skipped", "verification-refused", "start-refused"])(
  "never sends another ChatGPT test after local startup is %s",
  async (status) => {
    const verifyApp = vi.fn(async () => ({ ok: true }));
    const watch = vi.fn();
    const current = { status: "ready", settings: {} };
    const context = vm.createContext({
      runtimeEnvironment: "production",
      buildEnvironment: "production",
      buildIdentity: { buildId: "a".repeat(64) },
      previousHostAdmissionReady: true,
      beforeConnectorResume: current,
      configuration: { snapshot: () => current },
      quitInProgress: false,
      installedUpdateAdmission: false,
      startupConnectionChecking: true,
      startupStage: vi.fn(),
      resumeComputerConnector: vi.fn(async () => status),
      window: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      channels: { configurationChanged: "fixture:configuration" },
      startConnectorTransportWatch: watch,
      // A verified returning profile must not make a startup Send eligible.
      resumedConnectorCheck: vi.fn(() => ({ appName: "Farol" })),
      verifySecureMcpApp: verifyApp,
      operationsStore: () => ({}),
      observeOperation: vi.fn(
        async (
          _store: unknown,
          _operation: unknown,
          run: () => Promise<unknown>,
        ) => run(),
      ),
      console: { warn: vi.fn() },
    });
    vm.runInContext(stripTypeScriptTypes(startup[0]!), context);
    await context.result;
    expect(watch).toHaveBeenCalledOnce();
    expect(verifyApp).not.toHaveBeenCalled();
    expect(context.startupConnectionChecking).toBe(false);
  },
);
