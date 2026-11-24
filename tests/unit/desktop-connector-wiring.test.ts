import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The connector supervisor lives in apps/desktop/connector/supervisor.ts and
// is tested there with injected ports. Nothing else checks which main-process
// state each port reads, so a swapped getter would pass every other test. This
// asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

describe("connector supervisor wiring in main", () => {
  it("lends each port its own main-process owner", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("} = connectorSupervisor({");
    expect(begin).toBeGreaterThanOrEqual(0);
    const body = source.slice(begin, source.indexOf("\n});\n", begin) + 1);
    for (const name of [
      "configuration",
      "secureMcpConnectorRuntime",
      "desktopGoCore",
      "window",
      "connectorStartInFlight",
      "summaryFenceRecovery",
      "authorityTransitions",
      "powerMonitor",
    ])
      expect(body).toContain(`\n  ${name}: () => ${name},\n`);
    for (const [name, expression] of Object.entries({
      quitInProgress: "desktopAdmission.quitInProgress",
      installedUpdateAdmission: "desktopAdmission.installedUpdateAdmission",
      connectorTaskAdmission: 'desktopAdmission.occupied("connector-task")',
      connectorTaskAdmissionPurpose:
        "desktopAdmission.connectorTaskAdmissionPurpose",
      configurationRequests: "desktopAdmission.configurationRequests",
      workspaceMutationAdmission:
        'desktopAdmission.occupied("workspace-mutation")',
      reserveConnectorTask:
        'desktopAdmission.reserveAdmitted("connector-task")',
    }))
      expect(body.replace(/\s+/g, " ")).toContain(
        `${name}: () => ${expression},`,
      );
    expect(body).toContain("\n  buildId: buildIdentity.buildId,\n");
    for (const name of [
      "codexAgentOperationActive",
      "operationsStore",
      "isolatedE2EHome",
      "computerMcpLifecycle",
      "stopAndConfirmComputerMcp",
      "reportConnectorTransport",
      "transitionRefusal",
      "configurationFailure",
    ])
      expect(body).toContain(`\n  ${name},\n`);
    // The start functions live in connector/start.ts and main builds them
    // lazily; each port forwards to the same lazily built instance.
    const flat = body.replace(/\s+/g, " ");
    expect(flat).toContain(
      "observeConnectorStart: (work) => connectorStart().observeConnectorStart(work),",
    );
    expect(flat).toContain(
      "startAdmittedSecureMcpConnector: (...args) => connectorStart().startAdmittedSecureMcpConnector(...args),",
    );
    expect(flat).toContain(
      "recordConnectorRuntime: (...args) => connectorStart().recordConnectorRuntime(...args),",
    );
  });

  it("lends the connector start each main-process owner, late for every let", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("function connectorStart() {");
    expect(begin).toBeGreaterThanOrEqual(0);
    const body = source
      .slice(begin, source.indexOf("\n}\n", begin) + 2)
      .replace(/\s+/g, " ");
    // Each `let` in main is a getter (read afresh at every use) or a setter.
    for (const name of [
      "configuration",
      "connectorCredentialStore",
      "secureMcpConnectorRuntime",
      "desktopGoCore",
      "summaryFenceRecovery",
      "connectorStartCancellation",
    ])
      expect(body).toContain(`${name}: () => ${name},`);
    expect(body).toContain(
      "setConnectorStartCancellation: (value) => { connectorStartCancellation = value; },",
    );
    expect(body).toContain(
      "setConnectorStartInFlight: (value) => { connectorStartInFlight = value; },",
    );
    // Each `const` owner is shared by reference, never copied.
    for (const name of [
      "desktopAdmission",
      "authorityTransitions",
      "buildIdentity",
      "directory",
      "installedUpdates",
      "connectorAttemptGeneration",
    ])
      expect(body).toContain(` ${name},`);
    // The stop takes no arguments here, so main's own defaults are read late.
    expect(body).toContain(
      "stopAndConfirmComputerMcp: () => stopAndConfirmComputerMcp(),",
    );
    expect(source).toContain("let connectorStartCache");
  });

  it("uses the supervisor's own state and functions, not a local copy", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("// Connector supervision reads each owner");
    const names = source
      .slice(source.indexOf("const {", begin), source.indexOf("} =", begin))
      .match(/\w+/g)
      ?.slice(1);
    expect(names).toEqual([
      "connectorAttemptGeneration",
      "captureConnectorStop",
      "ownerStoppedCurrent",
      "completedOwnerStop",
      "connectionAdmissionInProgress",
      "connectorConnection",
      "captureConnectionStatus",
      "connectionStatusCurrent",
      "currentConnectionStatus",
      "observedConnectorHealth",
      "connectorTransportWatch",
      "connectorTransportTimer",
      "connectorStatusTimer",
      "startConnectorTransportWatch",
    ]);
    for (const name of names ?? []) {
      expect(source).not.toMatch(
        new RegExp(`\\n(?:async )?function ${name}\\(`),
      );
      expect(source).not.toMatch(new RegExp(`\\n(?:let|const) ${name}\\b`));
    }
    // Quit closes the watch and both timers the supervisor holds.
    expect(source).toContain("connectorTransportWatch.current?.close()");
    expect(source).toContain("clearInterval(connectorTransportTimer.current);");
    expect(source).toContain("clearInterval(connectorStatusTimer.current);");
    expect(source).toContain("connectorConnection.close()");
  });
});
