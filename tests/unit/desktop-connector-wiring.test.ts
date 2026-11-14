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
      "quitInProgress",
      "installedUpdateAdmission",
      "connectorTaskAdmission",
      "connectorTaskAdmissionPurpose",
      "connectorStartInFlight",
      "configurationRequests",
      "summaryFenceRecovery",
      "workspaceMutationAdmission",
      "authorityTransitions",
      "powerMonitor",
    ])
      expect(body).toContain(`\n  ${name}: () => ${name},\n`);
    expect(body).toMatch(
      /\n  setConnectorTaskAdmission: \(value\) => \{\n    connectorTaskAdmission = value;\n  \},\n/,
    );
    expect(body).toContain("\n  buildId: buildIdentity.buildId,\n");
    for (const name of [
      "codexAgentOperationActive",
      "operationsStore",
      "isolatedE2EHome",
      "computerMcpLifecycle",
      "stopAndConfirmComputerMcp",
      "observeConnectorStart",
      "startAdmittedSecureMcpConnector",
      "recordConnectorRuntime",
      "reportConnectorTransport",
      "transitionRefusal",
      "configurationFailure",
    ])
      expect(body).toContain(`\n  ${name},\n`);
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
    expect(source).toContain("connectorTransportWatch.current?.close();");
    expect(source).toContain("clearInterval(connectorTransportTimer.current);");
    expect(source).toContain("clearInterval(connectorStatusTimer.current);");
    expect(source).toContain("connectorConnection.close();");
  });
});
